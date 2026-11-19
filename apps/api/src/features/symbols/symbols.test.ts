// Symbols HTTP-surface integration tests (design v4 §Testing → Integration,
// REQ-3.2/3.5/3.6, REQ-4.2/4.6/4.7, REQ-2.6, REQ-2.4(d)).
//
// A LOCAL FULL-STACK harness — NOT the `vi.mock('@/db')` stub-auth harness,
// which would ship the auth/admin/rate-limit assertions false-green. It
// reproduces what `app.ts` supplies for these two routers:
//
//   new Hono()
//     .use(loggingMiddleware)              // error envelopes carry requestId
//     .route('/api/auth', authRouter)      // real /register → session cookie
//     .route('/api/symbols', symbolsRouter)
//   app.onError(errorHandler)              // LOAD-BEARING (see below)
//
// `app.onError(errorHandler)` is load-bearing: the AppError subclasses are
// plain Errors (not Hono HTTPExceptions), so without the handler every coded
// status (401/403/400/429/404/503/502) would render as a generic 500 and every
// assertion would fail. Runs against REAL Postgres with transaction-rollback
// isolation (src/test-setup.ts). Population stays a no-op under NODE_ENV=test;
// quote outcomes are driven by an injected loader (initStockQuoteCache), never
// a live provider call.
//
//   - non-admin session: minted via /api/auth/register (isAdmin=false).
//   - admin session: minted by a DIRECT users insert (isAdmin:true) + seeded
//     session — /register ALWAYS yields isAdmin=false, so it cannot mint one.
//   - unique X-Forwarded-For per request: the /register limiter's process-local
//     MapStore does NOT roll back, so >5 registrations from one IP would trip a
//     spurious 429 (TRUSTED_PROXIES=127.0.0.1 in the test env honors the header).
//
// _Requirements: REQ-3.2, REQ-3.5, REQ-3.6, REQ-4.2, REQ-4.6, REQ-4.7, REQ-2.6.

import { createHash, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StockQuoteBatchResponseSchema, SymbolSearchResponseSchema } from '@tradr/shared';

import { db } from '@/db';
import { sessions, symbols, users } from '@/db/schema';
import authRouter from '@/features/auth/auth.route';
import { config } from '@/lib/config';
import { AppError, NotFoundError } from '@/lib/errors';
import { errorHandler } from '@/middleware/error.middleware';
import { loggingMiddleware } from '@/middleware/logging.middleware';

import { initStockQuoteCache, type StockQuoteData } from './stock-quote.client';
import symbolsRouter from './symbols.route';

// --- Local full-stack harness (mirrors app.ts for these two routers) --------

const app = new Hono()
  .use(loggingMiddleware)
  .route('/api/auth', authRouter)
  .route('/api/symbols', symbolsRouter);
app.onError(errorHandler);

// --- Fixtures / request helpers ---------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const runId = Date.now();
function uniqueEmail(): string {
  return `symbols-it-${runId}-${++seq}@example.com`;
}

// A UNIQUE, non-trusted IPv4 per request so the IP-keyed /register limiter
// (max 5, MapStore, does NOT roll back) never trips a spurious 429.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter++;
  const third = Math.floor(ipCounter / 250);
  const fourth = 1 + (ipCounter % 250);
  return `10.60.${third}.${fourth}`;
}

function getSessionCookie(res: Response): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(/session=([^;]*)/);
    if (match) return match[1];
  }
  return undefined;
}

async function req(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'X-Forwarded-For': uniqueIp() };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string; requestId?: string } };
  expect(body).toHaveProperty('error.code');
  // loggingMiddleware wired in ⇒ the envelope carries a requestId.
  expect(body.error).toHaveProperty('requestId');
  return body.error!.code!;
}

/** Mint a NON-admin session via the real register route (isAdmin=false). */
async function registerSession(): Promise<{ cookie: string; userId: string }> {
  const res = await req('POST', '/api/auth/register', {
    body: { email: uniqueEmail(), password: 'password123' },
  });
  expect(res.status).toBe(201);
  const cookie = getSessionCookie(res)!;
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

/**
 * Mint an ADMIN session by a DIRECT users insert (isAdmin:true) + a seeded
 * session row — /register cannot produce an admin. Returns the plaintext
 * session token to send as the `session=` cookie.
 */
async function seedAdminSession(): Promise<{ id: string; cookie: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'bcrypt-sentinel', isAdmin: true })
    .returning({ id: users.id });
  const token = randomUUID();
  const now = new Date();
  await db.insert(sessions).values({
    userId: user!.id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    createdAt: now,
    lastAccessed: now,
    expiresAt: new Date(now.getTime() + DAY),
  });
  return { id: user!.id, cookie: token };
}

