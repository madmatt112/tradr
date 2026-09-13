import { eq } from 'drizzle-orm';
import { beforeEach, describe, it, expect, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { positionTags, tags, users } from '@/db/schema';
import { setPositionTags } from '@/features/tags/tags.service';
import { captureServerEvent } from '@/lib/posthog';

// Post-commit analytics observability: replace only `captureServerEvent` so the
// tag_created / starter_tags_answered emits are assertable without a configured
// PostHog client (accounts.demo.test.ts:26-29 pattern).
vi.mock('@/lib/posthog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/posthog')>();
  return { ...actual, captureServerEvent: vi.fn() };
});

// The (event, opts) pairs captureServerEvent was called with since the last clear.
function captured(): Array<[string, { distinctId: string; properties?: Record<string, unknown> }]> {
  return vi.mocked(captureServerEvent).mock.calls.map(([event, opts]) => [String(event), opts]);
}

beforeEach(() => {
  vi.mocked(captureServerEvent).mockClear();
});

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `tags-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.98.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string; userId: string }> {
  const email = uniqueEmail();
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  expect(cookie).toBeDefined();
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { cookie, userId: user.id };
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

async function createTestAccount(cookie: string, name = 'Test Account', currency = 'USD') {
  const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestPosition(cookie: string, accountId: string) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('tags CRUD', () => {
  it('creates, lists, edits and deletes a tag', async () => {
    const { cookie } = await registerAndGetCookie();

    const createRes = await authedRequest('POST', '/api/tags', cookie, {
      name: 'breakout',
      category: 'setup',
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created).toMatchObject({ name: 'breakout', category: 'setup', color: null });
    expect(created.id).toBeDefined();

    const listRes = await authedRequest('GET', '/api/tags', cookie);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'breakout', category: 'setup', positionCount: 0 });

    const putRes = await authedRequest('PUT', `/api/tags/${created.id}`, cookie, {
      name: 'pullback',
      color: 'tag-2',
    });
    expect(putRes.status).toBe(200);
    const edited = await putRes.json();
    expect(edited).toMatchObject({ name: 'pullback', category: 'setup', color: 'tag-2' });

    const delRes = await authedRequest('DELETE', `/api/tags/${created.id}`, cookie);
    expect(delRes.status).toBe(204);

    const emptyRes = await authedRequest('GET', '/api/tags', cookie);
    expect(await emptyRes.json()).toHaveLength(0);
  });

  it('rejects a duplicate name case-insensitively across categories on create', async () => {
    const { cookie } = await registerAndGetCookie();
    const first = await authedRequest('POST', '/api/tags', cookie, {
      name: 'Breakout',
      category: 'setup',
    });
    expect(first.status).toBe(201);

    const dup = await authedRequest('POST', '/api/tags', cookie, {
      name: 'breakout',
      category: 'mistake',
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe('TAG_NAME_TAKEN');
  });

  it('rejects a rename that collides case-insensitively across categories', async () => {
    const { cookie } = await registerAndGetCookie();
    const a = await (
      await authedRequest('POST', '/api/tags', cookie, { name: 'calm', category: 'emotion' })
    ).json();
    const b = await (
      await authedRequest('POST', '/api/tags', cookie, { name: 'anxious', category: 'emotion' })
    ).json();

    const collide = await authedRequest('PUT', `/api/tags/${b.id}`, cookie, {
      name: 'CALM',
      category: 'mistake',
    });
    expect(collide.status).toBe(409);
    expect((await collide.json()).error.code).toBe('TAG_NAME_TAKEN');
    expect(a.id).not.toBe(b.id);
  });

  it('allows a case-only self-rename (fomo -> FOMO)', async () => {
    const { cookie } = await registerAndGetCookie();
    const tag = await (
      await authedRequest('POST', '/api/tags', cookie, { name: 'fomo', category: 'emotion' })
    ).json();

    const res = await authedRequest('PUT', `/api/tags/${tag.id}`, cookie, { name: 'FOMO' });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('FOMO');
  });

  it('enforces the per-user cap of 200', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    // Bulk-insert 199 tags directly, then the API create is the 200th.
    await db.insert(tags).values(
      Array.from({ length: 199 }, (_, i) => ({
        userId,
        name: `cap-tag-${i}`,
        category: 'general',
      })),
    );

    const ok = await authedRequest('POST', '/api/tags', cookie, {
      name: 'the-200th',
      category: 'general',
    });
    expect(ok.status).toBe(201);

    const over = await authedRequest('POST', '/api/tags', cookie, {
      name: 'the-201st',
      category: 'general',
    });
    expect(over.status).toBe(409);
    expect((await over.json()).error.code).toBe('TAG_LIMIT_REACHED');
  });

  it("returns 404 for another user's tag on PUT and DELETE", async () => {
    const owner = await registerAndGetCookie();
    const other = await registerAndGetCookie();
    const tag = await (
      await authedRequest('POST', '/api/tags', owner.cookie, { name: 'mine', category: 'setup' })
    ).json();

    const put = await authedRequest('PUT', `/api/tags/${tag.id}`, other.cookie, { name: 'stolen' });
    expect(put.status).toBe(404);

    const del = await authedRequest('DELETE', `/api/tags/${tag.id}`, other.cookie);
    expect(del.status).toBe(404);
  });

  it("deleting a tag removes its join rows but leaves the position's other tags", async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const position = await createTestPosition(cookie, account.id);
    const tag1 = await (
      await authedRequest('POST', '/api/tags', cookie, { name: 'keep', category: 'setup' })
    ).json();
    const tag2 = await (
      await authedRequest('POST', '/api/tags', cookie, { name: 'drop', category: 'setup' })
    ).json();

    await setPositionTags(db, position.id, userId, [tag1.id, tag2.id]);

    const del = await authedRequest('DELETE', `/api/tags/${tag2.id}`, cookie);
    expect(del.status).toBe(204);

    const joins = await db
      .select()
      .from(positionTags)
      .where(eq(positionTags.positionId, position.id));
    expect(joins.map((j) => j.tagId)).toEqual([tag1.id]);
  });

  it('lists tags in category-then-name order with position counts', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const position = await createTestPosition(cookie, account.id);

    const mk = async (name: string, category: string) =>
      (await authedRequest('POST', '/api/tags', cookie, { name, category })).json();
    const zebra = await mk('zebra', 'setup');
    await mk('alpha', 'setup');
    await mk('calm', 'emotion');
    await mk('no plan', 'mistake');
    await mk('misc', 'general');

    await setPositionTags(db, position.id, userId, [zebra.id]);

    const list = await (await authedRequest('GET', '/api/tags', cookie)).json();
    expect(list.map((t: { name: string }) => t.name)).toEqual([
      'alpha',
      'zebra',
      'calm',
      'no plan',
      'misc',
    ]);
    expect(list.map((t: { category: string }) => t.category)).toEqual([
      'setup',
      'setup',
      'emotion',
      'mistake',
      'general',
    ]);
    const zebraRow = list.find((t: { name: string }) => t.name === 'zebra');
    expect(zebraRow.positionCount).toBe(1);
    const alphaRow = list.find((t: { name: string }) => t.name === 'alpha');
    expect(alphaRow.positionCount).toBe(0);
  });
});

describe('starter tags offer', () => {
  it('accept creates sixteen and records the answer on onboarding', async () => {
    const { cookie } = await registerAndGetCookie();

    const res = await authedRequest('POST', '/api/tags/starter', cookie, { answer: 'accept' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBe('accept');
    expect(body.created).toHaveLength(16);

    const list = await (await authedRequest('GET', '/api/tags', cookie)).json();
    expect(list).toHaveLength(16);

    const onboarding = await (
      await authedRequest('GET', '/api/users/me/onboarding', cookie)
    ).json();
    expect(onboarding.starterTagsAnsweredAt).toBeDefined();
  });

  it('a second accept is idempotent by name (created empty, no duplicates)', async () => {
    const { cookie } = await registerAndGetCookie();
    await authedRequest('POST', '/api/tags/starter', cookie, { answer: 'accept' });

    const second = await authedRequest('POST', '/api/tags/starter', cookie, { answer: 'accept' });
    expect(second.status).toBe(200);
    expect((await second.json()).created).toEqual([]);

    const list = await (await authedRequest('GET', '/api/tags', cookie)).json();
    expect(list).toHaveLength(16);
  });

  it('decline creates nothing but records the answer', async () => {
    const { cookie } = await registerAndGetCookie();

    const res = await authedRequest('POST', '/api/tags/starter', cookie, { answer: 'decline' });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toEqual([]);

    const list = await (await authedRequest('GET', '/api/tags', cookie)).json();
    expect(list).toHaveLength(0);

    const onboarding = await (
      await authedRequest('GET', '/api/users/me/onboarding', cookie)
    ).json();
    expect(onboarding.starterTagsAnsweredAt).toBeDefined();
  });

  it('rejects an invalid answer with 400', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/tags/starter', cookie, { answer: 'maybe' });
    expect(res.status).toBe(400);
  });
});

describe('tags telemetry carries no tag names', () => {
  it('emits tag_created with only category and starter_tags_answered with only outcome', async () => {
    const { cookie } = await registerAndGetCookie();

    await authedRequest('POST', '/api/tags', cookie, { name: 'secret-name', category: 'setup' });
    await authedRequest('POST', '/api/tags/starter', cookie, { answer: 'accept' });

    const calls = captured();
    const createdCall = calls.find(([e]) => e === 'tag_created');
    expect(createdCall).toBeDefined();
    expect(createdCall![1].properties).toEqual({ category: 'setup' });

    const answeredCall = calls.find(([e]) => e === 'starter_tags_answered');
    expect(answeredCall).toBeDefined();
    expect(answeredCall![1].properties).toEqual({ outcome: 'accepted' });

    for (const [, opts] of calls) {
      expect(opts.properties ?? {}).not.toHaveProperty('name');
    }
  });
});
