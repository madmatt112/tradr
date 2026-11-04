import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BreakdownResponseSchema,
  PerformanceQuerySchema,
  type PerformanceQueryInput,
} from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { positions, subscriptions } from '@/db/schema';
import { seedPositions } from '@/db/seed';
import { config } from '@/lib/config';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { errorHandler } from '@/middleware/error.middleware';
import { loggingMiddleware } from '@/middleware/logging.middleware';

import performanceRouter from './performance.route';
import { getPerformance } from './performance.service';
import { performanceTimeoutMiddleware } from './performance.timeout';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `perf-route-${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 300;
function uniqueIp() {
  return `10.3.0.${++ipCounter}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  expect(cookie).toBeDefined();
  return cookie;
}

async function getCurrentUserId(cookie: string): Promise<string> {
  const res = await app.request('/api/auth/me', {
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function createAccount(cookie: string, currency = 'USD', name = 'Acc') {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `session=${cookie}`,
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ name, currency }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; userId: string };
}

function buildPerfQuery(overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    granularity: 'day',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-31T00:00:00.000Z',
    tz: 'UTC',
    ...overrides,
  };
  return new URLSearchParams(params).toString();
}

function getRequest(path: string, cookie?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'X-Forwarded-For': uniqueIp() };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return app.request(path, {
    ...init,
    method: 'GET',
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

function parseJsonLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  // postgres.js may also write raw objects via `console.log(parseError(x))`; only
  // collect calls whose first arg parses as JSON. Strings produced by lib/logger
  // are always JSON.stringify(entry).
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== 'string') continue;
    try {
      const parsed = JSON.parse(arg) as unknown;
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      /* not a JSON log line */
    }
  }
  return out;
}

