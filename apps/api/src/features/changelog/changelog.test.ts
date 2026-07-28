/**
 * Changelog route integration tests (changelog Task 8; design Component 11).
 *
 * Real Postgres via `src/test-setup.ts` (rolled-back transaction per test),
 * routes driven through `app.request()`. The deterministic upstream is
 * `initChangelogCache(testLoader)` — the Task 6 reset seam. The real GitHub
 * loader is NEVER constructed here.
 *
 * FILE STRUCTURE IS PINNED — ordering is load-bearing. The service has no
 * de-init by design, so the fence test runs FIRST, before any seam init:
 * it proves the no-arg `initChangelogCache()` is a no-op under
 * `config.NODE_ENV === 'test'` and that the route then fails LOUDLY (500)
 * instead of silently arming live GitHub calls. Every other test initializes
 * the seam inside its own body — never a file-level beforeAll/beforeEach,
 * which would warm the seam out from under the fence.
 *
 * TTL-expiry mechanism (pinned): `stale` derives from
 * `now − fetchedAt ≥ RELEASES_TTL_MS` against non-injectable constants, and
 * re-init empties the cache — so the stale test warms the cache then mocks
 * `Date` ONLY (`vi.useFakeTimers({ toFake: ['Date'] })`). Never real-time
 * waits, never full fake timers (they would fake `setTimeout` under the live
 * Postgres connection — a flake hazard).
 *
 * Floor-test seeding (pinned): under the rolled-back-transaction harness,
 * Postgres `now()` is frozen at transaction start — a user registered via the
 * auth route gets `created_at = now()`, the same value `POST /viewed` writes,
 * so "advances the floor" would degenerate to equality. Floor-test users are
 * seeded via the back-dated direct-insert idiom (admin.test.ts `seedUser`)
 * and the assertions are strict inequalities.
 *
 * _Requirements: REQ-1.1, REQ-1.4, REQ-2.4, REQ-2.5, REQ-5(a)(1)–(5), REQ-6.2_
 */
import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangelogReleasesResponseSchema, type ChangelogRelease } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';

import { initChangelogCache } from './changelog.service';
import { RELEASES_TTL_MS } from './releases-cache';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail(tag: string) {
  return `changelog-it-${testRunId}-${++testCounter}-${tag}@example.com`;
}

let ipCounter = 100;
function uniqueIp() {
  return `10.9.0.${++ipCounter}`;
}

// Schema-valid release fixtures, already sorted desc by publishedAt (the
// client owns sorting in prod; the cache serves loader output as-is).
const RELEASE_NEW: ChangelogRelease = {
  id: '2',
  name: 'v2.0.0',
  tag: 'v2.0.0',
  publishedAt: '2026-02-01T00:00:00.000Z',
  body: 'Newer release notes.',
  htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v2.0.0',
  prerelease: false,
};
const RELEASE_OLD: ChangelogRelease = {
  id: '1',
  name: 'v1.0.0-rc.1',
  tag: 'v1.0.0-rc.1',
  publishedAt: '2026-01-01T00:00:00.000Z',
  body: 'Older release notes.',
  htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v1.0.0-rc.1',
  prerelease: true,
};
const FIXTURE_RELEASES: ChangelogRelease[] = [RELEASE_NEW, RELEASE_OLD];

/** Direct-insert user (admin.test.ts idiom) — supports back-dated createdAt. */
async function seedUser(opts: { createdAt?: Date } = {}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(users)
    .values({
      email: uniqueEmail('user'),
      passwordHash: `bcrypt-sentinel-${'x'.repeat(40)}`,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: users.id, createdAt: users.createdAt });
  return row!;
}

/** Direct-insert session; returns the plaintext cookie token. */
async function seedSession(userId: string): Promise<string> {
  const token = randomUUID();
  await db.insert(sessions).values({
    userId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + DAY_MS),
  });
  return token;
}

/** Back-dated user + session — the floor-test seeding idiom. */
async function seedBackdatedViewer(
  daysAgo = 30,
): Promise<{ userId: string; createdAt: Date; cookie: string }> {
  const user = await seedUser({ createdAt: new Date(Date.now() - daysAgo * DAY_MS) });
  const cookie = await seedSession(user.id);
  return { userId: user.id, createdAt: user.createdAt, cookie };
}

