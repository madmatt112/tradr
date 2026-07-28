// Task 2 (deployment): unit coverage for the TRUSTED_PROXIES matcher backing
// getClientIp. `isTrustedProxy` is the pure function extracted so the trusted-
// proxy list can be exercised directly without mocking @/lib/config. Covers
// Req 11.1 (exact-IP regression), 11.3 (IPv4 CIDR in/out of range, malformed
// entry ignored), and the empty-config case (11.5: no entries trusts nobody).

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '@/middleware/error.middleware';
import { createRateLimiter, isTrustedProxy, MapStore } from '@/middleware/rate-limit.middleware';

// hosted-platform Task 16 (REQ-7.2/1.2): the Redis-off default path is the
// MapStore, which must reproduce today's process-local limiter byte-for-byte.
// These tests run with Redis OFF (the vitest REDIS_URL='' pin ⇒ isRedisConfigured
// false), so createRateLimiter selects the MapStore.
function buildLimitedApp(opts: Parameters<typeof createRateLimiter>[0]) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', createRateLimiter(opts));
  app.get('/', (c) => c.text('ok'));
  return app;
}

describe('isTrustedProxy', () => {
  describe('exact-IP matching (Req 11.1 regression)', () => {
    it('matches an exact IPv4 entry', () => {
      expect(isTrustedProxy('127.0.0.1', ['127.0.0.1'])).toBe(true);
    });

    it('does not match a different IPv4', () => {
      expect(isTrustedProxy('10.0.0.5', ['127.0.0.1'])).toBe(false);
    });

    it('matches an exact IPv6 entry', () => {
      expect(isTrustedProxy('::1', ['::1'])).toBe(true);
    });

    it('matches when one of several exact entries matches', () => {
      expect(isTrustedProxy('10.0.0.5', ['127.0.0.1', '10.0.0.5'])).toBe(true);
    });
  });

  describe('IPv4 CIDR matching (Req 11.3)', () => {
    it('matches an address inside the range', () => {
      expect(isTrustedProxy('172.18.0.7', ['172.18.0.0/16'])).toBe(true);
    });

    it('rejects an address outside the range', () => {
      expect(isTrustedProxy('172.19.0.7', ['172.18.0.0/16'])).toBe(false);
    });

    it('matches a /24 boundary inclusively', () => {
      expect(isTrustedProxy('192.168.1.255', ['192.168.1.0/24'])).toBe(true);
      expect(isTrustedProxy('192.168.2.0', ['192.168.1.0/24'])).toBe(false);
    });

    it('matches a /32 only for the exact host', () => {
      expect(isTrustedProxy('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
      expect(isTrustedProxy('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
    });

    it('matches everything for /0', () => {
      expect(isTrustedProxy('203.0.113.9', ['0.0.0.0/0'])).toBe(true);
    });

    it('does not match an IPv6 address against an IPv4 CIDR', () => {
      expect(isTrustedProxy('::1', ['172.18.0.0/16'])).toBe(false);
    });
  });

  describe('malformed entries are ignored (Req 11.3)', () => {
    it('ignores a CIDR with an out-of-range prefix', () => {
      expect(isTrustedProxy('172.18.0.7', ['172.18.0.0/33'])).toBe(false);
    });

    it('ignores a CIDR with a non-numeric prefix', () => {
      expect(isTrustedProxy('172.18.0.7', ['172.18.0.0/ab'])).toBe(false);
    });

    it('ignores a CIDR with a malformed base address', () => {
      expect(isTrustedProxy('172.18.0.7', ['172.18.0.999/16'])).toBe(false);
    });

    it('ignores a malformed entry but still honors a valid sibling', () => {
      expect(isTrustedProxy('172.18.0.7', ['bogus/16', '172.18.0.0/16'])).toBe(true);
    });

    it('ignores empty string entries', () => {
      expect(isTrustedProxy('10.0.0.1', ['', '10.0.0.1'])).toBe(true);
    });
  });

  describe('empty config trusts nobody (Req 11.5)', () => {
    it('returns false for an empty list', () => {
      expect(isTrustedProxy('127.0.0.1', [])).toBe(false);
    });
  });
});

describe("MapStore (byte-for-byte with today's Map limiter)", () => {
  it('blocks at >= max WITHOUT incrementing and keeps a fixed reset', async () => {
    const store = new MapStore();
    const r1 = await store.hit('k', 60_000, 2);
    expect(r1).toMatchObject({ count: 1, blocked: false });
    const r2 = await store.hit('k', 60_000, 2);
    expect(r2).toMatchObject({ count: 2, blocked: false });
    // At the cap: blocked, and the counter does NOT advance past max.
    const r3 = await store.hit('k', 60_000, 2);
    expect(r3).toMatchObject({ count: 2, blocked: true });
    const r4 = await store.hit('k', 60_000, 2);
    expect(r4).toMatchObject({ count: 2, blocked: true });
    // The window's reset time is fixed from the first hit (today's semantics).
    expect(r3.resetAtMs).toBe(r1.resetAtMs);
    expect(r1.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('starts a fresh window after the current one expires', async () => {
    const store = new MapStore();
    expect((await store.hit('k', 30, 1)).blocked).toBe(false);
    expect((await store.hit('k', 30, 1)).blocked).toBe(true);
    await new Promise((r) => setTimeout(r, 45));
    expect(await store.hit('k', 30, 1)).toMatchObject({ count: 1, blocked: false });
  });

  it('keeps distinct keys independent', async () => {
    const store = new MapStore();
    await store.hit('a', 60_000, 1);
    expect((await store.hit('a', 60_000, 1)).blocked).toBe(true);
    // A different key has its own budget.
    expect((await store.hit('b', 60_000, 1)).blocked).toBe(false);
  });
});

describe('createRateLimiter — MapStore path (Redis off, default)', () => {
  it('allows up to max requests, then 429s with the unchanged Retry-After shape', async () => {
    const app = buildLimitedApp({ name: 'test', max: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect((await app.request('/')).status).toBe(200);
    }
    const blocked = await app.request('/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('does not over-increment: stays blocked on repeated over-cap hits', async () => {
    const app = buildLimitedApp({ name: 'test', max: 1, windowMs: 60_000 });
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(429);
    expect((await app.request('/')).status).toBe(429);
  });

  it('resets after the window elapses', async () => {
    const app = buildLimitedApp({ name: 'test', max: 1, windowMs: 40 });
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(429);
    await new Promise((r) => setTimeout(r, 60));
    expect((await app.request('/')).status).toBe(200);
  });
});
