import { Redis } from 'ioredis';

import { config } from '@/lib/config';
import { logger } from '@/lib/logger';

import type { RateLimitResult, Store } from './rate-limit.middleware';

// Atomic check-then-increment matching MapStore's semantics (design §Component 6,
// MN-4). The whole check + increment runs as ONE server-side Lua eval, so there is
// no check-then-increment race across the N containers that share this Redis:
//   - current count >= max  → blocked, do NOT increment (returns the current count)
//   - otherwise             → INCR, and set PEXPIRE only on the first hit (count == 1)
// The window is a fixed window keyed off the first hit's PEXPIRE, exactly like the
// Map's `resetAt = now + windowMs`. Returns {count, ttlMs, blocked}; the caller turns
// ttlMs into resetAtMs so the 429/Retry-After shape is unchanged (REQ-7.2).
const HIT_SCRIPT = `
local max = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[1]))
if current and current >= max then
  return {current, redis.call('PTTL', KEYS[1]), 1}
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
end
return {count, redis.call('PTTL', KEYS[1]), 0}
`;

/**
 * Shared-Redis rate-limit store (REQ-7.1). Counts live in Redis keyed by the
 * client identity within a per-limiter namespace, so N API containers enforce one
 * global budget. Atomic via a single Lua eval (no check-then-increment race).
 */
export class RedisStore implements Store {
  constructor(
    private readonly redis: Redis,
    // Per-limiter namespace so two DIFFERENT limiters that happen to share a
    // client identity (e.g. both userId-keyed) do not collide in the one shared
    // connection — this preserves each limiter's independent budget (REQ-7.2),
    // while the same limiter across containers uses the same prefix and shares.
    private readonly keyPrefix: string,
  ) {}

  async hit(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const raw = (await this.redis.eval(
      HIT_SCRIPT,
      1,
      `${this.keyPrefix}${key}`,
      max,
      windowMs,
    )) as [number, number, number];
    const count = Number(raw[0]);
    const ttlMs = Number(raw[1]);
    const blocked = raw[2] === 1;
    // PTTL is milliseconds-to-expiry; -1/-2 (no ttl / no key) should not happen
    // because the first INCR always PEXPIREs, but fall back to windowMs if so.
    const resetAtMs = Date.now() + (ttlMs >= 0 ? ttlMs : windowMs);
    return { count, resetAtMs, blocked };
  }
}

let sharedClient: Redis | null = null;

/**
 * The ONE shared ioredis connection every Redis-backed limiter uses (design
 * §Component 6). Created lazily the first time a Redis limiter is built.
 *
 * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` make a Redis outage
 * surface as a promptly-rejected `hit()` rather than a hang, so createRateLimiter's
 * process-local fallback engages quickly (never fail-open). The `on('error')`
 * handler keeps an outage from crashing the process via an unhandled 'error'.
 */
export function getSharedRedisClient(): Redis {
  if (!sharedClient) {
    const url = config.REDIS_URL;
    if (!url) {
      throw new Error('getSharedRedisClient called without REDIS_URL configured');
    }
    sharedClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    sharedClient.on('error', (err: Error) => {
      logger.warn('redis_rate_limit_connection_error', { error: err.message });
    });
  }
  return sharedClient;
}