/** Seed a deterministic ranking fixture in the rolled-back tx. */
async function seedSymbols(): Promise<void> {
  // Clear any committed leftovers first (inside the tx, rolled back at test end)
  // so ranking assertions are deterministic.
  await db.delete(symbols);
  await db.insert(symbols).values([
    { ticker: 'AA', name: 'Alcoa', exchange: 'NYSE', cik: 1 },
    { ticker: 'AAL', name: 'American Airlines', exchange: 'NASDAQ', cik: 2 },
    { ticker: 'AAP', name: 'Advance Auto Parts', exchange: 'NYSE', cik: 3 },
    { ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ', cik: 4 },
  ]);
}

// Injected quote loader — deterministic outcomes keyed on the symbol so the
// coded provider-error branches are exercised without a live provider call.
const stubLoader = (symbol: string): Promise<StockQuoteData> => {
  switch (symbol) {
    case 'NOPE':
      return Promise.reject(new NotFoundError('symbol', symbol));
    case 'DOWN':
      return Promise.reject(
        new AppError(
          503,
          'QUOTE_PROVIDER_UNAVAILABLE',
          'Quote provider is temporarily unavailable.',
        ),
      );
    case 'BADKEY':
      return Promise.reject(
        new AppError(502, 'QUOTE_PROVIDER_MISCONFIGURED', 'Quote provider is misconfigured.'),
      );
    default:
      return Promise.resolve({ symbol, lastPrice: '123.45', change: null, delayed: true });
  }
};

// ---------------------------------------------------------------------------
// GET /api/symbols/search
// ---------------------------------------------------------------------------

describe('GET /api/symbols/search', () => {
  it('401 UNAUTHORIZED without a session cookie', async () => {
    const res = await req('GET', '/api/symbols/search?q=AAP');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHORIZED');
  });

  it('ranks exact-match first, then ascending length, then alphabetical', async () => {
    const { cookie } = await registerSession();
    await seedSymbols();

    const wide = await req('GET', '/api/symbols/search?q=AA', { cookie });
    expect(wide.status).toBe(200);
    const wideBody = SymbolSearchResponseSchema.parse(await wide.json());
    expect(wideBody.results.map((r) => r.ticker)).toEqual(['AA', 'AAL', 'AAP', 'AAPL']);

    const narrow = await req('GET', '/api/symbols/search?q=AAP', { cookie });
    expect(narrow.status).toBe(200);
    const narrowBody = SymbolSearchResponseSchema.parse(await narrow.json());
    expect(narrowBody.results.map((r) => r.ticker)).toEqual(['AAP', 'AAPL']);
  });

  it('short-circuits an empty/whitespace query to { results: [] } @200 (never LIKE %)', async () => {
    const { cookie } = await registerSession();
    await seedSymbols(); // rows present, but an empty q must NOT return them

    for (const path of [
      '/api/symbols/search',
      '/api/symbols/search?q=',
      '/api/symbols/search?q=%20%20',
    ]) {
      const res = await req('GET', path, { cookie });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    }
  });

  it('400 VALIDATION_ERROR on out-of-charset or oversized q', async () => {
    const { cookie } = await registerSession();

    const bad = await req('GET', `/api/symbols/search?q=${encodeURIComponent('@@@')}`, { cookie });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('VALIDATION_ERROR');

    const oversized = await req('GET', `/api/symbols/search?q=${'A'.repeat(17)}`, { cookie });
    expect(oversized.status).toBe(400);
    expect(await errorCode(oversized)).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// GET /api/symbols/:symbol/quote
// ---------------------------------------------------------------------------

describe('GET /api/symbols/:symbol/quote', () => {
  const originalKey = config.STOCK_QUOTE_API_KEY;

  beforeEach(() => {
    initStockQuoteCache(stubLoader);
  });
  afterEach(() => {
    config.STOCK_QUOTE_API_KEY = originalKey;
  });

  it('401 UNAUTHORIZED without a session cookie', async () => {
    const res = await req('GET', '/api/symbols/AAPL/quote');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHORIZED');
  });

  it('returns { configured: false } @200 when the provider key is unset', async () => {
    config.STOCK_QUOTE_API_KEY = undefined;
    const { cookie } = await registerSession();
    const res = await req('GET', '/api/symbols/AAPL/quote', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  it('returns { configured: true, ...quote } @200 when configured', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();
    const res = await req('GET', '/api/symbols/AAPL/quote', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      symbol: 'AAPL',
      lastPrice: '123.45',
      change: null,
      delayed: true,
    });
  });

  it.each([
    ['NOPE', 404, 'NOT_FOUND'],
    ['DOWN', 503, 'QUOTE_PROVIDER_UNAVAILABLE'],
    ['BADKEY', 502, 'QUOTE_PROVIDER_MISCONFIGURED'],
  ] as const)(
    'maps a provider failure for %s to coded HTTP %i (never 500)',
    async (symbol, status, code) => {
      config.STOCK_QUOTE_API_KEY = 'test-key';
      const { cookie } = await registerSession();
      const res = await req('GET', `/api/symbols/${symbol}/quote`, { cookie });
      expect(res.status).toBe(status);
      expect(await errorCode(res)).toBe(code);
    },
  );

  it('enforces the per-user quote rate limit — 429 after 30 in the window', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    for (let i = 0; i < 30; i++) {
      const res = await req('GET', '/api/symbols/AAA/quote', { cookie });
      expect(res.status).toBe(200);
    }
    const blocked = await req('GET', '/api/symbols/AAA/quote', { cookie });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// GET /api/symbols/quotes (batch) — task 4, design C3, Req 1.5/1.6/2.1-2.4/2.6/2.9/2.10/2.11
// ---------------------------------------------------------------------------

/** N distinct valid-charset symbols ([A-Z.-]{1,16}), never colliding with a stubLoader special case. */
function makeDistinctSymbols(n: number): string[] {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const a = letters[Math.floor(i / letters.length) % letters.length];
    const b = letters[i % letters.length];
    out.push(`Z${a}${b}`);
  }
  return out;
}

describe('GET /api/symbols/quotes', () => {
  const originalKey = config.STOCK_QUOTE_API_KEY;

  beforeEach(() => {
    initStockQuoteCache(stubLoader);
  });
  afterEach(() => {
    config.STOCK_QUOTE_API_KEY = originalKey;
  });

  // Contract: pre — key unset, authenticated session. Call — GET .../quotes?symbols=AAPL.
  // Observable — 200 { configured: false }, loader call count stays 0. Source — Req 1.5.
  it('returns { configured: false } @200 and never calls the loader when the key is unset (Req 1.5)', async () => {
    let calls = 0;
    initStockQuoteCache((symbol) => {
      calls++;
      return stubLoader(symbol);
    });
    config.STOCK_QUOTE_API_KEY = undefined;
    const { cookie } = await registerSession();

    const res = await req('GET', '/api/symbols/quotes?symbols=AAPL', { cookie });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
    expect(calls).toBe(0);
  });

  // Contract: pre — key set, authenticated session. Call — GET .../quotes?symbols=aapl,AAPL.
  // Observable — 200 with exactly one AAPL outcome. Source — Req 2.2.
  it('de-duplicates case-insensitively — "aapl,AAPL" returns one AAPL outcome (Req 2.2)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    const res = await req('GET', '/api/symbols/quotes?symbols=aapl,AAPL', { cookie });

    expect(res.status).toBe(200);
    const body = StockQuoteBatchResponseSchema.parse(await res.json());
    expect(body).toEqual({
      configured: true,
      quotes: [
        { symbol: 'AAPL', status: 'ok', lastPrice: '123.45', fetchedAt: expect.any(String) },
      ],
    });
  });

  // Contract: pre — key set, authenticated session. Call — GET .../quotes (no symbols param).
  // Observable — 400 VALIDATION_ERROR. Source — Req 2.3 (handler post-condition 1).
  it('400 VALIDATION_ERROR on a missing/empty symbols list (Req 2.3)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    const res = await req('GET', '/api/symbols/quotes', { cookie });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_ERROR');
  });

  // Contract: pre — key set, authenticated session. Call — GET .../quotes?symbols=AAPL,@@@.
  // Observable — 400 VALIDATION_ERROR. Source — Req 2.4.
  it('400 VALIDATION_ERROR when one symbol fails QuoteSymbolParamSchema (Req 2.4)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    const res = await req('GET', `/api/symbols/quotes?symbols=AAPL,${encodeURIComponent('@@@')}`, {
      cookie,
    });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_ERROR');
  });

  // Contract: pre — key set, authenticated session. Call — GET .../quotes with 50 distinct symbols.
  // Observable — 200 with 50 outcomes. Source — Req 2.3 ("at least 50 distinct symbols"), pins
  // QUOTE_BATCH_MAX = 50's lower boundary.
  it('accepts exactly QUOTE_BATCH_MAX (50) distinct symbols @200 (Req 2.3)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();
    const symbols = makeDistinctSymbols(50);

    const res = await req('GET', `/api/symbols/quotes?symbols=${symbols.join(',')}`, { cookie });

    expect(res.status).toBe(200);
    const body = StockQuoteBatchResponseSchema.parse(await res.json());
    if (!body.configured) throw new Error('expected configured:true');
    expect(body.quotes).toHaveLength(50);
  });

  // Contract: pre — key set, authenticated session. Call — GET .../quotes with 51 distinct symbols.
  // Observable — 400 VALIDATION_ERROR. Source — Req 2.3, pins QUOTE_BATCH_MAX = 50's exact value:
  // a silent raise or lower of the constant fails this boundary pair with the 50-symbol case above.
  it('400 VALIDATION_ERROR for 51 distinct symbols — one more than QUOTE_BATCH_MAX (Req 2.3)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();
    const symbols = makeDistinctSymbols(51);

    const res = await req('GET', `/api/symbols/quotes?symbols=${symbols.join(',')}`, { cookie });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_ERROR');
  });

  // Contract: pre — key set, authenticated session, stubLoader special-cases NOPE/DOWN/BADKEY.
  // Call — GET .../quotes?symbols=AAPL,NOPE,DOWN,BADKEY. Observable — 200 with ok, unknown,
  // unavailable, unavailable in request order. Source — Req 2.5, 2.6.
  it('maps ok/unknown/unavailable/unavailable for AAPL, NOPE, DOWN, BADKEY in one request @200 (Req 2.5, 2.6)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    const res = await req('GET', '/api/symbols/quotes?symbols=AAPL,NOPE,DOWN,BADKEY', { cookie });

    expect(res.status).toBe(200);
    const body = StockQuoteBatchResponseSchema.parse(await res.json());
    if (!body.configured) throw new Error('expected configured:true');
    expect(body.quotes.map((q) => [q.symbol, q.status])).toEqual([
      ['AAPL', 'ok'],
      ['NOPE', 'unknown'],
      ['DOWN', 'unavailable'],
      ['BADKEY', 'unavailable'],
    ]);
  });

  // Contract: pre — key set, authenticated session. Call — 30 GET .../quotes in the window, then
  // one more. Observable — the 31st answers 429 RATE_LIMITED. Source — Req 2.9 (one batch request
  // counts as one hit against the existing 30-per-60s stock-quote limiter).
  it('enforces the per-user quote rate limit — 429 after 30 batch requests in the window (Req 2.9)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    for (let i = 0; i < 30; i++) {
      const res = await req('GET', '/api/symbols/quotes?symbols=AAA', { cookie });
      expect(res.status).toBe(200);
    }
    const blocked = await req('GET', '/api/symbols/quotes?symbols=AAA', { cookie });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('RATE_LIMITED');
  });

  // Contract: pre — key set, authenticated session. Call — 1 batch request + 29 single-symbol
  // requests (30 total), then one more of either shape. Observable — the 31st answers 429.
  // Source — Req 2.9, design D1 (the batch route shares the single-symbol route's limiter instance).
  it('shares its rate-limit budget with the single-symbol route — one batch + 29 single hits trips 429 on the 31st (Req 2.9, design D1)', async () => {
    config.STOCK_QUOTE_API_KEY = 'test-key';
    const { cookie } = await registerSession();

    const batch = await req('GET', '/api/symbols/quotes?symbols=AAA', { cookie });
    expect(batch.status).toBe(200);

    for (let i = 0; i < 29; i++) {
      const res = await req('GET', '/api/symbols/AAA/quote', { cookie });
      expect(res.status).toBe(200);
    }

    const blocked = await req('GET', '/api/symbols/quotes?symbols=AAA', { cookie });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// GET /api/symbols/quote-config
// ---------------------------------------------------------------------------

describe('GET /api/symbols/quote-config', () => {
  const originalKey = config.STOCK_QUOTE_API_KEY;
  afterEach(() => {
    config.STOCK_QUOTE_API_KEY = originalKey;
  });

  it('reports the boolean provider-config state (both directions)', async () => {
    const { cookie } = await registerSession();

    config.STOCK_QUOTE_API_KEY = undefined;
    const off = await req('GET', '/api/symbols/quote-config', { cookie });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ stockQuoteConfigured: false });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    const on = await req('GET', '/api/symbols/quote-config', { cookie });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ stockQuoteConfigured: true });
  });
});

// ---------------------------------------------------------------------------
// POST /api/symbols/refresh (admin-only)
// ---------------------------------------------------------------------------

describe('POST /api/symbols/refresh', () => {
  it('401 UNAUTHORIZED without a session cookie', async () => {
    const res = await req('POST', '/api/symbols/refresh');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHORIZED');
  });

  it('403 ADMIN_REQUIRED for a non-admin session', async () => {
    const { cookie } = await registerSession();
    const res = await req('POST', '/api/symbols/refresh', { cookie });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('ADMIN_REQUIRED');
  });

  it('200 skipped-test-env for an admin session (population is a no-op under NODE_ENV=test)', async () => {
    const admin = await seedAdminSession();
    const res = await req('POST', '/api/symbols/refresh', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'skipped-test-env' });
  });
});
