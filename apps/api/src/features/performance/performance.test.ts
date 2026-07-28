import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PerformanceQuerySchema } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { positions, subscriptions, users } from '@/db/schema';
import { seedPositions } from '@/db/seed';
import { config } from '@/lib/config';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { errorHandler } from '@/middleware/error.middleware';
import { loggingMiddleware } from '@/middleware/logging.middleware';

import performanceRouter from './performance.route';
import { computeLookbackFloor, getPerformance } from './performance.service';
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
// Plan-tiers L3 (D13, REQ-7.1/7.2/7.4/7.5): route-injected lookback floor.
// Real PG; gating toggled via the mutable config (restored per test).
// ---------------------------------------------------------------------------

describe('GET /api/performance — tier lookback clamp (plan-tiers L3/D13)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  const DAY_MS = 86_400_000;

  /** `now − months` calendar months as an ISO string (test-relative dates). */
  function isoMonthsAgo(months: number): string {
    return computeLookbackFloor(new Date(), months).toISOString();
  }

  /** One closed position ~10 months ago (pre-floor) + one ~2 months ago. */
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

  /** A 12-month window ending now — wider than the free 6-month floor. */
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
    tierWindow?: { clamped: boolean; effectiveStart: string; lookbackMonths: number };
    currencies: Array<{
      code: string;
      stats: { totalPositions: number };
      historyRange: { earliestClosedAt: string | null; totalClosedPositions: number };
    }>;
  };

  it('clamps and marks the response for an enforced Free user; history metadata stays unclamped', async () => {
    const cookie = await registerAndGetCookie();
    await seedOldAndRecent(cookie);
    config.FEATURE_GATING = true;

    const res = await getRequest(`/api/performance?${wideQuery()}`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClampBody;

    expect(body.tierWindow).toBeDefined();
    expect(body.tierWindow!.clamped).toBe(true);
    expect(body.tierWindow!.lookbackMonths).toBe(6);
    // effectiveStart ≈ now − 6 calendar months (the route computes the floor
    // at request time; a generous tolerance keeps this clock-independent).
    const effective = new Date(body.tierWindow!.effectiveStart).getTime();
    expect(Math.abs(effective - computeLookbackFloor(new Date(), 6).getTime())).toBeLessThan(
      2 * DAY_MS,
    );

    const usd = body.currencies.find((c) => c.code === 'USD')!;
    // Stats cover only the clamped window (the 10-months-ago row excluded)…
    expect(usd.stats.totalPositions).toBe(1);
    // …while history metadata is UNCLAMPED (OD#9 — powers the upgrade notice).
    expect(usd.historyRange.totalClosedPositions).toBe(2);
    expect(new Date(usd.historyRange.earliestClosedAt!).getTime()).toBeLessThan(effective);
  });

  it('keeps every requested-window schema 400 unchanged for a gated Free user', async () => {
    const cookie = await registerAndGetCookie();
    config.FEATURE_GATING = true;

    // START_BEFORE_MIN still hard-400s even though the clamp would move
    // start far past 2000-01-01.
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

    // BUCKET_COUNT_CAP evaluated on the REQUESTED window, even though the
    // clamped window would be well under the cap.
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

  it('applies no floor for a Pro user — response byte-identical to gating off', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await seedOldAndRecent(cookie);
    const query = wideQuery(); // pin ONE query string for both requests

    config.FEATURE_GATING = false;
    const offRes = await getRequest(`/api/performance?${query}`, cookie);
    expect(offRes.status).toBe(200);
    const offText = await offRes.text();
    expect(offText).not.toContain('tierWindow');

    await upgradeToPro(userId);
    config.FEATURE_GATING = true;
    const proRes = await getRequest(`/api/performance?${query}`, cookie);
    expect(proRes.status).toBe(200);
    expect(await proRes.text()).toBe(offText);
  });

  it('applies no floor for an admin — response byte-identical to gating off', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await seedOldAndRecent(cookie);
    const query = wideQuery();

    config.FEATURE_GATING = false;
    const offRes = await getRequest(`/api/performance?${query}`, cookie);
    expect(offRes.status).toBe(200);
    const offText = await offRes.text();
    expect(offText).not.toContain('tierWindow');

    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    config.FEATURE_GATING = true;
    const adminRes = await getRequest(`/api/performance?${query}`, cookie);
    expect(adminRes.status).toBe(200);
    expect(await adminRes.text()).toBe(offText);
  });
});
