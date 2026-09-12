import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { TAG_LIMITS } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { positionTags, tags, users } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import {
  replaceCloseHook,
  unregisterCloseHook,
  replaceReverseHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';

// --- Harness (own copies of positions.test.ts:1-70) -------------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `postags-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.97.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
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

async function createTestAccount(cookie: string, name = 'Test Account', timezone = 'UTC') {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name,
    currency: 'USD',
    timezone,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestPosition(
  cookie: string,
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTag(cookie: string, name: string, category = 'setup') {
  const res = await authedRequest('POST', '/api/tags', cookie, { name, category });
  expect(res.status).toBe(201);
  return res.json();
}

async function addFill(
  cookie: string,
  positionId: string,
  data: { type: string; price: string; quantity: string; filledAt: string },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

/** Draft → open (one entry fill). */
async function openPosition(cookie: string, accountId: string, overrides = {}) {
  const pos = await createTestPosition(cookie, accountId, overrides);
  await addFill(cookie, pos.id, {
    type: 'entry',
    price: '10',
    quantity: '100',
    filledAt: '2025-01-15T15:00:00Z',
  });
  const res = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {
    openedAt: '2025-01-15T15:00:00Z',
  });
  expect(res.status).toBe(200);
  return pos;
}

/** Draft → open → closed (full exit auto-closes; same NY day so reopen is allowed). */
async function closedPosition(cookie: string, accountId: string, overrides = {}) {
  const pos = await openPosition(cookie, accountId, overrides);
  await addFill(cookie, pos.id, {
    type: 'exit',
    price: '11',
    quantity: '100',
    filledAt: '2025-01-15T18:00:00Z',
  });
  const detail = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
  expect(detail.status).toBe('closed');
  return pos;
}

async function setTags(cookie: string, positionId: string, tagIds: string[]) {
  return authedRequest('PUT', `/api/positions/${positionId}/tags`, cookie, { tagIds });
}

async function readTags(cookie: string, positionId: string): Promise<Array<{ id: string }>> {
  const res = await authedRequest('GET', `/api/positions/${positionId}`, cookie);
  expect(res.status).toBe(200);
  return (await res.json()).tags;
}

// The close/reverse ledger hooks are cleared cross-file by test-setup, so
// re-register them here (positions.test.ts pattern) — close and reopen drive
// them, and the demo seed closes trades.
beforeAll(() => {
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
});
afterAll(() => {
  unregisterCloseHook('ledger');
  unregisterReverseHook('ledger');
});

describe('PUT /api/positions/:id/tags', () => {
  it('replaces the tag set on a draft, an open and a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');

    const draft = await createTestPosition(cookie, account.id, { symbol: 'AAA' });
    const open = await openPosition(cookie, account.id, { symbol: 'BBB' });
    const closed = await closedPosition(cookie, account.id, { symbol: 'CCC' });

    for (const pos of [draft, open, closed]) {
      const res = await setTags(cookie, pos.id, [a.id, b.id]);
      expect(res.status).toBe(200);
      const returned = await res.json();
      expect(returned.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
      expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    }
  });

  it('tags a position on a demo account', async () => {
    const { cookie } = await registerAndGetCookie();
    const demoRes = await authedRequest('POST', '/api/accounts/demo', cookie);
    expect(demoRes.status).toBe(201);
    const demo = await demoRes.json();
    expect(demo.isDemo).toBe(true);

    const list = await (
      await authedRequest('GET', `/api/positions?accountId=${demo.id}`, cookie)
    ).json();
    expect(list.length).toBeGreaterThan(0);

    const tag = await createTag(cookie, 'demo-tag');
    const res = await setTags(cookie, list[0].id, [tag.id]);
    expect(res.status).toBe(200);
    expect((await res.json()).map((t: { id: string }) => t.id)).toEqual([tag.id]);
  });

  it('is replace-set, not merge', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');
    const c = await createTag(cookie, 'c');

    await setTags(cookie, pos.id, [a.id, b.id]);
    const res = await setTags(cookie, pos.id, [b.id, c.id]);
    expect(res.status).toBe(200);
    expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([b.id, c.id].sort());
  });

  it('collapses duplicate ids to one join row', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);
    const a = await createTag(cookie, 'a');

    const res = await setTags(cookie, pos.id, [a.id, a.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(await readTags(cookie, pos.id)).toHaveLength(1);
  });

  it('404s on a foreign tag id and leaves the previous set unchanged', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');
    await setTags(cookie, pos.id, [a.id, b.id]);

    const foreign = '00000000-0000-0000-0000-000000000000';
    const res = await setTags(cookie, pos.id, [b.id, foreign]);
    expect(res.status).toBe(404);
    expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('checks ownership before the cap: a foreign id in an over-cap body 404s', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const owned = await db
      .insert(tags)
      .values(
        Array.from({ length: TAG_LIMITS.perPosition }, (_, i) => ({
          userId,
          name: `cap-${i}`,
          category: 'general' as const,
        })),
      )
      .returning({ id: tags.id });
    const foreign = '00000000-0000-0000-0000-000000000000';

    const res = await setTags(cookie, pos.id, [...owned.map((t) => t.id), foreign]);
    expect(res.status).toBe(404);
  });

  it('409s TAG_LIMIT_REACHED on more owned ids than the per-position cap', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const owned = await db
      .insert(tags)
      .values(
        Array.from({ length: TAG_LIMITS.perPosition + 1 }, (_, i) => ({
          userId,
          name: `over-${i}`,
          category: 'general' as const,
        })),
      )
      .returning({ id: tags.id });

    const res = await setTags(
      cookie,
      pos.id,
      owned.map((t) => t.id),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('TAG_LIMIT_REACHED');
  });

  it('deleting a position removes join rows but leaves the tags themselves', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);
    const a = await createTag(cookie, 'a');
    await setTags(cookie, pos.id, [a.id]);

    const del = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(del.status).toBe(204);

    const joins = await db.select().from(positionTags).where(eq(positionTags.positionId, pos.id));
    expect(joins).toHaveLength(0);

    const list = await (await authedRequest('GET', '/api/tags', cookie)).json();
    expect(list.map((t: { id: string }) => t.id)).toContain(a.id);
  });
});

