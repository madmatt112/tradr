import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hosted-platform Task 17 (REQ-7.5, D8) — per-site `fallbackMax` on the real
// rate-limit call sites. This drives the ACTUAL exported routers (not a
// hand-rolled limiter) so a wrong `fallbackMax` in a route file is caught.
//
// Redis is mocked CONFIGURED. A shared in-memory fake client stands in for the
// Lua check-then-increment (see rate-limit.redis-store.ts HIT_SCRIPT):
//   - `state.up = true`  → healthy: asserts each site's NORMAL max is unchanged.
//   - `state.up = false` → eval rejects (outage): createRateLimiter CATCHES,
//     warn-logs, and DENIES via process-local Map at `fallbackMax` — the bounded
//     N×-degraded state. Only the two auth sites tighten; the Stripe webhook
//     keeps its full budget so a retry burst during an outage is not 429'd.
const mocks = vi.hoisted(() => {
  const store = new Map<string, { count: number; resetAt: number }>();
  const state = { up: true };
  // Mirrors HIT_SCRIPT: block at count >= max WITHOUT incrementing; else INCR
  // (PEXPIRE on the first hit). Returns [count, ttlMs, blocked].
  const client = {
    eval: (_script: string, _numKeys: number, key: string, max: number, windowMs: number) => {
      if (!state.up) return Promise.reject(new Error('ECONNREFUSED'));
      const now = Date.now();
      const m = Number(max);
      const w = Number(windowMs);
      let entry = store.get(key);
      if (entry && entry.resetAt <= now) entry = undefined;
      if (entry && entry.count >= m) return Promise.resolve([entry.count, entry.resetAt - now, 1]);
      if (!entry) {
        store.set(key, { count: 1, resetAt: now + w });
        return Promise.resolve([1, w, 0]);
      }
      entry.count += 1;
      return Promise.resolve([entry.count, entry.resetAt - now, 0]);
    },
  };
  return {
    isRedisConfigured: vi.fn(() => true),
    getSharedRedisClient: vi.fn(() => client),
    state,
    store,
  };
});

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return { ...actual, isRedisConfigured: mocks.isRedisConfigured };
});

vi.mock('@/middleware/rate-limit.redis-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/middleware/rate-limit.redis-store')>();
  return { ...actual, getSharedRedisClient: mocks.getSharedRedisClient };
});

import auth from '@/features/auth/auth.route';
import { billingWebhookRouter } from '@/features/billing/billing.route';
import { errorHandler } from '@/middleware/error.middleware';

function mount(basePath: string, router: Hono) {
  const app = new Hono();
  app.route(basePath, router);
  app.onError(errorHandler);
  return app;
}

// POST an invalid body: under the cap the request reaches validation/handler and
// returns a non-429 (400); over the cap the limiter throws 429 before it. We only
// assert on the 429 boundary, so the body content is irrelevant.
function post(app: Hono, path: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// The client IP under app.request is a constant 127.0.0.1, so every request to a
// given IP-keyed limiter shares one bucket — exactly what these boundary tests need.
async function boundary(app: Hono, path: string, allowed: number) {
  for (let i = 0; i < allowed; i++) {
    expect((await post(app, path)).status).not.toBe(429);
  }
  return (await post(app, path)).status;
}

describe('per-site fallbackMax on the real call sites (REQ-7.5, D8)', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.state.up = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('auth register — tightened under outage', () => {
    const app = mount('/', auth);

    it('normal max is 5 when Redis is healthy', async () => {
      expect(await boundary(app, '/register', 5)).toBe(429);
    });

    it('fallback TIGHTENS to 3 under a Redis outage', async () => {
      mocks.state.up = false;
      expect(await boundary(app, '/register', 3)).toBe(429);
    });
  });

  describe('auth login — tightened under outage', () => {
    const app = mount('/', auth);

    it('normal max is 10 when Redis is healthy', async () => {
      expect(await boundary(app, '/login', 10)).toBe(429);
    });

    it('fallback TIGHTENS to 5 under a Redis outage', async () => {
      mocks.state.up = false;
      expect(await boundary(app, '/login', 5)).toBe(429);
    });
  });

  describe('billing webhook — NOT tightened under outage', () => {
    const app = mount('/webhook', billingWebhookRouter);

    it('keeps its full budget of 100 under a Redis outage (never 429s a Stripe retry burst, never fail-open)', async () => {
      mocks.state.up = false;
      // 100 allowed proves the budget is NOT tightened to auth levels; the 101st
      // 429 proves the fallback still denies (never fail-open).
      expect(await boundary(app, '/webhook', 100)).toBe(429);
    });
  });
});