describe('GET /api/performance', () => {
  // (a) 400 paths with distinct codes
  describe('400 validation paths emit distinct codes', () => {
    it('rejects an Invalid Unicode-extension timezone with INVALID_TIMEZONE', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({ tz: 'America/New_York-u-ca-japanese' })}`,
        cookie,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; details?: Record<string, string> };
      };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toBeDefined();
      expect(JSON.stringify(body.error.details)).toContain('Invalid timezone');
    });

    it('rejects a non-IANA tz string with INVALID_TIMEZONE', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({ tz: 'NotAZone' })}`,
        cookie,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details?: Record<string, string> } };
      expect(JSON.stringify(body.error.details)).toContain('Invalid timezone');
    });

    it('rejects bucket-count overflow', async () => {
      const cookie = await registerAndGetCookie();
      // 4 years of day buckets ≈ 1461 > 1095 cap.
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({
          granularity: 'day',
          start: '2020-01-01T00:00:00.000Z',
          end: '2024-01-01T00:00:00.000Z',
        })}`,
        cookie,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details?: Record<string, string> } };
      expect(JSON.stringify(body.error.details)).toContain('exceeds maximum');
    });

    it('rejects end strictly before start', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({
          start: '2026-02-01T00:00:00.000Z',
          end: '2026-01-01T00:00:00.000Z',
        })}`,
        cookie,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details?: Record<string, string> } };
      expect(JSON.stringify(body.error.details)).toContain('strictly before end');
    });

    it('rejects end beyond today + 1 day', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({
          start: '2026-01-01T00:00:00.000Z',
          end: '2030-01-01T00:00:00.000Z',
        })}`,
        cookie,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details?: Record<string, string> } };
      expect(JSON.stringify(body.error.details)).toContain('today + 1 day');
    });

    it('rejects an unsupported currency', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({ currency: 'XYZ' })}`,
        cookie,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details?: Record<string, string> } };
      expect(JSON.stringify(body.error.details)).toContain('SUPPORTED_CURRENCIES');
    });
  });

  // (b) 401 without auth
  it('returns 401 when no session cookie is present', async () => {
    const res = await getRequest(`/api/performance?${buildPerfQuery()}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  // (c) REQ-6.7 read-only — row-count guard
  it('does not write any rows: positions/fills/accounts counts are equal before and after', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    await seedPositions(db, {
      userId,
      accountId: account.id,
      count: 4,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-05T00:00:00Z'),
        end: new Date('2026-01-25T00:00:00Z'),
      },
      rngSeed: 7,
    });

    const counts = async () => {
      const [pos] = await db.execute<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM positions`);
      const [fl] = await db.execute<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM fills`);
      const [acc] = await db.execute<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM accounts`);
      return { positions: pos.c, fills: fl.c, accounts: acc.c };
    };

    const before = await counts();
    const res = await getRequest(`/api/performance?${buildPerfQuery()}`, cookie);
    expect(res.status).toBe(200);
    const after = await counts();
    expect(after).toEqual(before);
  });

  // (d) Middleware-order regression — auth → timeout → validate → handler
  describe('middleware ordering', () => {
    it('registers exactly four handlers for GET /', () => {
      const getRoutes = performanceRouter.routes.filter(
        (r) => r.method === 'GET' && r.path === '/',
      );
      expect(getRoutes).toHaveLength(4);
    });

    it('the first registered handler for GET / is authMiddleware (reference-equality)', () => {
      const getRoutes = performanceRouter.routes.filter(
        (r) => r.method === 'GET' && r.path === '/',
      );
      expect(getRoutes[0]!.handler).toBe(authMiddleware);
    });

    it('auth runs before validate: missing cookie + invalid query yields 401, not 400', async () => {
      // start>=end would normally surface as 400, but auth must short-circuit first.
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({
          start: '2026-02-01T00:00:00.000Z',
          end: '2026-01-01T00:00:00.000Z',
        })}`,
      );
      expect(res.status).toBe(401);
    });

    it('validate runs before handler: invalid query with auth yields 400', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(
        `/api/performance?${buildPerfQuery({ tz: 'NotAZone' })}`,
        cookie,
      );
      expect(res.status).toBe(400);
    });
  });

  // (e) Real-timer timeout middleware tests
  describe('timeout middleware (real timers, log-based cleanup assertion)', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log');
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('logs `timeout cleared` for the request id on the normal completion path', async () => {
      const cookie = await registerAndGetCookie();
      const res = await getRequest(`/api/performance?${buildPerfQuery()}`, cookie);
      expect(res.status).toBe(200);
      const requestId = res.headers.get('X-Request-Id');
      expect(requestId).toBeTruthy();

      const entries = parseJsonLogs(consoleLogSpy);
      const cleared = entries.find(
        (e) => e.message === 'timeout cleared' && e.requestId === requestId,
      );
      expect(cleared).toBeDefined();
      expect(cleared!.reason).toBe('completed');
    });

    it('returns 503 with code TIMEOUT when the middleware deadline fires mid-request', async () => {
      const cookie = await registerAndGetCookie();
      const userId = await getCurrentUserId(cookie);
      const account = await createAccount(cookie, 'USD');

      // Seed a workload that comfortably outlasts the 10ms deadline on any
      // realistic machine — even a fast CI box. The snapshot SQL round-trip
      // alone typically exceeds 10ms, and 5_000 classified positions add
      // tens of additional ms on top of that.
      await seedPositions(db, {
        userId,
        accountId: account.id,
        count: 5_000,
        status: 'closed',
        closedAtRange: {
          start: new Date('2026-01-01T00:00:00Z'),
          end: new Date('2026-01-31T00:00:00Z'),
        },
        rngSeed: 11,
      });

      // Mini-app that reuses production middleware but with ms: 10 instead of
      // ms: 10_000. loggingMiddleware must run first so requestId is populated
      // for the timeout middleware's `finally` log.
      const testApp = new Hono();
      testApp.use(loggingMiddleware);
      testApp.get(
        '/api/performance',
        authMiddleware,
        performanceTimeoutMiddleware({ ms: 10 }),
        validate('query', PerformanceQuerySchema),
        async (c) => {
          const uid = c.get('userId') as string;
          const abortSignal = c.get('abortSignal') as AbortSignal;
          const requestStartTime = c.get('requestStartTime') as number;
          const query = c.req.valid('query');
          const result = await getPerformance(db, uid, query, abortSignal, requestStartTime);
          return c.json(result, 200);
        },
      );
      testApp.onError(errorHandler);

      const res = await testApp.request(`/api/performance?${buildPerfQuery()}`, {
        headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('TIMEOUT');
    });
  });

  // (f) Client cancellation — distinct from TIMEOUT
  it('returns 503 with code CLIENT_ABORT when the client aborts mid-request', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    await seedPositions(db, {
      userId,
      accountId: account.id,
      count: 5_000,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-01-31T00:00:00Z'),
      },
      rngSeed: 13,
    });

    const controller = new AbortController();
    // Schedule the client-side abort while the request is still running. 30ms
    // is comfortably mid-loop given the seeded workload.
    setTimeout(() => controller.abort(), 30);

    const res = await app.request(`/api/performance?${buildPerfQuery()}`, {
      headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
      signal: controller.signal,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CLIENT_ABORT');
  });

  // (g) Legacy-row path — CHECK-drop inside savepoint
  // The CHECK-drop MUST stay inside the it() so the per-test outer transaction's
  // rollback restores the constraint. We follow it with `DISCARD PLANS` to
  // invalidate any prepared-statement plan that captured the old constraint
  // (postgres.js prepare:true on the single test connection). Note: the spec
  // (r2 §8.3, r3 §9.2) calls for `DISCARD ALL`, but DISCARD ALL cannot run
  // inside a transaction block — DISCARD PLANS is the in-tx-safe variant that
  // covers the same plan-cache concern.
  it('counts a legacy closed_at=NULL row in historyExcluded.closed_at_null=1', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');

    await db.execute(
      sql`ALTER TABLE positions DROP CONSTRAINT positions_closed_at_when_closed_chk`,
    );
    // Direct insert is intentional: legacy-row regression test inserts a row that
    // would fail the CHECK constraint we just dropped; the positions service does
    // not allow this state by design.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId,
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      openedAt: new Date('2026-01-09T00:00:00Z'),
      closedAt: null,
    });
    await db.execute(sql`DISCARD PLANS`);

    const res = await getRequest(`/api/performance?${buildPerfQuery()}`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dataQuality: { historyExcluded: { total: number; closed_at_null: number } };
    };
    expect(body.dataQuality.historyExcluded.closed_at_null).toBe(1);
  });

  // (h) Currency-change guard — reference assertion (primary lives in Task 25)
  it('returns 409 ConflictError when changing account currency on an account with positions (REQ-2.7 reference)', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');

    // Direct insert is intentional: client-cancellation test needs many seeded
    // closed positions in a deterministic shape; the positions service path is
    // overhead for this concurrency test.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId,
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      openedAt: new Date('2026-01-05T00:00:00Z'),
    });

    const res = await app.request(`/api/accounts/${account.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ currency: 'EUR' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('Cannot change currency');
  });
});

