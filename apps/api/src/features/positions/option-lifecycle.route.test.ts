/**
 * Lifecycle routes (design C8; task 13 of option-lifecycle-events). HTTP-level
 * over the full `app`: `GET /:id/settlement-context`, `POST /:id/settle`,
 * `POST /:id/settlements/:settlementId/unsettle`, `POST /:id/roll`,
 * `PUT /:id/entry-greeks`, all mounted at `/api/positions`. No route exists at
 * base (unmounted), so every call below 404s/401s before reaching any
 * assertion — red-first for all.
 *
 * Contract block — one entry per success criterion in the task's Success
 * line. Pre-condition → call through `app.request` → observable result →
 * source of the expected value.
 *
 * A. POST /:id/settle reaches settleLeg and returns its shape (AC 2.1)
 *   Pre: an open short option leg, one entry fill, expiration long past.
 *   Call: POST /:id/settle { outcome: 'worthless' }.
 *   Result: 200; body.premium/quantity are numbers (2, 1); exitedPositionIds
 *     contains the leg id; a follow-up GET shows the leg closed with 2 fills.
 *   Source: design C3/C8; requirements AC 2.1.
 *
 * B. An outcome illegal for the leg's side is a 400 with no write (AC 2.1)
 *   Pre: an open short leg (legal outcomes worthless/assigned only).
 *   Call: POST /:id/settle { outcome: 'exercised' }.
 *   Result: 400 VALIDATION_ERROR; a follow-up GET shows the leg still open
 *     with its one original fill.
 *   Source: requirements AC 2.1 refusal clause.
 *
 * C. GET /:id/settlement-context returns its shape, null when unconfigured
 *    (AC 2.3 shape + null branch)
 *   Pre: an open short option leg, one entry fill, expiration long past, one
 *     held long stock row on the same underlying; STOCK_QUOTE_API_KEY unset.
 *   Call: GET /:id/settlement-context.
 *   Result: 200; legalOutcomes sorted = ['assigned','worthless']; premium 2;
 *     heldRows has one row naming the stock position, openUnits 50;
 *     suggestedOutcome null.
 *   Source: design C8; requirements AC 2.3 (unconfigured branch).
 *
 * D. suggestedOutcome 'assigned' — short leg, ITM, on expiration day in NY
 *    after the instant, quote configured (AC 2.3)
 *   Pre: as C, but expiration is today (NY), quote configured, "now" faked
 *     to 1h after today's expiry instant, lastPrice 10 above strike.
 *   Call: GET /:id/settlement-context.
 *   Result: suggestedOutcome 'assigned'.
 *   Source: design C8 suggestion rule; requirements AC 2.3.
 *
 * E. suggestedOutcome 'exercised' — long leg, ITM, same timing (AC 2.3)
 *   Pre: as D, but the leg is long.
 *   Call: GET /:id/settlement-context.
 *   Result: suggestedOutcome 'exercised'.
 *   Source: design C8 suggestion rule; requirements AC 2.3.
 *
 * F. suggestedOutcome 'worthless' — OTM, same timing (AC 2.3)
 *   Pre: as D, but lastPrice 50 below strike.
 *   Call: GET /:id/settlement-context.
 *   Result: suggestedOutcome 'worthless'.
 *   Source: design C8 suggestion rule; requirements AC 2.3.
 *
 * G. suggestedOutcome null before the expiry instant (AC 2.3)
 *   Pre: an open leg whose expiration is next year (real "now" precedes it);
 *     quote configured.
 *   Call: GET /:id/settlement-context.
 *   Result: suggestedOutcome null.
 *   Source: requirements AC 2.3 null clause.
 *
 * H. suggestedOutcome null on a later date (AC 2.3)
 *   Pre: an open leg with a long-past expiration (today's NY date does not
 *     equal it); quote configured.
 *   Call: GET /:id/settlement-context.
 *   Result: suggestedOutcome null.
 *   Source: requirements AC 2.3 null clause.
 *
 * I. suggestedOutcome null on a quote failure (AC 2.3)
 *   Pre: as D's timing (today, after instant, configured), but the stub
 *     quote loader has no price for this leg's underlying (throws).
 *   Call: GET /:id/settlement-context.
 *   Result: suggestedOutcome null (no 500/throw).
 *   Source: requirements AC 2.3 null clause ("a quote failure gives null").
 *
 * J. POST /:id/settlements/:settlementId/unsettle reaches unsettle (AC 4.1)
 *   Pre: a leg already settled worthless through the route (from A's
 *     pattern), carrying the resulting settlementId.
 *   Call: POST /:id/settlements/:settlementId/unsettle.
 *   Result: a 2xx response; a follow-up GET shows the leg open again,
 *     closedAt null, with exactly its one original fill.
 *   Source: design C5/C8; requirements AC 4.1.
 *
 * K. POST /:id/roll reaches rollLeg and returns its shape (AC 5.1)
 *   Pre: an open leg, one entry fill, full open quantity.
 *   Call: POST /:id/roll { newSymbol; quantity (all); closePrice; openPrice;
 *     rolledAt }.
 *   Result: 200; body has rollId/chainId/fromPositionId/toPositionId
 *     (uuids) and newSymbol; the old leg reads closed and the new leg reads
 *     open with that symbol.
 *   Source: design C6/C8; requirements AC 5.1.
 *
 * L. PUT /:id/entry-greeks reaches captureEntryGreeks and returns its shape
 *    (AC 6.1)
 *   Pre: an open leg, one entry fill, expiration next year.
 *   Call: PUT /:id/entry-greeks { source:'black_scholes', volatility, spot,
 *     rate }.
 *   Result: 200; body.source 'black_scholes'; delta/gamma/thetaPerDay/
 *     vegaPerPct/rhoPerPct are numbers; volatility 0.3.
 *   Source: design C7/C8; requirements AC 6.1.
 *
 * M–P. A foreign leg id reads 404 on GET context, POST settle, POST roll and
 *    PUT entry-greeks (NFR Security)
 *   Pre: user A's open leg.
 *   Call: user B's session calls each route against user A's leg id.
 *   Result: 404 NOT_FOUND on each.
 *   Source: requirements NFR Security.
 *
 * Q. A foreign settlementId/legId pair reads 404 on unsettle (NFR Security)
 *   Pre: user A settles a leg through the route, capturing settlementId.
 *   Call: user B's session POSTs .../settlements/:settlementId/unsettle
 *     against user A's legId.
 *   Result: 404 NOT_FOUND.
 *   Source: requirements NFR Security.
 *
 * R. The 31st settlement-context read in a window is a 429
 *   Pre: one user, one open leg.
 *   Call: GET /:id/settlement-context 31 times in immediate succession.
 *   Result: the first 30 are 200; the 31st is 429 RATE_LIMITED.
 *   Source: design C8 ("its own limiter of 30 per 60 s per user").
 *
 * Folded / out of scope (recorded, not separately retested here):
 *   - AC 11.5 (regenerate tradr-api.json) and AC 11.7's go-live.md doc note
 *     are implementer-side checklist items, not HTTP-observable behaviour.
 *     position_settled/unsettled/rolled's enum-only payload is already
 *     red-tested at the service layer in tasks 7/9/10.
 *   - "the roll route passes isAdmin as gate" (task's own Restriction, not a
 *     Success-line item) is exercised incidentally by K's plain session
 *     (tier gating defaults off; gate wiring itself is a design Restriction,
 *     not a listed success criterion).
 *
 * RED-IMPOSSIBLE, kept as a regression guard, not counted above:
 *   - "an anonymous call is 401" (NFR Security). `transferLinksRouter` and
 *     `positionImagesRouter` already apply `authMiddleware` unconditionally
 *     to every path under `/api/positions`, including one no router yet
 *     answers, so this already 401s at base — same precedent as
 *     `transfer-links.route.test.ts:638` and `lots.route.test.ts:289`. It
 *     stays in this file as a guard that the figure is still 401, not 404,
 *     once this router is mounted beside them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expiryInstant } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { sessions } from '@/db/schema/users.schema';
import { initStockQuoteCache } from '@/features/symbols/stock-quote.client';
import { config } from '@/lib/config';

// --- Unique identifiers -----------------------------------------------------

let emailCounter = 0;
function uniqueEmail() {
  return `option-lifecycle-route${++emailCounter}-${Date.now()}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  const n = ++ipCounter;
  return `10.8.${(n >> 8) & 255}.${n & 255 || 1}`;
}

let tickerSeq = 0;
/** A fresh 1-6 char, [A-Z] underlying per call, never colliding in the
 * global stock-quote cache or across OCC-parse calls within this file. */
