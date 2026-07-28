import { createMiddleware } from 'hono/factory';

import { config, isRedisConfigured } from '@/lib/config';
import { RateLimitError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { getSharedRedisClient, RedisStore } from './rate-limit.redis-store';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  // Per-limiter identity. REQUIRED so distinct limiters get distinct Redis
  // namespaces (REQ-7.2): the RedisStore key prefix folds `name` in, so two
  // limiters with IDENTICAL max/window (e.g. advisor provider-keys and
  // market-data-keys, both 10/1h/userId) no longer collide on one shared budget.
  // MapStore is per-process and already isolates each limiter's own Map, so the
  // name only affects the Redis namespace.
  name: string;
  max: number;
  windowMs: number;
  // Optional bucket-key resolver. Defaults to the client IP (preserves the
  // behavior of all existing callers). The advisor streaming endpoints pass a
  // userId-based keyer so the per-user billing cap is enforced regardless of IP.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keyGenerator?: (c: any) => string;
  // Applies ONLY in the Redis-configured path when Redis is UNREACHABLE (F3).
  // On a Redis error the limiter falls back to PROCESS-LOCAL Map counting with
  // this tightened per-container cap (defaults to `max`); it DENIES at the cap
  // and never fail-opens. This is the bounded N×-degraded state (REQ-7.5): each
  // of N containers enforces `fallbackMax` locally. Ignored when Redis is unset.
  fallbackMax?: number;
}

// The outcome of counting one request against a bucket. `blocked` is true when
// the request is over the cap (the caller turns it into a 429 + Retry-After);
// `resetAtMs` is the absolute time the current window resets.
export interface RateLimitResult {
  count: number;
  resetAtMs: number;
  blocked: boolean;
}

// Where rate-limit counts live. MapStore keeps them process-local (today's
// default); RedisStore keeps them in a shared Redis. Both share this contract so
// swapping the store changes WHERE counts live, not the limiter semantics (REQ-7.2).
export interface Store {
  hit(key: string, windowMs: number, max: number): Promise<RateLimitResult>;
}

// Process-local, in-memory store — TODAY's `Map` logic verbatim (the self-host
// default, REQ-1.2/7.2). A live window blocks at `count >= max` WITHOUT
// incrementing; otherwise it increments; an absent/expired window starts a fresh
// `count: 1, resetAt: now + windowMs`. Each limiter owns its own Map instance, so
// distinct limiters never share a counter.
export class MapStore implements Store {
  private readonly store = new Map<string, RateLimitEntry>();

  hit(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (entry && entry.resetAt > now) {
      if (entry.count >= max) {
        return Promise.resolve({ count: entry.count, resetAtMs: entry.resetAt, blocked: true });
      }
      entry.count++;
      return Promise.resolve({ count: entry.count, resetAtMs: entry.resetAt, blocked: false });
    }

    // New or expired window
    const resetAt = now + windowMs;
    this.store.set(key, { count: 1, resetAt });
    return Promise.resolve({ count: 1, resetAtMs: resetAt, blocked: false });
  }
}

// Parse an IPv4 dotted-quad into a 32-bit unsigned integer. Returns null if
// the string is not a well-formed IPv4 address (rejects out-of-range octets,
// wrong segment counts, and non-numeric segments).
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Test whether `ip` falls inside the IPv4 CIDR block `a.b.c.d/n`. Returns false
// for malformed CIDRs (bad base address or prefix length outside 0-32) so that
// a typo'd TRUSTED_PROXIES entry is silently ignored rather than trusting everyone.
function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash === -1) return false;
  const base = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  if (prefix > 32) return false;

  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === null || ipInt === null) return false;

  // /0 trusts everything; shifting a 32-bit value by 32 is undefined in JS, so
  // handle the zero-prefix case explicitly.
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

// Returns true if `ip` is trusted by any entry: an exact string match (any
// address family, IPv4 or IPv6) OR membership in an IPv4 CIDR block. Pure
// function — exported for unit testing.
export function isTrustedProxy(ip: string, trustedProxies: string[]): boolean {
  for (const entry of trustedProxies) {
    if (!entry) continue;
    if (entry.includes('/')) {
      if (ipv4InCidr(ip, entry)) return true;
    } else if (entry === ip) {
      return true;
    }
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClientIp(c: any): string {
  const trustedProxies = config.TRUSTED_PROXIES?.split(',').map((s) => s.trim()) ?? [];

  if (trustedProxies.length > 0) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const ips = forwarded.split(',').map((s: string) => s.trim());
      // Walk right-to-left, strip trusted proxies, return first untrusted
      for (let i = ips.length - 1; i >= 0; i--) {
        const ip = ips[i];
        // Skip non-IP values
        if (!ip || ip.includes(' ')) continue;
        if (!isTrustedProxy(ip, trustedProxies)) {
          return ip;
        }
      }
    }
  }

  // Fallback to socket remote address
  const info = c.req.raw?.socket?.remoteAddress;
  return info || '127.0.0.1';
}

// Turn a store result into the SAME 429 + Retry-After that the process-local
// limiter has always thrown (REQ-7.2/7.4). `now` is captured by the caller before
// the store call so the Retry-After value matches today's byte-for-byte on the
// blocked path (`resetAtMs` comes from a prior request there).
function throwIfBlocked(result: RateLimitResult, now: number): void {
  if (result.blocked) {
    throw new RateLimitError(Math.ceil((result.resetAtMs - now) / 1000));
  }
}

export function createRateLimiter(options: RateLimitOptions) {
  const keyOf = options.keyGenerator ?? getClientIp;

  // Self-host default (REQ-1.2/7.2): process-local Map, today's behavior verbatim.
  if (!isRedisConfigured()) {
    const store = new MapStore();
    return createMiddleware(async (c, next) => {
      const key = keyOf(c);
      const now = Date.now();
      throwIfBlocked(await store.hit(key, options.windowMs, options.max), now);
      await next();
    });
  }

  // Redis-configured (hosted) path: counts live in the shared Redis so N
  // containers enforce one budget. A per-limiter namespace keeps distinct
  // limiters from colliding on a shared client (REQ-7.2).
  const redisStore = new RedisStore(
    getSharedRedisClient(),
    `rl:${options.name}:${options.max}:${options.windowMs}:`,
  );
  // Process-local fallback used ONLY when Redis is unreachable — NEVER fail-open.
  const fallbackStore = new MapStore();
  const fallbackMax = options.fallbackMax ?? options.max;

  return createMiddleware(async (c, next) => {
    const key = keyOf(c);
    const now = Date.now();
    let result: RateLimitResult;
    try {
      result = await redisStore.hit(key, options.windowMs, options.max);
    } catch (err) {
      // Redis outage: warn-log and DENY at the tightened per-container cap via
      // the same Map mechanism — a bounded N×-degraded state, never fail-open
      // and never a crash (REQ-7.5).
      logger.warn('redis_rate_limit_fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      result = await fallbackStore.hit(key, options.windowMs, fallbackMax);
    }
    throwIfBlocked(result, now);
    await next();
  });
}
