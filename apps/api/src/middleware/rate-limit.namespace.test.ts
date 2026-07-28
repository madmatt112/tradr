import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// hosted-platform Task 16 fix (REQ-7.2) — the per-limiter NAME seam. createRateLimiter
// folds `name` into the RedisStore key prefix (`rl:{name}:{max}:{windowMs}:`), so two
// DISTINCT limiters with IDENTICAL max/window (e.g. advisor provider-keys and
// market-data-keys, both 10/1h/userId) land in DIFFERENT namespaces and no longer
// collide on ONE shared Redis budget. Driven through createRateLimiter (not the raw
// store) so the seam is verified end-to-end, against a REAL ephemeral Redis via
// REDIS_TEST_URL (skips cleanly when unset, matching rate-limit.redis-store.test.ts).
// The shared client + isRedisConfigured are mocked so the Redis path is entered.
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

const mocks = vi.hoisted(() => ({
  isRedisConfigured: vi.fn(() => true),
  getSharedRedisClient: vi.fn(),
}));

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return { ...actual, isRedisConfigured: mocks.isRedisConfigured };
});

vi.mock('@/middleware/rate-limit.redis-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/middleware/rate-limit.redis-store')>();
  return { ...actual, getSharedRedisClient: mocks.getSharedRedisClient };
});

import { errorHandler } from '@/middleware/error.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

// All limiters below key on a constant userId, so IP is irrelevant — the only
// thing separating their budgets is the `name`-derived Redis namespace.
function buildApp(opts: Parameters<typeof createRateLimiter>[0]) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', createRateLimiter(opts));
  app.get('/', (c) => c.text('ok'));
  return app;
}

describe.skipIf(!REDIS_TEST_URL)('createRateLimiter Redis namespace isolation (REQ-7.2)', () => {
  let client: Redis;

  beforeEach(async () => {
    if (!client) {
      // Use a dedicated logical DB (db 1) so this file's `flushdb()` never wipes
      // rate-limit.redis-store.test.ts's keys (db 0) when vitest runs the two
      // real-Redis suites in parallel.
      client = new Redis(REDIS_TEST_URL as string, { maxRetriesPerRequest: 1, db: 1 });
      client.on('error', () => {
        /* swallow — a down test Redis surfaces via the assertions */
      });
    }
    await client.flushdb();
    mocks.isRedisConfigured.mockReturnValue(true);
    mocks.getSharedRedisClient.mockReturnValue(client);
  });

  afterAll(async () => {
    if (client) await client.quit();
  });

  it('distinct NAMES with identical max/window do NOT share a budget', async () => {
    const cfg = { max: 1, windowMs: 3_600_000, keyGenerator: () => 'user-1' };
    const providerKeys = buildApp({ name: 'provider-keys', ...cfg });
    const marketDataKeys = buildApp({ name: 'market-data-keys', ...cfg });

    // Exhaust the provider-keys budget for user-1.
    expect((await providerKeys.request('/')).status).toBe(200);
    expect((await providerKeys.request('/')).status).toBe(429);
    // market-data-keys has its OWN namespace ⇒ its own budget for the SAME user
    // and IDENTICAL config: it is NOT already spent.
    expect((await marketDataKeys.request('/')).status).toBe(200);
  });

  it('same NAME + identical config share ONE budget (control)', async () => {
    const cfg = { name: 'stream', max: 1, windowMs: 3_600_000, keyGenerator: () => 'user-1' };
    const a = buildApp({ ...cfg });
    const b = buildApp({ ...cfg });

    expect((await a.request('/')).status).toBe(200);
    // b shares the SAME namespace ⇒ the budget is already spent across limiters.
    expect((await b.request('/')).status).toBe(429);
  });
});
