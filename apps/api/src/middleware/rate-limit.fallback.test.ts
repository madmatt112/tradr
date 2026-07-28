import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hosted-platform Task 16 (REQ-7.5) — the never-fail-open fallback. With Redis
// CONFIGURED but UNREACHABLE, createRateLimiter must CATCH the Redis error,
// warn-log, and DENY via process-local Map counting at `fallbackMax` (the bounded
// N×-degraded state): it never allows-through and never crashes. Config +
// the shared Redis client are mocked so the Redis path is entered and every
// hit() rejects, exercising the real RedisStore → catch → MapStore(fallbackMax).
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

import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/error.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

// A client whose every `eval` rejects — i.e. Redis is unreachable.
function failingClient(): Redis {
  return { eval: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as unknown as Redis;
}

function buildLimitedApp(opts: Parameters<typeof createRateLimiter>[0]) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', createRateLimiter(opts));
  app.get('/', (c) => c.text('ok'));
  return app;
}

describe('createRateLimiter — Redis-unreachable fallback (REQ-7.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRedisConfigured.mockReturnValue(true);
    mocks.getSharedRedisClient.mockReturnValue(failingClient());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DENIES at fallbackMax under a Redis outage (never allow-through)', async () => {
    const app = buildLimitedApp({ name: 'test', max: 10, windowMs: 60_000, fallbackMax: 3 });
    // The tightened per-container cap is 3, NOT the normal max of 10.
    for (let i = 0; i < 3; i++) {
      expect((await app.request('/')).status).toBe(200);
    }
    const blocked = await app.request('/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('never crashes: a Redis error surfaces as 200/429, never 500, and is warn-logged', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const app = buildLimitedApp({ name: 'test', max: 5, windowMs: 60_000, fallbackMax: 2 });

    const first = await app.request('/');
    expect(first.status).toBe(200);
    expect(warn).toHaveBeenCalledWith('redis_rate_limit_fallback', expect.any(Object));

    expect((await app.request('/')).status).toBe(200);
    // Over the tightened cap → 429 (the fallback denies; it does NOT 500).
    expect((await app.request('/')).status).toBe(429);
  });

  it('defaults fallbackMax to max when omitted', async () => {
    const app = buildLimitedApp({ name: 'test', max: 2, windowMs: 60_000 });
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(429);
  });
});