function uniqueTicker(): string {
  tickerSeq++;
  let n = tickerSeq;
  let letters = '';
  for (let i = 0; i < 4; i++) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return `Z${letters}`;
}

function occCompact(ticker: string, occDateField: string, type: 'C' | 'P', strike: number) {
  return `${ticker}${occDateField}${type}${strike}`;
}

// Long-past expiration (2020-01-17), for "already far past expiry" fixtures.
const PAST_DATE_FIELD = '200117';
const PAST_EXPIRATION = '2020-01-17';
// Far-future expiration (next calendar year's July), for "before the
// instant" fixtures that must stay ahead of the real wall clock for a while.
const FUTURE_DATE_FIELD = '270717';

function nyDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Today's date (NY) as an OCC YYMMDD field, plus its expiration string and
 * expiry instant — computed from the real clock so the "today" scenarios
 * (D/E/F/I) never go stale. */
function todayExpiryFixture() {
  const expiration = nyDateString(new Date());
  const [yyyy, mm, dd] = expiration.split('-');
  const occDateField = `${yyyy.slice(2)}${mm}${dd}`;
  const instant = expiryInstant(expiration);
  return { expiration, occDateField, instant };
}

// --- HTTP helpers (lots.route.test.ts / positions.test.ts precedent) -------

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

