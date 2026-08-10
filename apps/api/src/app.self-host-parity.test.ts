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

import { DEFAULT_REPORTING_TIMEZONE } from '@tradr/shared';

import app from '@/app';
import { poolerDriverOptions } from '@/db';
import {
  config,
  isDirectDatabaseConfigured,
  isEmailConfigured,
  isFeatureGatingEnabled,
  isMetricsConfigured,
  isObjectStorageConfigured,
  isPostHogConfigured,
  isRedisConfigured,
  isSplitOriginConfigured,
  isStockQuoteConfigured,
  isStripeConfigured,
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

// Onboarding is not a hosted capability. A self-hoster with nothing configured
// gets the same first run as anyone on the hosted tier: the same reporting-zone
// and onboarding preferences, and the same sample account they can add to see a
// populated product and remove again once they have their own trades in.
//
// So this block drives that whole surface over HTTP with every optional
// integration off — which is how the vitest pin above already leaves the suite —
// rather than asserting predicates. A predicate assertion would keep passing if
// a route learned to answer 503 when object storage is absent; only the request
// itself catches that. The first case states the premise the rest depend on:
// these endpoints are reached with nothing an operator could have configured.
describe('onboarding surface parity — every optional integration off', () => {
  let testCounter = 0;
  const testRunId = Date.now();
  function uniqueEmail() {
    return `parity-test${testRunId}-${++testCounter}@example.com`;
  }

  // Own /8 sub-range (auth.test.ts owns 10.0, the timezone suite 10.31, the
  // onboarding suite 10.32) so the register limiter never sees a shared client.
  let ipCounter = 0;
  function uniqueIp() {
    return `10.33.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  }

  async function registerAndGetCookie(): Promise<string> {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers
      .getSetCookie()
      .map((header) => header.match(/session=([^;]*)/))
      .find((match) => match !== null);
    expect(cookie).toBeTruthy();
    return cookie![1];
  }

  function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
    const headers: Record<string, string> = {
      Cookie: `session=${cookie}`,
      'X-Forwarded-For': uniqueIp(),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return app.request(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('nothing optional is configured', () => {
    // The four hosted-platform predicates are covered by the first block above;
    // these are the rest of what "no optional integration" means — no email, no
    // Stripe, no analytics, no quote provider. Feature gating is in the list
    // because the sample-data refusal further down has to hold on its own,
    // with no plan cap standing in for it.
    expect(isEmailConfigured()).toBe(false);
    expect(isStripeConfigured()).toBe(false);
    expect(isPostHogConfigured()).toBe(false);
    expect(isStockQuoteConfigured()).toBe(false);
    expect(isFeatureGatingEnabled()).toBe(false);
  });

  it('the reporting-timezone preference reads and writes', async () => {
    const cookie = await registerAndGetCookie();

    const read = await authedRequest('GET', '/api/users/me/timezone', cookie);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ timezone: DEFAULT_REPORTING_TIMEZONE, stored: true });

    const write = await authedRequest('PUT', '/api/users/me/timezone', cookie, {
      timezone: 'Europe/London',
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ timezone: 'Europe/London', stored: true });
  });

  it('the onboarding preference reads and writes', async () => {
    const cookie = await registerAndGetCookie();

    const read = await authedRequest('GET', '/api/users/me/onboarding', cookie);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ status: 'pending', coachMarksSeen: [] });

    const write = await authedRequest('PATCH', '/api/users/me/onboarding', cookie, {
      status: 'active',
      coachMarkSeen: 'csv-import',
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ status: 'active', coachMarksSeen: ['csv-import'] });
  });

  it('sample data can be added', async () => {
    const cookie = await registerAndGetCookie();

    const seed = await authedRequest('POST', '/api/accounts/demo', cookie);
    expect(seed.status).toBe(201);
    const account = (await seed.json()) as { id: string; isDemo: boolean };
    expect(account.isDemo).toBe(true);

    // Read back through the ordinary list, so a seed that answered 201 without
    // writing anything would not pass. The fixture's own figures are pinned by
    // the sample-account suite; what matters here is only that it seeds at all.
    // Containment, not an exact array: whether registration also leaves the user
    // some other account is no business of this block, and pinning it here would
    // report an unrelated signup change as a hosted-vs-self-host regression.
    const list = await authedRequest('GET', '/api/accounts', cookie);
    expect(list.status).toBe(200);
    expect((await list.json()) as { id: string; isDemo: boolean }[]).toContainEqual(
      expect.objectContaining({ id: account.id, isDemo: true }),
    );
  });

  it('sample data can be removed again', async () => {
    const cookie = await registerAndGetCookie();
    const seed = await authedRequest('POST', '/api/accounts/demo', cookie);
    expect(seed.status).toBe(201);
    const { id } = (await seed.json()) as { id: string };

    const teardown = await authedRequest('DELETE', `/api/accounts/${id}?cascade=demo`, cookie);
    expect(teardown.status).toBe(204);

    // Containment again, for the reason given above, and the teardown is still
    // pinned on both counts: the account just seeded is gone by id, and no
    // sample account survives it at all. A teardown that deleted the wrong row,
    // or left a second demo account standing, still reds.
    const list = await authedRequest('GET', '/api/accounts', cookie);
    expect(list.status).toBe(200);
    const remaining = (await list.json()) as { id: string; isDemo: boolean }[];
    expect(remaining.map((account) => account.id)).not.toContain(id);
    expect(remaining.filter((account) => account.isDemo)).toEqual([]);
  });

  it('refuses a real account while the sample account exists, unaided', async () => {
    // Sample and real data are mutually exclusive for a reason that has nothing
    // to do with plans: every aggregate scopes by currency and not by account,
    // so invented figures alongside real ones land in the user's own totals.
    // With gating off there is no account cap to refuse the second account, so
    // reaching the 409 here is the exclusion guard firing by itself — which is
    // exactly the state a self-hosted install runs in.
    const cookie = await registerAndGetCookie();
    expect(isFeatureGatingEnabled()).toBe(false);
    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(201);

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DEMO_ACCOUNT_EXISTS');
  });
});