describe('position lifecycle leaves the tag set untouched', () => {
  it('survives notes edit, open, close and reopen', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'TZ', 'America/New_York');
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');

    // Draft, tagged, then edit notes.
    const pos = await createTestPosition(cookie, account.id);
    await setTags(cookie, pos.id, [a.id, b.id]);
    const notesRes = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      notes: 'a plan',
    });
    expect(notesRes.status).toBe(200);
    expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

    // Open.
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-15T15:00:00Z',
    });
    const openRes = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {
      openedAt: '2025-01-15T15:00:00Z',
    });
    expect(openRes.status).toBe(200);
    expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

    // Close (full exit auto-closes).
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '11',
      quantity: '100',
      filledAt: '2025-01-15T18:00:00Z',
    });
    expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());

    // Reopen (same NY day).
    const reopenRes = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T20:00:00Z',
    });
    expect(reopenRes.status).toBe(200);
    expect((await readTags(cookie, pos.id)).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('still 409s on a restricted field (symbol) edit of an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await openPosition(cookie, account.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, { symbol: 'TSLA' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/positions tag filter and tags payload', () => {
  it('filters with AND semantics and carries tags on each row', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');

    const posA = await createTestPosition(cookie, account.id, { symbol: 'AAA' });
    const posAB = await createTestPosition(cookie, account.id, { symbol: 'BBB' });
    const posB = await createTestPosition(cookie, account.id, { symbol: 'CCC' });
    await setTags(cookie, posA.id, [a.id]);
    await setTags(cookie, posAB.id, [a.id, b.id]);
    await setTags(cookie, posB.id, [b.id]);

    const byA = await (await authedRequest('GET', `/api/positions?tag=${a.id}`, cookie)).json();
    expect(byA.map((p: { symbol: string }) => p.symbol).sort()).toEqual(['AAA', 'BBB']);

    const byAB = await (
      await authedRequest('GET', `/api/positions?tag=${a.id},${b.id}`, cookie)
    ).json();
    expect(byAB.map((p: { symbol: string }) => p.symbol)).toEqual(['BBB']);

    // Each row carries its own tags array.
    const row = byAB[0];
    expect(row.tags.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns [] for a foreign tag id and ignores non-UUID elements', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const a = await createTag(cookie, 'a');
    const pos = await createTestPosition(cookie, account.id, { symbol: 'AAA' });
    await setTags(cookie, pos.id, [a.id]);

    const foreign = '11111111-1111-1111-1111-111111111111';
    const none = await (await authedRequest('GET', `/api/positions?tag=${foreign}`, cookie)).json();
    expect(none).toEqual([]);

    // "abc" is not a UUID → dropped; the remaining valid id still filters.
    const kept = await (
      await authedRequest('GET', `/api/positions?tag=abc,${a.id}`, cookie)
    ).json();
    expect(kept.map((p: { symbol: string }) => p.symbol)).toEqual(['AAA']);
  });

  it('combines the tag filter with status', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const a = await createTag(cookie, 'a');

    const draft = await createTestPosition(cookie, account.id, { symbol: 'DFT' });
    const closed = await closedPosition(cookie, account.id, { symbol: 'CLS' });
    await setTags(cookie, draft.id, [a.id]);
    await setTags(cookie, closed.id, [a.id]);

    const res = await (
      await authedRequest('GET', `/api/positions?tag=${a.id}&status=closed`, cookie)
    ).json();
    expect(res.map((p: { symbol: string }) => p.symbol)).toEqual(['CLS']);
  });

  it('still 400s on a malformed accountId', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('GET', '/api/positions?accountId=not-a-uuid', cookie);
    expect(res.status).toBe(400);
  });

  it('orders tags category-then-name on the list and on the detail', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const zebra = await createTag(cookie, 'zebra', 'setup');
    const alpha = await createTag(cookie, 'alpha', 'setup');
    const calm = await createTag(cookie, 'calm', 'emotion');

    const pos = await createTestPosition(cookie, account.id, { symbol: 'ORD' });
    await setTags(cookie, pos.id, [zebra.id, alpha.id, calm.id]);

    const expectedNames = ['alpha', 'zebra', 'calm'];
    const expectedCats = ['setup', 'setup', 'emotion'];

    const list = await (await authedRequest('GET', '/api/positions', cookie)).json();
    const listRow = list.find((p: { id: string }) => p.id === pos.id);
    expect(listRow.tags.map((t: { name: string }) => t.name)).toEqual(expectedNames);
    expect(listRow.tags.map((t: { category: string }) => t.category)).toEqual(expectedCats);

    const detail = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
    expect(detail.tags.map((t: { name: string }) => t.name)).toEqual(expectedNames);
    expect(detail.tags.map((t: { category: string }) => t.category)).toEqual(expectedCats);
  });
});
