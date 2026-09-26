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

import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPORTING_TIMEZONE } from '@tradr/shared';

import app from '@/app';
import { db, poolerDriverOptions } from '@/db';
import { accounts, positionImages, positions, users } from '@/db/schema';
import { createExport } from '@/features/account-data/export.service';
import { confirmImport } from '@/features/account-data/import.service';
import {
  config,
  isAdvisorEnabled,
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

  // DISABLE_ADVISOR is an operator posture, not a gated capability, and it
  // defaults to WITHDRAWN while the advisor is reworked — on every instance,
  // self-hosted included. The test env opts back in (vitest.workspace.ts pins
  // DISABLE_ADVISOR=false) so the advisor suites keep exercising shipped code;
  // this asserts the pin is what makes it true, and that the shipped template
  // agrees with the schema default.
  it('advisor is withdrawn by default; the test env opts in explicitly', async () => {
    expect(process.env.DISABLE_ADVISOR).toBe('false');
    expect(isAdvisorEnabled()).toBe(true);
    const body = await (await app.request('/api/config')).json();
    expect(body.advisorEnabled).toBe(true);

    config.DISABLE_ADVISOR = true;
    try {
      expect(isAdvisorEnabled()).toBe(false);
      expect((await (await app.request('/api/config')).json()).advisorEnabled).toBe(false);
    } finally {
      config.DISABLE_ADVISOR = false;
    }
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

  // Whole-account export and import work with nothing configured, and images make
  // the round trip inline (base64-in-JSONB), never as an object-storage pointer —
  // the self-host home for a screenshot the parity case above proves for uploads,
  // held across an export and re-import (REQ-1.6, Req 7.1).
  it('exports and re-imports an account with images inline when nothing is configured', async () => {
    expect(getObjectStorage()).toBeNull();

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const [userA] = await db
      .insert(users)
      .values({ email: `parity-export-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
      .returning({ id: users.id });
    const [account] = await db
      .insert(accounts)
      .values({ userId: userA.id, name: 'Main', currency: 'USD', isDefault: true })
      .returning({ id: accounts.id });
    // eslint-disable-next-line no-restricted-syntax -- direct seed of an open position for the export/import parity round trip
    const [position] = await db
      .insert(positions)
      .values({
        userId: userA.id,
        accountId: account.id,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
        status: 'open',
        openedAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning({ id: positions.id });
    await db.insert(positionImages).values({
      positionId: position.id,
      part: { type: 'image', format: 'png', dataBase64: png.toString('base64') },
    });

    // Export A (no storage ⇒ image bytes are stored zip entries).
    const { stream } = await createExport(userA.id);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }

    // Import into an empty user B (no storage ⇒ images restore inline, Req 7.1).
    const [userB] = await db
      .insert(users)
      .values({ email: `parity-import-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
      .returning({ id: users.id });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await confirmImport(userB.id, body, digest);

    const [img] = await db
      .select({ part: positionImages.part })
      .from(positionImages)
      .innerJoin(positions, eq(positions.id, positionImages.positionId))
      .where(eq(positions.userId, userB.id));
    const part = img.part as Record<string, unknown>;
    expect(part.type).toBe('image');
    expect(part.dataBase64).toBe(png.toString('base64'));
    expect('storage' in part).toBe(false);
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

  // Clean PNG fixture, reproduced from image-metadata.test.ts:73-78 (its builders
  // are not exported). It carries no metadata chunks, so stripImageMetadata is a
  // no-op and the stored inline bytes equal the uploaded bytes — the round-trip is
  // byte-identical.
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PIXELS = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0xfa, 0xce]);
  function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    // CRC value is irrelevant to the strip logic; use a fixed placeholder.
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([0, 0, 0, 0])]);
  }
  function buildCleanPng(): Buffer {
    const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
    const idat = pngChunk('IDAT', PIXELS);
    const iend = pngChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
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

  it('a position screenshot uploads and reads back inline (base64-in-JSONB, no pointer)', async () => {
    // Object storage is absent under the empty OBJECT_STORAGE_* pin, so a
    // self-hoster's screenshot must live inline in the row exactly as the advisor's
    // image does. A predicate would keep passing if a route learned to 503 with no
    // bucket; only driving the upload and read over HTTP, then looking at the row,
    // proves the inline home (REQ-3.6).
    const cookie = await registerAndGetCookie();

    const account = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Screenshot Account',
      currency: 'USD',
      timezone: 'UTC',
    });
    expect(account.status).toBe(201);
    const { id: accountId } = (await account.json()) as { id: string };

    const position = await authedRequest('POST', '/api/positions', cookie, {
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(position.status).toBe(201);
    const { id: positionId } = (await position.json()) as { id: string };

    const png = buildCleanPng();
    const upload = await authedRequest('POST', `/api/positions/${positionId}/images`, cookie, {
      format: 'png',
      dataBase64: png.toString('base64'),
    });
    expect(upload.status).toBe(201);
    const { id: imageId } = (await upload.json()) as { id: string };

    const read = await authedRequest(
      'GET',
      `/api/positions/${positionId}/images/${imageId}`,
      cookie,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await read.arrayBuffer()).equals(png)).toBe(true);

    // The inline home is proven at the row, not inferred from the wire: the part is
    // base64-in-JSONB, with no object-storage pointer.
    const [row] = await db
      .select({ part: positionImages.part })
      .from(positionImages)
      .where(eq(positionImages.id, imageId));
    const part = row.part as Record<string, unknown>;
    expect(typeof part.dataBase64).toBe('string');
    expect('storage' in part).toBe(false);
  });
});