// expenses.test.ts precedent ("boundary-year transition + invariants"):
// auth.middleware.ts enforces its 30-minute idle / 24-hour absolute timeout
// via JS `Date.now()`, but `sessions.createdAt`/`lastAccessed` are set by
// Postgres's own `defaultNow()` — the REAL wall clock, never affected by
// `vi.setSystemTime`. Faking "now" hours ahead of the real session timestamp
// 401s the very next request unless the session is forward-dated to match.
async function extendSession(forwardedNow: Date) {
  await db.update(sessions).set({
    createdAt: forwardedNow,
    lastAccessed: forwardedNow,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
}

async function registerAndGetCookie(): Promise<{ cookie: string }> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  expect(cookie).toBeDefined();
  return { cookie };
}

function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = {
    Cookie: `session=${cookie}`,
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createTestAccount(cookie: string) {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Lifecycle Route Test Account ${Date.now()}-${uniqueIp()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestPosition(
  cookie: string,
  accountId: string,
  overrides: Record<string, unknown>,
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function addFill(
  cookie: string,
  positionId: string,
  data: { type: string; price: string; quantity: string; filledAt: string },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

async function openTestPosition(cookie: string, positionId: string, openedAt: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {
    openedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function getDetail(cookie: string, positionId: string) {
  const res = await authedRequest('GET', `/api/positions/${positionId}`, cookie);
  expect(res.status).toBe(200);
  return res.json();
}

async function createOpenOptionLeg(
  cookie: string,
  accountId: string,
  params: { symbol: string; side: 'long' | 'short'; entryPrice: string; entryQty: string },
) {
  const pos = await createTestPosition(cookie, accountId, {
    symbol: params.symbol,
    side: params.side,
    assetType: 'option',
  });
  const entryFill = await addFill(cookie, pos.id, {
    type: 'entry',
    price: params.entryPrice,
    quantity: params.entryQty,
    filledAt: '2025-01-01T00:00:00Z',
  });
  await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
  return { legId: pos.id as string, entryFillId: entryFill.id as string };
}

// --- Stub quote loader (symbols.test.ts precedent: inject, never call a
// live provider) -------------------------------------------------------------

const quoteBook = new Map<string, string>();

beforeAll(() => {
  initStockQuoteCache(async (symbol: string) => {
    const lastPrice = quoteBook.get(symbol);
    if (lastPrice === undefined) {
      throw new Error(`no stub quote configured for ${symbol}`);
    }
    return { symbol, lastPrice, change: null, delayed: true };
  });
});

beforeEach(() => {
  config.STOCK_QUOTE_API_KEY = '';
});

afterEach(() => {
  config.STOCK_QUOTE_API_KEY = '';
  vi.useRealTimers();
});

describe('POST /api/positions/:id/settle (design C3/C8, task 13)', () => {
  it('reaches settleLeg and returns its shape (AC 2.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(uniqueTicker(), PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    const res = await authedRequest('POST', `/api/positions/${legId}/settle`, cookie, {
      outcome: 'worthless',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.legId).toBe(legId);
    expect(body.outcome).toBe('worthless');
    expect(body.premium).toBe(2);
    expect(body.quantity).toBe(1);
    expect(body.exitedPositionIds).toContain(legId);

    const detail = await getDetail(cookie, legId);
    expect(detail.status).toBe('closed');
    expect(detail.fills).toHaveLength(2);
  });

  it("a 400 refuses an outcome illegal for the leg's side, with no write (AC 2.1)", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(uniqueTicker(), PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    const res = await authedRequest('POST', `/api/positions/${legId}/settle`, cookie, {
      outcome: 'exercised',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const detail = await getDetail(cookie, legId);
    expect(detail.status).toBe('open');
    expect(detail.fills).toHaveLength(1);
  });
});

describe('GET /api/positions/:id/settlement-context (design C8, task 13)', () => {
  it('returns legalOutcomes, expiryInstant, premium, heldRows and a null suggestedOutcome when unconfigured (AC 2.3)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });
    const stock = await createTestPosition(cookie, account.id, {
      symbol: ticker,
      side: 'long',
      assetType: 'stock',
    });
    await addFill(cookie, stock.id, {
      type: 'entry',
      price: '10.00',
      quantity: '50',
      filledAt: '2024-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, stock.id, '2024-01-01T00:00:00Z');

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect([...body.legalOutcomes].sort()).toEqual(['assigned', 'worthless']);
    expect(body.expiryInstant).toBe(expiryInstant(PAST_EXPIRATION).toISOString());
    expect(body.premium).toBe(2);
    expect(body.heldRows).toHaveLength(1);
    expect(body.heldRows[0].positionId).toBe(stock.id);
    expect(body.heldRows[0].openUnits).toBe(50);
    expect(body.suggestedOutcome).toBeNull();
  });

  it("suggests 'assigned' for a short leg $0.01+ in the money, on expiration day in NY after the instant, quote configured (AC 2.3)", async () => {
    // Setup under REAL time, so the HTTP-driven inserts (and the session's
    // own createdAt/lastAccessed) behave normally; only the final read runs
    // under a faked clock (expenses.test.ts "boundary-year transition"
    // precedent).
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { occDateField, instant } = todayExpiryFixture();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, occDateField, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    quoteBook.set(ticker, '160.00');
    const fakeNow = new Date(instant.getTime() + 60 * 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fakeNow);
    await extendSession(fakeNow);

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedOutcome).toBe('assigned');
  });

  it("suggests 'exercised' for a long leg $0.01+ in the money, same timing (AC 2.3)", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { occDateField, instant } = todayExpiryFixture();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, occDateField, 'C', 150),
      side: 'long',
      entryPrice: '2.00',
      entryQty: '1',
    });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    quoteBook.set(ticker, '160.00');
    const fakeNow = new Date(instant.getTime() + 60 * 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fakeNow);
    await extendSession(fakeNow);

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedOutcome).toBe('exercised');
  });

  it("suggests 'worthless' when out of the money, same timing (AC 2.3)", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { occDateField, instant } = todayExpiryFixture();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, occDateField, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    quoteBook.set(ticker, '100.00');
    const fakeNow = new Date(instant.getTime() + 60 * 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fakeNow);
    await extendSession(fakeNow);

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedOutcome).toBe('worthless');
  });

  it('suggestedOutcome is null before the expiry instant, even when quote-configured (AC 2.3)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, FUTURE_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    quoteBook.set(ticker, '160.00');

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedOutcome).toBeNull();
  });

  it("suggestedOutcome is null on a later date — today's NY date is not the expiration, even past the instant (AC 2.3)", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    quoteBook.set(ticker, '160.00');

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedOutcome).toBeNull();
  });

  it('suggestedOutcome is null on a quote failure, on expiration day after the instant, configured (AC 2.3)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker(); // deliberately never added to quoteBook
    const { occDateField, instant } = todayExpiryFixture();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, occDateField, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    config.STOCK_QUOTE_API_KEY = 'test-key';
    const fakeNow = new Date(instant.getTime() + 60 * 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fakeNow);
    await extendSession(fakeNow);

    const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestedOutcome).toBeNull();
  });

  it('enforces its own per-user limit — 429 on the 31st read within the window', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(uniqueTicker(), PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    for (let i = 0; i < 30; i++) {
      const res = await authedRequest('GET', `/api/positions/${legId}/settlement-context`, cookie);
      expect(res.status).toBe(200);
    }
    const blocked = await authedRequest(
      'GET',
      `/api/positions/${legId}/settlement-context`,
      cookie,
    );
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  // Regression guard, not a red case: `/api/positions/*` already 401s with no
  // session via the shared `authMiddleware` applied by every sibling router
  // mounted at that base (transferLinksRouter, positionImagesRouter) — true
  // before this route exists and must stay true once it is mounted beside
  // them (transfer-links.route.test.ts:638, lots.route.test.ts:289 precedent).
  it('401s with no session cookie, the same as every sibling router mounted at /api/positions (NFR Security)', async () => {
    const res = await app.request(`/api/positions/${crypto.randomUUID()}/settlement-context`, {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/positions/:id/settlements/:settlementId/unsettle (design C5/C8, task 13)', () => {
  it('reaches unsettle: the leg reopens with exactly its original fill (AC 4.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(uniqueTicker(), PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    const settleRes = await authedRequest('POST', `/api/positions/${legId}/settle`, cookie, {
      outcome: 'worthless',
    });
    expect(settleRes.status).toBe(200);
    const { settlementId } = await settleRes.json();

    const unsettleRes = await authedRequest(
      'POST',
      `/api/positions/${legId}/settlements/${settlementId}/unsettle`,
      cookie,
    );
    expect(unsettleRes.status).toBeGreaterThanOrEqual(200);
    expect(unsettleRes.status).toBeLessThan(300);

    const detail = await getDetail(cookie, legId);
    expect(detail.status).toBe('open');
    expect(detail.closedAt).toBeNull();
    expect(detail.fills).toHaveLength(1);
  });
});

describe('POST /api/positions/:id/roll (design C6/C8, task 13)', () => {
  it('reaches rollLeg and returns its shape (AC 5.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const ticker = uniqueTicker();
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(ticker, FUTURE_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '1.00',
      entryQty: '2',
    });
    const newSymbol = occCompact(ticker, FUTURE_DATE_FIELD, 'C', 160);

    const res = await authedRequest('POST', `/api/positions/${legId}/roll`, cookie, {
      newSymbol,
      quantity: '2',
      closePrice: '1.00',
      openPrice: '1.50',
      rolledAt: '2025-06-01T00:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.rollId).toBe('string');
    expect(typeof body.chainId).toBe('string');
    expect(body.fromPositionId).toBe(legId);
    expect(typeof body.toPositionId).toBe('string');
    expect(body.newSymbol).toBe(newSymbol);

    const oldDetail = await getDetail(cookie, legId);
    expect(oldDetail.status).toBe('closed');
    const newDetail = await getDetail(cookie, body.toPositionId);
    expect(newDetail.status).toBe('open');
    expect(newDetail.symbol).toBe(newSymbol);
  });
});

describe('PUT /api/positions/:id/entry-greeks (design C7/C8, task 13)', () => {
  it('reaches captureEntryGreeks and returns its shape (AC 6.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const { legId } = await createOpenOptionLeg(cookie, account.id, {
      symbol: occCompact(uniqueTicker(), FUTURE_DATE_FIELD, 'C', 150),
      side: 'long',
      entryPrice: '2.00',
      entryQty: '1',
    });

    const res = await authedRequest('PUT', `/api/positions/${legId}/entry-greeks`, cookie, {
      source: 'black_scholes',
      volatility: 0.3,
      spot: 150,
      rate: 0.04,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('black_scholes');
    expect(typeof body.delta).toBe('number');
    expect(typeof body.gamma).toBe('number');
    expect(typeof body.thetaPerDay).toBe('number');
    expect(typeof body.vegaPerPct).toBe('number');
    expect(typeof body.rhoPerPct).toBe('number');
    expect(body.volatility).toBe(0.3);
  });
});

