import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisStore } from '@/middleware/rate-limit.redis-store';

// hosted-platform Task 16 (REQ-7.1/7.3) — RedisStore against a REAL ephemeral
// Redis (NOT ioredis-mock, per the design's CI-demonstration clause). Connect via
// REDIS_TEST_URL, which is NOT one of the vitest-pinned hosted-platform vars
// (REDIS_URL is pinned '' so isRedisConfigured stays false for every OTHER test),
// so this suite skips cleanly when no Redis is provided and runs in CI where the
// `redis:7` service sets REDIS_TEST_URL=redis://localhost:6379.
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

function connect(): Redis {
  const client = new Redis(REDIS_TEST_URL as string, { maxRetriesPerRequest: 1 });
  client.on('error', () => {
    /* swallow — a down test Redis surfaces via the assertions, not an unhandled event */
  });
  return client;
}

describe.skipIf(!REDIS_TEST_URL)('RedisStore (real ephemeral Redis)', () => {
  let client: Redis;

  beforeEach(async () => {
    client ??= connect();
    await client.flushdb();
  });

  afterAll(async () => {
    if (client) await client.quit();
  });

  it('atomic check-then-increment: blocks at max WITHOUT over-incrementing; first hit sets expiry', async () => {
    const store = new RedisStore(client, 'test:');

    const r1 = await store.hit('k', 60_000, 2);
    expect(r1).toMatchObject({ count: 1, blocked: false });
    // The first hit set the window expiry (PEXPIRE), ~60s.
    const ttl = await client.pttl('test:k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);

    const r2 = await store.hit('k', 60_000, 2);
    expect(r2).toMatchObject({ count: 2, blocked: false });

    // At the cap: blocked, and the stored counter is NOT incremented past max.
    const r3 = await store.hit('k', 60_000, 2);
    expect(r3).toMatchObject({ count: 2, blocked: true });
    const r4 = await store.hit('k', 60_000, 2);
    expect(r4).toMatchObject({ count: 2, blocked: true });
    expect(Number(await client.get('test:k'))).toBe(2);
    // resetAtMs reflects the remaining PTTL, in the future and within the window.
    expect(r3.resetAtMs).toBeGreaterThan(Date.now());
    expect(r3.resetAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('two instances over one store enforce a COMBINED budget (REQ-7.3)', async () => {
    const client2 = connect();
    try {
      // Two independent limiter store instances (separate connections), same
      // Redis + same namespace + same key ⇒ counts are shared, not per-instance.
      const a = new RedisStore(client, 'shared:');
      const b = new RedisStore(client2, 'shared:');

      expect((await a.hit('ip', 60_000, 3)).blocked).toBe(false); // 1 via A
      expect((await b.hit('ip', 60_000, 3)).blocked).toBe(false); // 2 via B
      expect((await a.hit('ip', 60_000, 3)).blocked).toBe(false); // 3 via A
      // The 4th attempt, counted across both instances, is blocked.
      expect((await b.hit('ip', 60_000, 3)).blocked).toBe(true);
      expect((await a.hit('ip', 60_000, 3)).blocked).toBe(true);
    } finally {
      await client2.quit();
    }
  });
});