function authedRequest(method: string, path: string, cookie: string) {
  return app.request(path, {
    method,
    headers: {
      Cookie: `session=${cookie}`,
      'X-Forwarded-For': uniqueIp(),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('changelog routes', () => {
  // -------------------------------------------------------------------------
  // FENCE TEST — MUST STAY FIRST IN FILE (no seam init may precede it; the
  // service deliberately has no de-init, so a warmed seam cannot be undone).
  // -------------------------------------------------------------------------
  it('no-arg init is a no-op under test: GET /releases fails loud (500) and never touches fetch', async () => {
    // Mocked rejection (not pass-through) so that even a regressed fence
    // cannot reach the live network; the assertion is zero invocations.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('live network access attempted in test'));

    // The bootstrap path: under NODE_ENV=test this must NOT arm the real
    // GitHub loader.
    initChangelogCache();

    // Register via the auth route (dashboard.test.ts idiom) — registration
    // touches no seam; an unauthenticated hit would 401 before the fence.
    const email = uniqueEmail('fence');
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    expect(regRes.status).toBe(201);
    const cookie = regRes.headers
      .getSetCookie()
      .map((h) => h.match(/^session=([^;]*)/))
      .find((m) => m)?.[1];
    expect(cookie).toBeDefined();

    const res = await authedRequest('GET', '/api/changelog/releases', cookie!);
    // Loud failure: the ensure-fallback throw is a non-AppError, serialized
    // generically by errorHandler. Assert status + code, never message text.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');

    // No loader exists in this test — the only loader that COULD have run is
    // the real GitHub one, which is exactly the regression this fence guards.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Auth (REQ-1.1)
  // -------------------------------------------------------------------------
  it('unauthenticated requests to both endpoints return 401', async () => {
    const endpoints: Array<[string, string]> = [
      ['GET', '/api/changelog/releases'],
      ['POST', '/api/changelog/viewed'],
    ];
    for (const [method, path] of endpoints) {
      const res = await app.request(path, {
        method,
        headers: { 'X-Forwarded-For': uniqueIp() },
      });
      expect(res.status, `${method} ${path} should be 401 without auth`).toBe(401);
    }
  });

  // -------------------------------------------------------------------------
  // Contract shape (REQ-1.4, REQ-6.2)
  // -------------------------------------------------------------------------
  it('GET /releases returns a 200 envelope that parses against ChangelogReleasesResponseSchema', async () => {
    initChangelogCache(async () => FIXTURE_RELEASES);
    const { cookie } = await seedBackdatedViewer();

    const res = await authedRequest('GET', '/api/changelog/releases', cookie);
    expect(res.status).toBe(200);

    const body = ChangelogReleasesResponseSchema.parse(await res.json());
    expect(body.releases.map((r) => r.id)).toEqual(['2', '1']);
    // Sorted desc by publishedAt.
    for (let i = 1; i < body.releases.length; i++) {
      expect(Date.parse(body.releases[i - 1].publishedAt)).toBeGreaterThanOrEqual(
        Date.parse(body.releases[i].publishedAt),
      );
    }
    expect(body.stale).toBe(false);
    // fetchedAt is the snapshot time — schema already proved ISO datetime.
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
  });

  // -------------------------------------------------------------------------
  // Viewed-floor lifecycle (REQ-5(a)(1)–(3); Component 7)
  // -------------------------------------------------------------------------
  it('lastViewedAt floor equals the account-creation time before the first view', async () => {
    initChangelogCache(async () => FIXTURE_RELEASES);
    const { userId, createdAt, cookie } = await seedBackdatedViewer();

    const res = await authedRequest('GET', '/api/changelog/releases', cookie);
    expect(res.status).toBe(200);
    const body = ChangelogReleasesResponseSchema.parse(await res.json());
    expect(body.lastViewedAt).toBe(createdAt.toISOString());

    // GET is side-effect-free: the column is still NULL.
    const [row] = await db
      .select({ viewedAt: users.changelogViewedAt })
      .from(users)
      .where(eq(users.id, userId));
    expect(row.viewedAt).toBeNull();
  });

  it('POST /viewed updates users.changelog_viewed_at and advances the subsequent GET floor', async () => {
    initChangelogCache(async () => FIXTURE_RELEASES);
    const { userId, createdAt, cookie } = await seedBackdatedViewer();

    const postRes = await authedRequest('POST', '/api/changelog/viewed', cookie);
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { lastViewedAt: string };

    // Strict inequality — the seeded createdAt is back-dated, so equality
    // would mean the floor did not advance.
    expect(Date.parse(postBody.lastViewedAt)).toBeGreaterThan(createdAt.getTime());

    // The column was written with the returned value.
    const [row] = await db
      .select({ viewedAt: users.changelogViewedAt })
      .from(users)
      .where(eq(users.id, userId));
    expect(row.viewedAt?.toISOString()).toBe(postBody.lastViewedAt);

    // The subsequent GET serves the new floor.
    const getRes = await authedRequest('GET', '/api/changelog/releases', cookie);
    expect(getRes.status).toBe(200);
    const getBody = ChangelogReleasesResponseSchema.parse(await getRes.json());
    expect(getBody.lastViewedAt).toBe(postBody.lastViewedAt);
    expect(Date.parse(getBody.lastViewedAt)).toBeGreaterThan(createdAt.getTime());
  });

  // -------------------------------------------------------------------------
  // Per-user isolation (REQ-5(a)(4) at the contract level)
  // -------------------------------------------------------------------------
  it("user A's POST /viewed does not move user B's floor", async () => {
    initChangelogCache(async () => FIXTURE_RELEASES);
    const userA = await seedBackdatedViewer(30);
    const userB = await seedBackdatedViewer(20);

    const postRes = await authedRequest('POST', '/api/changelog/viewed', userA.cookie);
    expect(postRes.status).toBe(200);

    const resB = await authedRequest('GET', '/api/changelog/releases', userB.cookie);
    expect(resB.status).toBe(200);
    const bodyB = ChangelogReleasesResponseSchema.parse(await resB.json());
    expect(bodyB.lastViewedAt).toBe(userB.createdAt.toISOString());

    const [rowB] = await db
      .select({ viewedAt: users.changelogViewedAt })
      .from(users)
      .where(eq(users.id, userB.userId));
    expect(rowB.viewedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Degraded regimes (REQ-2.4, REQ-2.5)
  // -------------------------------------------------------------------------
  it('returns the coded 503 CHANGELOG_UNAVAILABLE envelope when the loader fails on an empty cache', async () => {
    // Re-init empties the cache: this loader fails before anything is cached.
    initChangelogCache(async () => {
      throw new Error('upstream down');
    });
    const { cookie } = await seedBackdatedViewer();

    const res = await authedRequest('GET', '/api/changelog/releases', cookie);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: unknown };
    };
    expect(body.error.code).toBe('CHANGELOG_UNAVAILABLE');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.requestId).toBeDefined();
  });

  it('serves the warm snapshot with stale: true when the TTL has expired and the loader fails', async () => {
    let loaderCalls = 0;
    let fail = false;
    initChangelogCache(async () => {
      loaderCalls++;
      if (fail) throw new Error('upstream down');
      return FIXTURE_RELEASES;
    });
    const { cookie } = await seedBackdatedViewer();

    // Warm the cache.
    const warmRes = await authedRequest('GET', '/api/changelog/releases', cookie);
    expect(warmRes.status).toBe(200);
    const warmBody = ChangelogReleasesResponseSchema.parse(await warmRes.json());
    expect(warmBody.stale).toBe(false);
    expect(loaderCalls).toBe(1);

    // Step Date (ONLY Date — full fake timers would fake setTimeout under
    // the live Postgres connection) past the TTL, then fail the loader.
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(realNow + RELEASES_TTL_MS + 1_000);
    fail = true;

    const staleRes = await authedRequest('GET', '/api/changelog/releases', cookie);
    expect(staleRes.status).toBe(200);
    const staleBody = ChangelogReleasesResponseSchema.parse(await staleRes.json());
    // The refresh was attempted (TTL expired), failed, and the warm snapshot
    // was still served — flagged stale.
    expect(loaderCalls).toBe(2);
    expect(staleBody.stale).toBe(true);
    expect(staleBody.releases.map((r) => r.id)).toEqual(['2', '1']);
    expect(staleBody.fetchedAt).toBe(warmBody.fetchedAt);
  });
});