describe('Cross-user scoping — a foreign leg id reads 404 on every write/read route (NFR Security, task 13)', () => {
  it.each([
    [
      'GET settlement-context',
      'GET',
      (id: string) => `/api/positions/${id}/settlement-context`,
      undefined,
    ],
    [
      'POST settle',
      'POST',
      (id: string) => `/api/positions/${id}/settle`,
      { outcome: 'worthless' },
    ],
    [
      'POST roll',
      'POST',
      (id: string) => `/api/positions/${id}/roll`,
      {
        newSymbol: 'PLACEHOLDER',
        quantity: '1',
        closePrice: '1.00',
        openPrice: '1.50',
        rolledAt: '2025-06-01T00:00:00Z',
      },
    ],
    [
      'PUT entry-greeks',
      'PUT',
      (id: string) => `/api/positions/${id}/entry-greeks`,
      { source: 'black_scholes', volatility: 0.3, spot: 150, rate: 0.04 },
    ],
  ] as const)('%s 404s for another user’s leg', async (_label, method, buildPath, body) => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const accountA = await createTestAccount(cookieA);
    const { legId } = await createOpenOptionLeg(cookieA, accountA.id, {
      symbol: occCompact(uniqueTicker(), PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });

    const { cookie: cookieB } = await registerAndGetCookie();

    const res = await authedRequest(method, buildPath(legId), cookieB, body);
    expect(res.status).toBe(404);
    const resBody = await res.json();
    expect(resBody.error.code).toBe('NOT_FOUND');
  });

  it("POST unsettle 404s for another user's leg/settlement pair", async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const accountA = await createTestAccount(cookieA);
    const { legId } = await createOpenOptionLeg(cookieA, accountA.id, {
      symbol: occCompact(uniqueTicker(), PAST_DATE_FIELD, 'C', 150),
      side: 'short',
      entryPrice: '2.00',
      entryQty: '1',
    });
    const settleRes = await authedRequest('POST', `/api/positions/${legId}/settle`, cookieA, {
      outcome: 'worthless',
    });
    expect(settleRes.status).toBe(200);
    const { settlementId } = await settleRes.json();

    const { cookie: cookieB } = await registerAndGetCookie();

    const res = await authedRequest(
      'POST',
      `/api/positions/${legId}/settlements/${settlementId}/unsettle`,
      cookieB,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