// ---------------------------------------------------------------------------
// REQ-1.1: the endpoint returns the full requested window on every tier — no
// lookback clamp. Real PG; gating toggled via the mutable config (restored
// per test).
// ---------------------------------------------------------------------------

describe('GET /api/performance — full unclamped window (REQ-1.1)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  const DAY_MS = 86_400_000;

  /** `now − months` calendar months as an ISO string (test-relative dates). */
  function isoMonthsAgo(months: number): string {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()),
    ).toISOString();
  }

  /** One closed position ~10 months ago + one ~2 months ago. */
  async function seedOldAndRecent(cookie: string): Promise<string> {
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const oldStart = new Date(isoMonthsAgo(10));
    await seedPositions(db, {
      userId,
      accountId: account.id,
      count: 1,
      status: 'closed',
      closedAtRange: { start: oldStart, end: new Date(oldStart.getTime() + DAY_MS) },
      rngSeed: 51,
    });
    const recentStart = new Date(isoMonthsAgo(2));
    await seedPositions(db, {
      userId,
      accountId: account.id,
      count: 1,
      status: 'closed',
      closedAtRange: { start: recentStart, end: new Date(recentStart.getTime() + DAY_MS) },
      rngSeed: 52,
    });
    return userId;
  }

  /** A 12-month window ending now. */
  function wideQuery(): string {
    return buildPerfQuery({
      granularity: 'month',
      start: isoMonthsAgo(12),
      end: new Date().toISOString(),
    });
  }

  /** Simulate an upgrade: a qualifying `active` mirror row makes the user Pro. */
  async function upgradeToPro(userId: string): Promise<void> {
    await db.insert(subscriptions).values({
      userId,
      stripeCustomerId: `cus_perf_${userId.slice(0, 8)}`,
      stripeSubscriptionId: `sub_perf_${userId}`,
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
      stripeCreatedAt: new Date(),
      lastEventCreated: new Date(),
    });
  }

  type ClampBody = {
    currencies: Array<{
      code: string;
      stats: { totalPositions: number };
      historyRange: { earliestClosedAt: string | null; totalClosedPositions: number };
    }>;
  };

  it('returns the full requested window for a gated Free user — no tierWindow key (REQ-1.1)', async () => {
    const cookie = await registerAndGetCookie();
    await seedOldAndRecent(cookie);
    config.FEATURE_GATING = true;

    const res = await getRequest(`/api/performance?${wideQuery()}`, cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    // No lookback clamp on any tier: the additive marker is never emitted.
    expect(text).not.toContain('tierWindow');
    const body = JSON.parse(text) as ClampBody;

    const usd = body.currencies.find((c) => c.code === 'USD')!;
    // The full 12-month window is returned: BOTH the ~10-months-ago and the
    // ~2-months-ago positions are counted — nothing is clamped away.
    expect(usd.stats.totalPositions).toBe(2);
    expect(usd.historyRange.totalClosedPositions).toBe(2);
  });

  it('keeps every requested-window schema 400 unchanged for a gated Free user', async () => {
    const cookie = await registerAndGetCookie();
    config.FEATURE_GATING = true;

    // START_BEFORE_MIN hard-400s: validation runs on the requested window.
    const minRes = await getRequest(
      `/api/performance?${buildPerfQuery({ start: '1999-12-31T00:00:00.000Z' })}`,
      cookie,
    );
    expect(minRes.status).toBe(400);
    const minBody = (await minRes.json()) as { error: { details?: Record<string, string> } };
    expect(JSON.stringify(minBody.error.details)).toContain('on or after 2000-01-01');

    // Date order unchanged.
    const orderRes = await getRequest(
      `/api/performance?${buildPerfQuery({
        start: '2026-02-01T00:00:00.000Z',
        end: '2026-01-01T00:00:00.000Z',
      })}`,
      cookie,
    );
    expect(orderRes.status).toBe(400);
    const orderBody = (await orderRes.json()) as { error: { details?: Record<string, string> } };
    expect(JSON.stringify(orderBody.error.details)).toContain('strictly before end');

    // BUCKET_COUNT_CAP evaluated on the REQUESTED window.
    const capRes = await getRequest(
      `/api/performance?${buildPerfQuery({
        granularity: 'day',
        start: '2020-01-01T00:00:00.000Z',
        end: '2024-01-01T00:00:00.000Z',
      })}`,
      cookie,
    );
    expect(capRes.status).toBe(400);
    const capBody = (await capRes.json()) as { error: { details?: Record<string, string> } };
    expect(JSON.stringify(capBody.error.details)).toContain('exceeds maximum');
  });

  it('keeps START_BEFORE_MIN 400 for a gated Pro user too', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    await upgradeToPro(userId);
    config.FEATURE_GATING = true;

    const res = await getRequest(
      `/api/performance?${buildPerfQuery({ start: '1999-12-31T00:00:00.000Z' })}`,
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: Record<string, string> } };
    expect(JSON.stringify(body.error.details)).toContain('on or after 2000-01-01');
  });
});

