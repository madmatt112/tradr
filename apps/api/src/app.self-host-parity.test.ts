// Task 22 (hosted-platform): self-host DEFAULT parity gate (REQ-1.6).
//
// With every gated capability OFF — the Task 2 vitest pin (vitest.workspace.ts)
// forces REDIS_URL, DIRECT_DATABASE_URL, DB_TRANSACTION_POOLER, the
// OBJECT_STORAGE_* vars and CORS_ALLOWED_ORIGINS to empty/unset — the stack MUST
// behave byte-for-byte as it does today: base64-in-JSONB advisor images (no
// object-storage pointer), a process-local rate limiter, SameSite=Lax cookies,
// and prepared statements ON. This consolidates into one REQ-1.6 assertion the
// parity facts the granular suites each prove in isolation (config.test.ts,
// object-storage.test.ts, cookie-policy.test.ts, pooler-correctness.test.ts,
// rate-limit MapStore parity in rate-limit.middleware.test.ts).

import { describe, expect, it } from 'vitest';

import { poolerDriverOptions } from '@/db';
import {
  config,
  isDirectDatabaseConfigured,
  isMetricsConfigured,
  isObjectStorageConfigured,
  isRedisConfigured,
  isSplitOriginConfigured,
} from '@/lib/config';
import { sessionCookieOptions, themeCookieAttributes } from '@/lib/cookie-policy';
import { getObjectStorage } from '@/lib/object-storage';

describe('self-host default parity (REQ-1.6) — every gated capability off', () => {
  it('all gated-capability predicates are false (nothing configured)', () => {
    expect(isObjectStorageConfigured()).toBe(false);
    expect(isRedisConfigured()).toBe(false);
    expect(isSplitOriginConfigured()).toBe(false);
    expect(isDirectDatabaseConfigured()).toBe(false);
  });

  it('object storage is absent ⇒ advisor images stay base64-in-JSONB (no pointer)', () => {
    expect(getObjectStorage()).toBeNull();
  });

  it('rate limiting stays process-local (Redis unconfigured ⇒ MapStore)', () => {
    // isRedisConfigured() drives createRateLimiter's store selection
    // (rate-limit.middleware.ts): false ⇒ the process-local MapStore, today's
    // behavior. MapStore byte-for-byte parity is proved in the rate-limit suite.
    expect(isRedisConfigured()).toBe(false);
  });

  it('session + theme cookies stay SameSite=Lax (never SameSite=None)', () => {
    const session = sessionCookieOptions();
    expect(session.sameSite).toBe('Lax');
    expect(session.httpOnly).toBe(true);

    const theme = themeCookieAttributes();
    expect(theme).toContain('SameSite=Lax');
    expect(theme).not.toContain('SameSite=None');
  });

  it('prepared statements stay ON (DB_TRANSACTION_POOLER off ⇒ prepare key omitted)', () => {
    expect(config.DB_TRANSACTION_POOLER).toBe(false);
    // Omitted — NOT `prepare: undefined` — so postgres.js keeps prepared
    // statements on exactly as today (db/index.ts).
    const opts = poolerDriverOptions(config.DB_TRANSACTION_POOLER);
    expect(opts).toEqual({});
    expect('prepare' in opts).toBe(false);
  });
});

// Deliberately a SIBLING block, not a case inside the gated-capability describe
// above: the metrics surface is NOT a hosted-only capability. Nothing about it
// sits behind FEATURE_GATING, and a self-hoster can turn it on freely. What it
// shares with those capabilities is only that it defaults OFF — which is the one
// thing this block proves (REQ-1.7), under the METRICS_* pin in
// vitest.workspace.ts that keeps a stray ambient value from reddening it (REQ-1.8).
describe('metrics exposition surface (REQ-1.7) — off by default', () => {
  it('isMetricsConfigured() is false with METRICS_ENABLED unset/false', () => {
    expect(config.METRICS_ENABLED).toBe(false);
    expect(isMetricsConfigured()).toBe(false);
  });
});