// ---------------------------------------------------------------------------
// GET /api/performance/breakdown — the per-dimension breakdown route (R3.1,
// R3.2, R3.8, R3.9). No tier gate and no is*Configured branch: the route is
// identical on every tier and with nothing hosted configured.
// ---------------------------------------------------------------------------

describe('GET /api/performance/breakdown', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  function buildBreakdownQuery(overrides: Record<string, string> = {}): string {
    const params: Record<string, string> = {
      by: 'symbol',
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-31T00:00:00.000Z',
      tz: 'UTC',
      ...overrides,
    };
    return new URLSearchParams(params).toString();
  }

  async function seedWindow(cookie: string): Promise<void> {
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    await seedPositions(db, {
      userId,
      accountId: account.id,
      count: 6,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-05T00:00:00Z'),
        end: new Date('2026-01-25T00:00:00Z'),
      },
      rngSeed: 23,
    });
  }

  it('returns 401 when no session cookie is present', async () => {
    const res = await getRequest(`/api/performance/breakdown?${buildBreakdownQuery()}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  describe('400 validation paths key details by field', () => {
    const cases: Array<{ name: string; overrides: Record<string, string>; field: string }> = [
      { name: 'INVALID_TIMEZONE', overrides: { tz: 'NotAZone' }, field: 'tz' },
      { name: 'INVALID_DATE', overrides: { start: 'not-a-date' }, field: 'start' },
      {
        name: 'START_NOT_BEFORE_END',
        overrides: { start: '2026-02-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' },
        field: 'start',
      },
      {
        name: 'START_BEFORE_MIN',
        overrides: { start: '1999-12-31T00:00:00.000Z' },
        field: 'start',
      },
      {
        name: 'END_BEYOND_TODAY_PLUS_ONE',
        overrides: { end: '2030-01-01T00:00:00.000Z' },
        field: 'end',
      },
      { name: 'UNSUPPORTED_CURRENCY', overrides: { currency: 'XYZ' }, field: 'currency' },
      { name: 'a value outside the by enum', overrides: { by: 'nonsense' }, field: 'by' },
    ];

    it.each(cases)(
      'rejects $name with a 400 whose details name $field',
      async ({ overrides, field }) => {
        const cookie = await registerAndGetCookie();
        const res = await getRequest(
          `/api/performance/breakdown?${buildBreakdownQuery(overrides)}`,
          cookie,
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          error: { code: string; details?: Record<string, string> };
        };
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.details).toBeDefined();
        expect(body.error.details).toHaveProperty(field);
      },
    );
  });

  it('returns a 200 body that parses under BreakdownResponseSchema', async () => {
    const cookie = await registerAndGetCookie();
    await seedWindow(cookie);
    const res = await getRequest(`/api/performance/breakdown?${buildBreakdownQuery()}`, cookie);
    expect(res.status).toBe(200);
    const parsed = BreakdownResponseSchema.parse(await res.json());
    expect(parsed.by).toBe('symbol');
    expect(parsed.currencies.length).toBeGreaterThan(0);
  });

  it('echoes resolvedWeekStartDay from config (R3.8)', async () => {
    const cookie = await registerAndGetCookie();
    await seedWindow(cookie);
    const res = await getRequest(`/api/performance/breakdown?${buildBreakdownQuery()}`, cookie);
    expect(res.status).toBe(200);
    const body = BreakdownResponseSchema.parse(await res.json());
    expect(body.resolvedWeekStartDay).toBe(config.WEEK_START_DAY);
  });

  it('sets multiValued true only for by=tag', async () => {
    const cookie = await registerAndGetCookie();
    await seedWindow(cookie);
    for (const by of ['symbol', 'weekday', 'hour'] as const) {
      const res = await getRequest(
        `/api/performance/breakdown?${buildBreakdownQuery({ by })}`,
        cookie,
      );
      expect(res.status).toBe(200);
      const body = BreakdownResponseSchema.parse(await res.json());
      expect(body.multiValued).toBe(false);
    }
    const tagRes = await getRequest(
      `/api/performance/breakdown?${buildBreakdownQuery({ by: 'tag' })}`,
      cookie,
    );
    expect(tagRes.status).toBe(200);
    const tagBody = BreakdownResponseSchema.parse(await tagRes.json());
    expect(tagBody.multiValued).toBe(true);
  });

  it('reports the same dataQuality.timeframeExcluded as /api/performance for the same window (DD11)', async () => {
    const cookie = await registerAndGetCookie();
    await seedWindow(cookie);

    const perfRes = await getRequest(`/api/performance?${buildPerfQuery()}`, cookie);
    expect(perfRes.status).toBe(200);
    const perfBody = (await perfRes.json()) as {
      dataQuality: { timeframeExcluded: unknown };
    };

    const breakdownRes = await getRequest(
      `/api/performance/breakdown?${buildBreakdownQuery()}`,
      cookie,
    );
    expect(breakdownRes.status).toBe(200);
    const breakdownBody = BreakdownResponseSchema.parse(await breakdownRes.json());

    expect(breakdownBody.dataQuality.timeframeExcluded).toEqual(
      perfBody.dataQuality.timeframeExcluded,
    );
  });

  it('behaves identically with feature gating on and off (R3.9)', async () => {
    const cookie = await registerAndGetCookie();
    await seedWindow(cookie);

    config.FEATURE_GATING = false;
    const ungatedRes = await getRequest(
      `/api/performance/breakdown?${buildBreakdownQuery()}`,
      cookie,
    );
    expect(ungatedRes.status).toBe(200);
    const ungated = BreakdownResponseSchema.parse(await ungatedRes.json());

    config.FEATURE_GATING = true;
    const gatedRes = await getRequest(
      `/api/performance/breakdown?${buildBreakdownQuery()}`,
      cookie,
    );
    expect(gatedRes.status).toBe(200);
    const gated = BreakdownResponseSchema.parse(await gatedRes.json());

    expect(gated).toEqual(ungated);
  });
});

// ---------------------------------------------------------------------------
// Requirement 5 / design C8 (multi-leg-positions task 8) — the group is the
// statistics unit. `getPerformance` called directly, over positions and
// position_groups rows inserted directly by raw SQL (db.insert(positions) is
// lint-forbidden outside the positions feature, matching
// breakdown.service.test.ts's insertClosedPosition/insertReopenedPosition).
//
// Contract block — one entry per success criterion this suite covers.
//
// AC 5.1 (closed two-leg group -> one flat entry, summed, latest-dated)
//   Pre: a group of two closed legs, flat at distinct instants.
//   Call: getPerformance over a window covering both instants.
//   Result: stats.totalPositions=1 (not 2); stats.expectancy is the sum of
//     both legs' latched net P&L; the day-bucket at the EARLIER leg's flat
//     date counts zero positions, the LATER leg's day-bucket counts one.
//   Source: requirements.md AC 5.1; design.md C8.
//
// AC 5.2 + AC 5.3 (a flat leg in a never-flat group; its fill still reaches
// Total net P&L at the fill's date — AC 5.3 is a regression guard, newly
// exercised here on a GROUPED leg, which no existing test covers)
//   Pre: a group of two legs — one flat with a real exit fill, one still
//     open (never flat).
//   Call: getPerformance over a window covering both legs' fills.
//   Result: stats.totalPositions=0 and expectancy=null (the flat leg does
//     not count alone); the flat leg's own exit-fill day-bucket still shows
//     zero positions but the realized P&L from that fill.
//   Source: requirements.md AC 5.2, AC 5.3; design.md C8.
//
// AC 5.4a (a group flat in range reads a leg whose fills all precede the range)
//   Pre: a group of two closed legs — one flat well before the window (no
//     fills in range at all), one flat inside the window (the group's
//     overall flat-in-range instant).
//   Call: getPerformance over the window.
//   Result: stats.totalPositions=1; expectancy is the SUM of both legs'
//     figures, proving the early leg was read, not dropped.
//   Source: requirements.md AC 5.4; design.md C8 ("all legs of a touched
//     group are read").
//
// AC 5.4b (a fill in range on a group with a flat event reads all legs)
//   Pre: a group of two closed legs whose own flat dates are BOTH outside
//     the window, but one leg has an (entry) fill inside the window.
//   Call: getPerformance over the window.
//   Result: stats.totalPositions=1; expectancy is the SUM of both legs'
//     figures, proving the sibling with no in-window fill was still read.
//   Source: requirements.md AC 5.4; design.md C8.
//
// AC 5.5 (a reopened leg keeps the group's last figures; a re-close replaces
// them with no second event)
//   Pre: a group of two closed legs.
//   Call: getPerformance once; reopen one leg (status -> open, closed_at ->
//     NULL, latch columns untouched) and call again; re-close that leg with
//     new latch figures and call a third time.
//   Result: totalPositions stays 1 across all three calls; the combined
//     figure and day-bucket are unchanged after the reopen (the latch
//     survives); after the re-close, the figure and day-bucket both move to
//     the new values, with no leftover event at the old date.
//   Source: requirements.md AC 5.5; design.md C8, D2.
//
// AC 5.6 (an unlink recomputes from the current legs)
//   Pre: a group of two closed legs.
//   Call: getPerformance once; unlink one leg (group_id -> NULL) directly;
//     call again.
//   Result: before, one combined entry; after, two separate entries (one
//     lone-leg group, one ungrouped position), each with its own figure.
//   Source: requirements.md AC 5.6; design.md C8.
//
// AC 5.7 (restoring a leg's latch to its prior value moves the group event,
// with no group-specific write — simulating §48's unsettle)
//   Pre: a group of two closed legs.
//   Call: getPerformance once; directly restore one leg's last_flat_at/
//     last_flat_net_pnl to an earlier prior value (no write to
//     position_groups); call again.
//   Result: the combined figure and day-bucket move to reflect the restored
//     leg's new instant/value; the position_groups row is byte-for-byte
//     unchanged across the two calls.
//   Source: requirements.md AC 5.7; design.md C8, D2.
//
// AC 5.11 (regression guard, invariant: a user with no groups gets today's
// figures) is RED-IMPOSSIBLE — every existing assertion in this file and in
// performance.service.test.ts already exercises the ungrouped path end to
// end with zero grouping code involved, branch by branch:
//   - snapshot row selection (own-date-in-window / fill-in-window): every
//     seedPositions-based test above, e.g. "(a) six presets" in
//     performance.service.test.ts.
//   - per-position flat push into bucket A: "(b) Multi-currency isolation".
//   - bucket-B realization at the fill's date: "(b2) serves expectancy as
//     the flat mean... (D1)" and "(g) REQ-3.7 invariants".
//   - empty/no-accounts and unsupported-currency branches: "(c)" and "(d)".
//   - dataQuality overlap accounting: "(e)".
//   - defaultCurrency tie-breaks: "(f)" sub-tests.
//   - timeout/abort branches: the real-timer and client-abort tests above.
// Design C8 changes nothing on this path (groupId is optional and every new
// branch is reached only when a row's group_id is non-null), so no new test
// is needed to pin it; a regression here would already fail one of the
// tests named above.
// ---------------------------------------------------------------------------

describe('GET /api/performance — the group is the statistics unit (Requirement 5, design C8)', () => {
  async function createGroup(userId: string): Promise<string> {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO position_groups (user_id) VALUES (${userId}) RETURNING id
    `);
    return result[0]!.id;
  }

  interface LegOpts {
    symbol: string;
    side?: 'long' | 'short';
    assetType?: 'stock' | 'option';
    status?: 'open' | 'closed';
    openedAt: string;
    closedAt?: string | null;
    lastFlatAt?: string | null;
    netPnl?: string | null;
    groupId?: string | null;
  }

  // Direct insert is intentional: db.insert(positions) is lint-forbidden
  // outside the positions feature. Leaving lastFlatAt null and setting only
  // closedAt + netPnl relies on classifyOne's documented fallback
  // (flatAt = lastFlatAt ?? closedAt), matching
  // breakdown.service.test.ts's insertClosedPosition.
  async function insertLeg(userId: string, accountId: string, opts: LegOpts): Promise<string> {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO positions
        (user_id, account_id, group_id, symbol, side, asset_type, status, opened_at, closed_at,
         last_flat_at, last_flat_net_pnl)
      VALUES
        (${userId}, ${accountId}, ${opts.groupId ?? null}, ${opts.symbol}, ${opts.side ?? 'long'},
         ${opts.assetType ?? 'stock'}, ${opts.status ?? 'closed'}, ${opts.openedAt}::timestamptz,
         ${opts.closedAt ?? null}::timestamptz, ${opts.lastFlatAt ?? null}::timestamptz,
         ${opts.netPnl ?? null}::numeric)
      RETURNING id
    `);
    return result[0]!.id;
  }

  async function insertFill(
    positionId: string,
    type: 'entry' | 'exit',
    price: string,
    quantity: string,
    filledAt: string,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO fills (position_id, type, price, quantity, fees, filled_at)
      VALUES (${positionId}, ${type}, ${price}, ${quantity}, '0', ${filledAt}::timestamptz)
    `);
  }

  function perfInput(overrides: Partial<PerformanceQueryInput> = {}): PerformanceQueryInput {
    return {
      granularity: 'day',
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z',
      tz: 'UTC',
      ...overrides,
    };
  }

  function freshSignal(): AbortSignal {
    return new AbortController().signal;
  }

  it('AC 5.1: a closed two-leg group gives one flat entry, summed, dated at the latest leg flat', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    await insertLeg(userId, account.id, {
      symbol: 'AAPL250320C150',
      assetType: 'option',
      openedAt: '2026-01-05T00:00:00.000Z',
      closedAt: '2026-01-10T00:00:00.000Z',
      netPnl: '200',
      groupId,
    });
    await insertLeg(userId, account.id, {
      symbol: 'AAPL250320C155',
      assetType: 'option',
      side: 'short',
      openedAt: '2026-01-06T00:00:00.000Z',
      closedAt: '2026-01-12T00:00:00.000Z',
      netPnl: '100',
      groupId,
    });

    const result = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usd = result.currencies.find((c) => c.code === 'USD')!;

    expect(usd.stats.totalPositions).toBe(1);
    expect(usd.stats.expectancy).toBe('300');
    expect(usd.series.find((b) => b.bucketStart === '2026-01-10')!.totalPositions).toBe(0);
    expect(usd.series.find((b) => b.bucketStart === '2026-01-12')!.totalPositions).toBe(1);
  });

  it('AC 5.2/5.3: a flat leg in a never-flat group counts nothing alone, but its fill still reaches Total net P&L at the fill date', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    const legA = await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2026-01-05T00:00:00.000Z',
      closedAt: '2026-01-10T00:00:00.000Z',
      groupId,
    });
    await insertFill(legA, 'entry', '10', '100', '2026-01-05T00:00:00.000Z');
    await insertFill(legA, 'exit', '12', '100', '2026-01-10T00:00:00.000Z');

    const legB = await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      status: 'open',
      openedAt: '2026-01-06T00:00:00.000Z',
      closedAt: null,
      groupId,
    });
    await insertFill(legB, 'entry', '50', '10', '2026-01-08T00:00:00.000Z');

    const result = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usd = result.currencies.find((c) => c.code === 'USD')!;

    expect(usd.stats.totalPositions).toBe(0);
    expect(usd.stats.hasWins).toBe(false);
    expect(usd.stats.expectancy).toBeNull();

    const day10 = usd.series.find((b) => b.bucketStart === '2026-01-10')!;
    expect(day10.totalPositions).toBe(0);
    expect(day10.netPnl).toBe('200');
  });

  it('AC 5.4: a group flat in range still reads a leg whose fills all precede the range', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2025-12-01T00:00:00.000Z',
      closedAt: '2025-12-15T00:00:00.000Z',
      netPnl: '100',
      groupId,
    });
    await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      openedAt: '2026-01-10T00:00:00.000Z',
      closedAt: '2026-01-15T00:00:00.000Z',
      netPnl: '50',
      groupId,
    });

    const result = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usd = result.currencies.find((c) => c.code === 'USD')!;

    expect(usd.stats.totalPositions).toBe(1);
    expect(usd.stats.expectancy).toBe('150');
  });

  it('AC 5.4: a fill in range on a group whose flat event falls outside it still reads every leg', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    const legA = await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2026-01-15T00:00:00.000Z',
      closedAt: '2026-02-05T00:00:00.000Z',
      netPnl: '100',
      groupId,
    });
    await insertFill(legA, 'entry', '10', '10', '2026-01-15T00:00:00.000Z');

    await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      openedAt: '2026-02-01T00:00:00.000Z',
      closedAt: '2026-02-06T00:00:00.000Z',
      netPnl: '50',
      groupId,
    });

    const result = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usd = result.currencies.find((c) => c.code === 'USD')!;

    expect(usd.stats.totalPositions).toBe(1);
    expect(usd.stats.expectancy).toBe('150');
  });

  it('AC 5.5: a reopened leg keeps the group figures; a re-close replaces them with no second event', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2026-01-03T00:00:00.000Z',
      closedAt: '2026-01-10T00:00:00.000Z',
      lastFlatAt: '2026-01-10T00:00:00.000Z',
      netPnl: '100',
      groupId,
    });
    const legB = await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      openedAt: '2026-01-04T00:00:00.000Z',
      closedAt: '2026-01-12T00:00:00.000Z',
      lastFlatAt: '2026-01-12T00:00:00.000Z',
      netPnl: '50',
      groupId,
    });

    const before = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdBefore = before.currencies.find((c) => c.code === 'USD')!;
    expect(usdBefore.stats.totalPositions).toBe(1);
    expect(usdBefore.stats.expectancy).toBe('150');

    // Reopen leg B: live status/closed_at change, latch columns untouched.
    await db.execute(sql`
      UPDATE positions SET status = 'open', closed_at = NULL WHERE id = ${legB}
    `);

    const afterReopen = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdReopen = afterReopen.currencies.find((c) => c.code === 'USD')!;
    expect(usdReopen.stats.totalPositions).toBe(1);
    expect(usdReopen.stats.expectancy).toBe('150');
    expect(usdReopen.series.find((b) => b.bucketStart === '2026-01-12')!.totalPositions).toBe(1);

    // Re-close leg B with new figures.
    await db.execute(sql`
      UPDATE positions SET
        status = 'closed',
        closed_at = '2026-01-20T00:00:00.000Z'::timestamptz,
        last_flat_at = '2026-01-20T00:00:00.000Z'::timestamptz,
        last_flat_net_pnl = '70'::numeric
      WHERE id = ${legB}
    `);

    const afterReclose = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdReclose = afterReclose.currencies.find((c) => c.code === 'USD')!;
    expect(usdReclose.stats.totalPositions).toBe(1);
    expect(usdReclose.stats.expectancy).toBe('170');
    expect(usdReclose.series.find((b) => b.bucketStart === '2026-01-12')!.totalPositions).toBe(0);
    expect(usdReclose.series.find((b) => b.bucketStart === '2026-01-20')!.totalPositions).toBe(1);
  });

  it('AC 5.6: an unlink recomputes statistics from the current legs', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2026-01-03T00:00:00.000Z',
      closedAt: '2026-01-10T00:00:00.000Z',
      netPnl: '100',
      groupId,
    });
    const legB = await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      openedAt: '2026-01-04T00:00:00.000Z',
      closedAt: '2026-01-12T00:00:00.000Z',
      netPnl: '50',
      groupId,
    });

    const before = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdBefore = before.currencies.find((c) => c.code === 'USD')!;
    expect(usdBefore.stats.totalPositions).toBe(1);
    expect(usdBefore.stats.expectancy).toBe('150');

    await db.execute(sql`UPDATE positions SET group_id = NULL WHERE id = ${legB}`);

    const after = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdAfter = after.currencies.find((c) => c.code === 'USD')!;
    expect(usdAfter.stats.totalPositions).toBe(2);
    expect(usdAfter.stats.expectancy).toBe('75');
  });

  it('AC 5.7: restoring a leg latch to a prior value moves the group event with no group-table write', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');
    const groupId = await createGroup(userId);

    await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2026-01-03T00:00:00.000Z',
      closedAt: '2026-01-10T00:00:00.000Z',
      lastFlatAt: '2026-01-10T00:00:00.000Z',
      netPnl: '100',
      groupId,
    });
    const legB = await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      openedAt: '2026-01-04T00:00:00.000Z',
      closedAt: '2026-01-15T00:00:00.000Z',
      lastFlatAt: '2026-01-15T00:00:00.000Z',
      netPnl: '80',
      groupId,
    });

    const before = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdBefore = before.currencies.find((c) => c.code === 'USD')!;
    expect(usdBefore.stats.totalPositions).toBe(1);
    expect(usdBefore.stats.expectancy).toBe('180');

    const groupRowBefore = await db.execute(sql`
      SELECT label_override, created_at FROM position_groups WHERE id = ${groupId}
    `);

    // Simulate §48's unsettle: restore leg B's latch to an earlier prior
    // value. No write to position_groups.
    await db.execute(sql`
      UPDATE positions SET
        closed_at = '2026-01-12T00:00:00.000Z'::timestamptz,
        last_flat_at = '2026-01-12T00:00:00.000Z'::timestamptz,
        last_flat_net_pnl = '60'::numeric
      WHERE id = ${legB}
    `);

    const after = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usdAfter = after.currencies.find((c) => c.code === 'USD')!;
    expect(usdAfter.stats.totalPositions).toBe(1);
    expect(usdAfter.stats.expectancy).toBe('160');
    expect(usdAfter.series.find((b) => b.bucketStart === '2026-01-15')!.totalPositions).toBe(0);
    expect(usdAfter.series.find((b) => b.bucketStart === '2026-01-12')!.totalPositions).toBe(1);

    const groupRowAfter = await db.execute(sql`
      SELECT label_override, created_at FROM position_groups WHERE id = ${groupId}
    `);
    expect(groupRowAfter).toEqual(groupRowBefore);
  });

  // AC 5.9, design C8/D10: fetchHistoryMetadata aggregates by unit
  // (COALESCE(group_id, id)) before counting, so a flat group counts once
  // and an open group with one closed leg counts not at all.
  it('AC 5.9: historyRange counts a flat group once and an open group with a closed leg not at all, dated at the flat day', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getCurrentUserId(cookie);
    const account = await createAccount(cookie, 'USD');

    // Flat group: both legs closed. The unit counts once, dated at the
    // LATEST leg's closed_at (2026-01-15), not the earlier leg's.
    const flatGroup = await createGroup(userId);
    await insertLeg(userId, account.id, {
      symbol: 'AAPL',
      openedAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-10T00:00:00.000Z',
      groupId: flatGroup,
    });
    await insertLeg(userId, account.id, {
      symbol: 'MSFT',
      openedAt: '2026-01-02T00:00:00.000Z',
      closedAt: '2026-01-15T00:00:00.000Z',
      groupId: flatGroup,
    });

    // Open group: one closed leg, one still open. The unit is not flat, so it
    // counts not at all — the closed leg must not count on its own.
    const openGroup = await createGroup(userId);
    await insertLeg(userId, account.id, {
      symbol: 'NVDA',
      openedAt: '2026-01-03T00:00:00.000Z',
      closedAt: '2026-01-05T00:00:00.000Z',
      groupId: openGroup,
    });
    await insertLeg(userId, account.id, {
      symbol: 'TSLA',
      status: 'open',
      openedAt: '2026-01-04T00:00:00.000Z',
      closedAt: null,
      groupId: openGroup,
    });

    const result = await getPerformance(db, userId, perfInput(), freshSignal(), Date.now());
    const usd = result.currencies.find((c) => c.code === 'USD')!;

    expect(usd.historyRange.totalClosedPositions).toBe(1);
    expect(new Date(usd.historyRange.earliestClosedAt!).getTime()).toBe(
      new Date('2026-01-15T00:00:00.000Z').getTime(),
    );
    expect(new Date(usd.historyRange.mostRecentClosedAt!).getTime()).toBe(
      new Date('2026-01-15T00:00:00.000Z').getTime(),
    );
  });
});
