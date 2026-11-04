/**
 * Group create/link/unlink/label routes (design C4, C5; multi-leg-positions
 * task 5). Black-box over `/api/position-groups*`, matching the house style
 * of `positions.test.ts`.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * AC 1.1 (create, legs land open)
 *   Pre: an account, no positions.
 *   Call: POST /api/position-groups with 3 legs sharing one fill date.
 *   Result: 201; every leg status 'open'; every leg's openedAt equals the
 *     fill date; group carries all 3 legs.
 *   Source: requirements.md AC 1.1 ("every leg ... open" / "its fill").
 *
 * AC 1.2 x3 (create, bad leg set named by index, nothing written)
 *   Pre: an account.
 *   Call: POST /api/position-groups with a bad-OCC / repeated-symbol /
 *     differing-underlying leg at index 1.
 *   Result: 400, VALIDATION_ERROR, details.legIndex '1', message matches
 *     `validateLegSet`'s pinned text; position count for the user unchanged.
 *   Source: requirements.md AC 1.2; design Error Handling 1; the exact
 *     message strings read from `packages/shared/src/lib/strategy.ts`
 *     (validateLegSet), already shipped by an earlier task.
 *
 * AC 1.1/NFR Security (create, foreign account)
 *   Pre: a legs array naming an accountId that does not exist.
 *   Call: POST /api/position-groups.
 *   Result: 404; position count for the user unchanged.
 *   Source: NFR Security ("a foreign id SHALL return not found").
 *
 * AC 1.3 (batched L2 cap, refuse-whole-batch / exactly-at-cap)
 *   Pre: gating on; user seeded at (cap-1) positions.
 *   Call: POST /api/position-groups with 2 legs (cap-1+2 > cap).
 *   Result: 403 TIER_LIMIT_POSITIONS; position count unchanged.
 *   Source: requirements.md AC 1.3 ("positionCount + legs > limit").
 *   A second case seeds (cap-2) and the same 2-leg create (cap-2+2 = cap)
 *   passes with 201.
 *
 * AC 1.3 (L1 writability)
 *   Pre: gating on, over the account cap, designation on account B.
 *   Call: POST /api/position-groups targeting account A.
 *   Result: 403 TIER_ACCOUNT_NOT_WRITABLE.
 *   Source: requirements.md AC 1.3, reusing createPosition's L1 rule.
 *
 * AC 1.4/D6 (link open-or-closed legs, no fill/ledger row, updatedAt held)
 *   Pre: one open and one closed position, same account/underlying.
 *   Call: POST /api/position-groups/link.
 *   Result: 201 group with both legs; fills/ledger row counts unchanged;
 *     each leg's updatedAt unchanged from before the link.
 *   Source: requirements.md AC 1.4; design D6 and C4 linkPositionsTx.
 *
 * AC 1.2 via 1.4 (link, differing accounts named by index)
 *   Pre: two open positions, same underlying, different accounts.
 *   Call: POST /api/position-groups/link.
 *   Result: 400 VALIDATION_ERROR, details.legIndex '1'.
 *   Source: requirements.md AC 1.2 ("differ in account ... name the leg").
 *
 * Error Handling 2 x2 (link refuses draft / already-grouped, names symbol)
 *   Pre: a draft position (no entry fill) / a leg already in another group.
 *   Call: POST /api/position-groups/link.
 *   Result: 409; message contains the offending leg's symbol.
 *   Source: design Error Handling 2.
 *
 * AC 1.4 + Error Handling 8 (add-leg 8-leg cap)
 *   Pre: a group at 8 legs.
 *   Call: POST /api/position-groups/:id/legs with a 9th.
 *   Result: 400, message names the cap (8), details carries no legIndex.
 *   Source: design Error Handling 8.
 *
 * AC 1.5 (unlink; dissolve at one leg)
 *   Pre: a 3-leg group.
 *   Call: DELETE /api/position-groups/:id/legs/:positionId, twice.
 *   Result: first unlink leaves a 2-leg group; the unlinked leg reads with
 *     no groupId; the second unlink (down to 1) dissolves the group — the
 *     remaining leg reads as a plain, ungrouped position.
 *   Source: requirements.md AC 1.5.
 *
 * AC 2.4 (label override set/clear)
 *   Pre: a 2-leg BCS group, no override.
 *   Call: PATCH /api/position-groups/:id with a padded override, then null.
 *   Result: label/labelOverride reflect the trimmed override; clearing
 *     returns the detected label ('BCS', requirements.md AC 2.1 table).
 *   Source: requirements.md AC 2.4.
 *
 * AC 2.5 (label follows current legs, no override)
 *   Pre: a 2-leg BCS group, no override.
 *   Call: POST /api/position-groups/:id/legs adds a third leg.
 *   Result: the group's label reads 'Multi-leg' (3 legs is undetected) with
 *     no override in play.
 *   Source: requirements.md AC 2.5; strategy.ts detectStrategyLabel (only
 *     2- and 4-leg sets are detected).
 *
 * AC 3.3 (linking leaves account position value unchanged)
 *   Pre: two open option legs, same account/underlying.
 *   Call: POST /api/position-groups/link.
 *   Result: GET /api/accounts/:id .positionValue is the same before and
 *     after the link.
 *   Source: requirements.md AC 3.3 (invariant).
 *
 * NFR Security x2 (foreign ids 404, folded across routes)
 *   Pre: user A's group / user A's ungrouped position.
 *   Call (as user B): add-leg / patch / delete-leg against A's group id;
 *     link / add-leg against A's position id.
 *   Result: 404 on every call, before any write.
 *   Source: requirements.md NFR Security.
 *
 * Not covered here (doc-only, no code path): AC 10.1's dated note in
 * `specs/options-tools/requirements.md` — see the task report.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { fills, ledgerEntries, positions } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import * as positionsQuery from '@/features/positions/positions.query';
import {
  replaceCloseHook,
  unregisterCloseHook,
  replaceReverseHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';
import { config } from '@/lib/config';

let testCounter = 0;
function uniqueEmail() {
  return `posgroup-test${Date.now()}-${++testCounter}@example.com`;
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
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  const meRes = await app.request('/api/auth/me', {
    headers: { Cookie: `session=${cookie}` },
  });
  const me = await meRes.json();
  return { cookie, userId: me.id };
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

async function createTestAccount(cookie: string, name = 'Test Account') {
  const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency: 'USD' });
  expect(res.status).toBe(201);
  return res.json();
}

async function createDraftPosition(
  cookie: string,
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL260116C100',
    side: 'long',
    assetType: 'option',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function addFill(
  cookie: string,
  positionId: string,
  data: { type: string; price: string; quantity: string; fees?: string; filledAt: string },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

async function openTestPosition(cookie: string, positionId: string, openedAt?: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {
    openedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

/** An open leg: draft → entry fill → open. */
async function createOpenLeg(
  cookie: string,
  accountId: string,
  symbol: string,
  overrides: { side?: string; quantity?: string; price?: string; filledAt?: string } = {},
) {
  const side = overrides.side ?? 'long';
  const quantity = overrides.quantity ?? '1';
  const price = overrides.price ?? '5';
  const filledAt = overrides.filledAt ?? '2025-01-01T00:00:00.000Z';
  const pos = await createDraftPosition(cookie, accountId, { symbol, side, assetType: 'option' });
  await addFill(cookie, pos.id, { type: 'entry', price, quantity, fees: '0', filledAt });
  return openTestPosition(cookie, pos.id, filledAt);
}

/** A closed leg: open leg → full exit (auto-closes, R7 amendment). */
async function createClosedLeg(
  cookie: string,
  accountId: string,
  symbol: string,
  overrides: { side?: string; quantity?: string; price?: string } = {},
) {
  const quantity = overrides.quantity ?? '1';
  const opened = await createOpenLeg(cookie, accountId, symbol, { ...overrides, quantity });
  await addFill(cookie, opened.id, {
    type: 'exit',
    price: overrides.price ?? '7',
    quantity,
    fees: '0',
    filledAt: '2025-01-02T00:00:00.000Z',
  });
  const res = await authedRequest('GET', `/api/positions/${opened.id}`, cookie);
  return res.json();
}

async function countPositionsForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.userId, userId));
  return row?.count ?? 0;
}

async function countFillsAndLedgerRows(positionIds: string[]): Promise<{
  fillCount: number;
  ledgerCount: number;
}> {
  const [fillRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fills)
    .where(
      sql`${fills.positionId} IN (${sql.join(
        positionIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const [ledgerRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(
      sql`${ledgerEntries.positionId} IN (${sql.join(
        positionIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  return { fillCount: fillRow?.count ?? 0, ledgerCount: ledgerRow?.count ?? 0 };
}

async function seedRawPositions(userId: string, accountId: string, count: number) {
  if (count <= 0) return;
  const rows = Array.from({ length: count }, (_, i) => ({
    userId,
    accountId,
    symbol: `SEED${i}`,
    side: 'long',
    assetType: 'equity',
    status: 'open',
  }));
  // performance-charts §8.2 audit: status='open' is CHECK-safe.
  // eslint-disable-next-line no-restricted-syntax
  await db.insert(positions).values(rows);
}

describe('position-groups create (AC 1.1, 1.2, 1.3, NFR Security)', () => {
  it('creates a group of 3 legs, each open with its entry fill at the fill date', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const filledAt = '2025-03-01T00:00:00.000Z';

    const res = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt,
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
        {
          symbol: 'AAPL260116C120',
          side: 'long',
          assetType: 'option',
          quantity: '1',
          price: '1',
        },
      ],
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe('group');
    expect(body.legs).toHaveLength(3);
    for (const leg of body.legs) {
      expect(leg.status).toBe('open');
      expect(new Date(leg.openedAt).toISOString()).toBe(new Date(filledAt).toISOString());
    }
  });

  it('refuses a bad OCC symbol at leg 1, naming it, and writes nothing', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const before = await countPositionsForUser(userId);

    const res = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        { symbol: 'NOTOCC', side: 'short', assetType: 'option', quantity: '1', price: '2' },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.legIndex).toBe('1');
    expect(body.error.message).toBe("Leg 2's symbol is not a valid OCC contract.");
    expect(await countPositionsForUser(userId)).toBe(before);
  });

  it('refuses a repeated symbol at leg 1, naming it, and writes nothing', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const before = await countPositionsForUser(userId);

    const res = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C100',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.legIndex).toBe('1');
    expect(body.error.message).toBe('Leg 2 repeats a symbol already in this group.');
    expect(await countPositionsForUser(userId)).toBe(before);
  });

  it('refuses a differing underlying at leg 1, naming it, and writes nothing', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const before = await countPositionsForUser(userId);

    const res = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'MSFT260116C100',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.legIndex).toBe('1');
    expect(body.error.message).toBe("Leg 2's underlying differs from the group's.");
    expect(await countPositionsForUser(userId)).toBe(before);
  });

  it('refuses a foreign account id with 404 and writes nothing', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const before = await countPositionsForUser(userId);

    const res = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: '00000000-0000-0000-0000-000000000000',
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(await countPositionsForUser(userId)).toBe(before);
  });

  it('refuses the whole batch over the L2 cap, writing nothing', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const cap = getTierLimits('free').positions!;
    await seedRawPositions(userId, account.id, cap - 1);

    config.FEATURE_GATING = true;
    try {
      const before = await countPositionsForUser(userId);
      const res = await authedRequest('POST', '/api/position-groups', cookie, {
        accountId: account.id,
        filledAt: '2025-03-01T00:00:00.000Z',
        legs: [
          {
            symbol: 'AAPL260116C100',
            side: 'long',
            assetType: 'option',
            quantity: '1',
            price: '5',
          },
          {
            symbol: 'AAPL260116C110',
            side: 'short',
            assetType: 'option',
            quantity: '1',
            price: '2',
          },
        ],
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('TIER_LIMIT_POSITIONS');
      expect(await countPositionsForUser(userId)).toBe(before);
    } finally {
      config.FEATURE_GATING = false;
    }
  });

  it('allows the batch exactly at the L2 cap', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const cap = getTierLimits('free').positions!;
    await seedRawPositions(userId, account.id, cap - 2);

    config.FEATURE_GATING = true;
    try {
      const res = await authedRequest('POST', '/api/position-groups', cookie, {
        accountId: account.id,
        filledAt: '2025-03-01T00:00:00.000Z',
        legs: [
          {
            symbol: 'AAPL260116C100',
            side: 'long',
            assetType: 'option',
            quantity: '1',
            price: '5',
          },
          {
            symbol: 'AAPL260116C110',
            side: 'short',
            assetType: 'option',
            quantity: '1',
            price: '2',
          },
        ],
      });
      expect(res.status).toBe(201);
    } finally {
      config.FEATURE_GATING = false;
    }
  });

  it('refuses a non-writable account while over the account cap', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountA = await createTestAccount(cookie, 'Acct A');
    const accountB = await createTestAccount(cookie, 'Acct B');
    // Activity in B makes it the effective writable designation.
    await createOpenLeg(cookie, accountB.id, 'NVDA260116C100');

    config.FEATURE_GATING = true;
    try {
      const res = await authedRequest('POST', '/api/position-groups', cookie, {
        accountId: accountA.id,
        filledAt: '2025-03-01T00:00:00.000Z',
        legs: [
          {
            symbol: 'AAPL260116C100',
            side: 'long',
            assetType: 'option',
            quantity: '1',
            price: '5',
          },
          {
            symbol: 'AAPL260116C110',
            side: 'short',
            assetType: 'option',
            quantity: '1',
            price: '2',
          },
        ],
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('TIER_ACCOUNT_NOT_WRITABLE');
    } finally {
      config.FEATURE_GATING = false;
    }
  });
});

describe('position-groups link (AC 1.2, 1.4, 3.3, D6, Error Handling 2)', () => {
  it('links an open and a closed leg, writes no fill/ledger row, and keeps updatedAt', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const open = await createOpenLeg(cookie, account.id, 'AAPL260116C100');
    const closed = await createClosedLeg(cookie, account.id, 'AAPL260116C110', { side: 'short' });

    const before = await countFillsAndLedgerRows([open.id, closed.id]);
    const openBefore = await (
      await authedRequest('GET', `/api/positions/${open.id}`, cookie)
    ).json();
    const closedBefore = await (
      await authedRequest('GET', `/api/positions/${closed.id}`, cookie)
    ).json();

    const res = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [open.id, closed.id],
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe('group');
    expect(body.legs.map((l: { id: string }) => l.id).sort()).toEqual([open.id, closed.id].sort());

    const after = await countFillsAndLedgerRows([open.id, closed.id]);
    expect(after).toEqual(before);

    const openAfter = await (
      await authedRequest('GET', `/api/positions/${open.id}`, cookie)
    ).json();
    const closedAfter = await (
      await authedRequest('GET', `/api/positions/${closed.id}`, cookie)
    ).json();
    expect(openAfter.updatedAt).toBe(openBefore.updatedAt);
    expect(closedAfter.updatedAt).toBe(closedBefore.updatedAt);
  });

  it('refuses linking legs with differing accounts, naming leg 1', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountA = await createTestAccount(cookie, 'Acct A');
    const accountB = await createTestAccount(cookie, 'Acct B');
    const legA = await createOpenLeg(cookie, accountA.id, 'AAPL260116C100');
    const legB = await createOpenLeg(cookie, accountB.id, 'AAPL260116C110');

    const res = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [legA.id, legB.id],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.legIndex).toBe('1');
  });

  it('refuses linking a draft position, naming its symbol', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const open = await createOpenLeg(cookie, account.id, 'AAPL260116C100');
    const draft = await createDraftPosition(cookie, account.id, { symbol: 'AAPL260116C110' });

    const res = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [open.id, draft.id],
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain('AAPL260116C110');
  });

  it('refuses linking an already-grouped position, naming its symbol', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C100');
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C110');
    const linkRes = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [legA.id, legB.id],
    });
    expect(linkRes.status).toBe(201);

    const legC = await createOpenLeg(cookie, account.id, 'AAPL260116C120');
    const res = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [legA.id, legC.id],
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain('AAPL260116C100');
  });

  it('leaves the account position value unchanged across a link', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C100', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C110', {
      side: 'short',
      price: '2',
    });

    const beforeRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    const before = Number((await beforeRes.json()).positionValue);

    const linkRes = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [legA.id, legB.id],
    });
    expect(linkRes.status).toBe(201);

    const afterRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    const after = Number((await afterRes.json()).positionValue);

    expect(after).toBe(before);
  });
});

describe('position-groups add/unlink/label (AC 1.4, 1.5, 2.4, 2.5, Error Handling 8)', () => {
  it('adds legs up to the 8-leg cap and refuses the 9th, naming the cap with no leg index', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const createRes = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C105',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const group = await createRes.json();

    const extraStrikes = [110, 115, 120, 125, 130, 135];
    for (const strike of extraStrikes) {
      const leg = await createOpenLeg(cookie, account.id, `AAPL260116C${strike}`);
      const addRes = await authedRequest('POST', `/api/position-groups/${group.id}/legs`, cookie, {
        positionId: leg.id,
      });
      expect(addRes.status).toBe(200);
    }

    const ninthLeg = await createOpenLeg(cookie, account.id, 'AAPL260116C140');
    const res = await authedRequest('POST', `/api/position-groups/${group.id}/legs`, cookie, {
      positionId: ninthLeg.id,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('8');
    expect(body.error.details?.legIndex).toBeUndefined();
  });

  it('unlinks a leg, and dissolves the group when one leg remains', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const createRes = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
        {
          symbol: 'AAPL260116C120',
          side: 'long',
          assetType: 'option',
          quantity: '1',
          price: '1',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const group = await createRes.json();
    const [legA, legB, legC] = group.legs;

    const unlinkRes = await authedRequest(
      'DELETE',
      `/api/position-groups/${group.id}/legs/${legC.id}`,
      cookie,
    );
    expect(unlinkRes.status).toBe(204);

    const unlinkedDetail = await (
      await authedRequest('GET', `/api/positions/${legC.id}`, cookie)
    ).json();
    expect(unlinkedDetail.groupId ?? null).toBeNull();

    const listAfterFirstUnlink = await (
      await authedRequest('GET', '/api/positions', cookie)
    ).json();
    const stillGroup = listAfterFirstUnlink.find((e: { id: string }) => e.id === group.id);
    expect(stillGroup.legs).toHaveLength(2);

    const dissolveRes = await authedRequest(
      'DELETE',
      `/api/position-groups/${group.id}/legs/${legB.id}`,
      cookie,
    );
    expect(dissolveRes.status).toBe(204);

    const remainingDetail = await (
      await authedRequest('GET', `/api/positions/${legA.id}`, cookie)
    ).json();
    expect(remainingDetail.groupId ?? null).toBeNull();

    const listAfterDissolve = await (await authedRequest('GET', '/api/positions', cookie)).json();
    expect(listAfterDissolve.some((e: { kind?: string }) => e.kind === 'group')).toBe(false);
  });

  it('sets a trimmed label override, and clearing it returns the detected label', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const createRes = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const group = await createRes.json();
    expect(group.detectedLabel).toBe('BCS');

    const setRes = await authedRequest('PATCH', `/api/position-groups/${group.id}`, cookie, {
      labelOverride: '  My Custom Spread  ',
    });
    expect(setRes.status).toBe(200);
    const setBody = await setRes.json();
    expect(setBody.labelOverride).toBe('My Custom Spread');
    expect(setBody.label).toBe('My Custom Spread');
    expect(setBody.detectedLabel).toBe('BCS');

    const clearRes = await authedRequest('PATCH', `/api/position-groups/${group.id}`, cookie, {
      labelOverride: null,
    });
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json();
    expect(clearBody.labelOverride).toBeNull();
    expect(clearBody.label).toBe('BCS');
  });

  it('follows the current legs for its label when no override is set', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const createRes = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const group = await createRes.json();
    expect(group.label).toBe('BCS');

    const thirdLeg = await createOpenLeg(cookie, account.id, 'AAPL260116C120');
    const addRes = await authedRequest('POST', `/api/position-groups/${group.id}/legs`, cookie, {
      positionId: thirdLeg.id,
    });
    expect(addRes.status).toBe(200);
    const addBody = await addRes.json();
    expect(addBody.labelOverride).toBeNull();
    expect(addBody.label).toBe('Multi-leg');
  });
});

describe('position-groups ownership (NFR Security)', () => {
  it("returns 404 for another user's group id on add-leg, patch and delete-leg", async () => {
    const owner = await registerAndGetCookie();
    const ownerAccount = await createTestAccount(owner.cookie);
    const createRes = await authedRequest('POST', '/api/position-groups', owner.cookie, {
      accountId: ownerAccount.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const ownerGroup = await createRes.json();
    const ownerLegId = ownerGroup.legs[0].id;

    const stranger = await registerAndGetCookie();
    const strangerAccount = await createTestAccount(stranger.cookie);
    const strangerLeg = await createOpenLeg(stranger.cookie, strangerAccount.id, 'MSFT260116C100');

    const addRes = await authedRequest(
      'POST',
      `/api/position-groups/${ownerGroup.id}/legs`,
      stranger.cookie,
      { positionId: strangerLeg.id },
    );
    expect(addRes.status).toBe(404);

    const patchRes = await authedRequest(
      'PATCH',
      `/api/position-groups/${ownerGroup.id}`,
      stranger.cookie,
      { labelOverride: 'Hijacked' },
    );
    expect(patchRes.status).toBe(404);

    const deleteRes = await authedRequest(
      'DELETE',
      `/api/position-groups/${ownerGroup.id}/legs/${ownerLegId}`,
      stranger.cookie,
    );
    expect(deleteRes.status).toBe(404);
  });

  it("returns 404 for another user's position id on link and add-leg", async () => {
    const owner = await registerAndGetCookie();
    const ownerAccount = await createTestAccount(owner.cookie);
    const ownerLeg = await createOpenLeg(owner.cookie, ownerAccount.id, 'AAPL260116C100');

    const stranger = await registerAndGetCookie();
    const strangerAccount = await createTestAccount(stranger.cookie);
    const strangerLegA = await createOpenLeg(stranger.cookie, strangerAccount.id, 'MSFT260116C100');
    const strangerLegB = await createOpenLeg(stranger.cookie, strangerAccount.id, 'MSFT260116C110');

    const linkRes = await authedRequest('POST', '/api/position-groups/link', stranger.cookie, {
      positionIds: [ownerLeg.id, strangerLegA.id],
    });
    expect(linkRes.status).toBe(404);

    const groupRes = await authedRequest('POST', '/api/position-groups/link', stranger.cookie, {
      positionIds: [strangerLegA.id, strangerLegB.id],
    });
    expect(groupRes.status).toBe(201);
    const strangerGroup = await groupRes.json();

    const addRes = await authedRequest(
      'POST',
      `/api/position-groups/${strangerGroup.id}/legs`,
      stranger.cookie,
      { positionId: ownerLeg.id },
    );
    expect(addRes.status).toBe(404);
  });
});

/*
 * Contract block — delete paths keep groups whole (design C7).
 *
 * AC 1.5 (delete one of three legs; group left with two legs)
 *   Pre: a 3-leg group.
 *   Call: DELETE /api/positions/:id on one leg.
 *   Result: 204; the deleted leg is gone (404 on GET); the list still shows
 *     a `kind: 'group'` entry for the other two legs.
 *   Source: requirements.md AC 1.5 ("a group left with one leg SHALL
 *     dissolve" implies a group left with more than one SHALL NOT).
 *
 * AC 1.5 (delete one of two legs; group dissolves)
 *   Pre: a 2-leg group.
 *   Call: DELETE /api/positions/:id on one leg.
 *   Result: 204; the survivor's `groupId` reads null and the list carries
 *     no `kind: 'group'` entry for it — a plain position.
 *   Source: requirements.md AC 1.5 ("a group left with one leg SHALL
 *     dissolve into a plain position").
 *
 * Error Handling 6 (membership changed under the lock)
 *   Pre: an ungrouped leg whose unlocked pre-read sees no group, but by the
 *     time the lock is acquired another transaction has linked it.
 *   Call: DELETE /api/positions/:id, with `findPositionById` mocked to
 *     perform that concurrent link right after its own (ungrouped) read.
 *   Result: 409 CONFLICT, "The group changed; try again."; the leg survives
 *     (the whole transaction rolled back).
 *   Source: design Error Handling 6; design C7 ("an ungrouped row takes
 *     today's path, and if the locked row now has a group it throws
 *     Error Handling 6's 409").
 *
 * AC 1.5 (ledger reversal for a deleted grouped leg, matching an ungrouped
 * position)
 *   Pre: a 2-leg group with one leg closed (full exit), the close/reverse
 *     ledger hooks registered.
 *   Call: DELETE /api/positions/:id on the closed leg.
 *   Result: 204; the account balance returns to its pre-close value, exactly
 *     as `positions closed-delete + ledger reversal` (positions.test.ts)
 *     shows for an ungrouped position.
 *   Source: design C7 ("runs the reverse hooks and delete as today").
 */
describe('positions delete keeps groups whole (AC 1.5, design C7, Error Handling 6)', () => {
  it('deleting one leg of a three-leg group leaves a two-leg group', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const createRes = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
        {
          symbol: 'AAPL260116C120',
          side: 'long',
          assetType: 'option',
          quantity: '1',
          price: '1',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const group = await createRes.json();
    const [legA, legB, legC] = group.legs;

    const res = await authedRequest('DELETE', `/api/positions/${legA.id}`, cookie);
    expect(res.status).toBe(204);

    const getRes = await authedRequest('GET', `/api/positions/${legA.id}`, cookie);
    expect(getRes.status).toBe(404);

    const list = await (await authedRequest('GET', '/api/positions', cookie)).json();
    const stillGroup = list.find((e: { id: string }) => e.id === group.id);
    expect(stillGroup).toBeDefined();
    expect(stillGroup.kind).toBe('group');
    expect(stillGroup.legs.map((l: { id: string }) => l.id).sort()).toEqual(
      [legB.id, legC.id].sort(),
    );
  });

  it('deleting one leg of a two-leg group dissolves it; the survivor reads as a plain position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const createRes = await authedRequest('POST', '/api/position-groups', cookie, {
      accountId: account.id,
      filledAt: '2025-03-01T00:00:00.000Z',
      legs: [
        { symbol: 'AAPL260116C100', side: 'long', assetType: 'option', quantity: '1', price: '5' },
        {
          symbol: 'AAPL260116C110',
          side: 'short',
          assetType: 'option',
          quantity: '1',
          price: '2',
        },
      ],
    });
    expect(createRes.status).toBe(201);
    const group = await createRes.json();
    const [legA, legB] = group.legs;

    const res = await authedRequest('DELETE', `/api/positions/${legA.id}`, cookie);
    expect(res.status).toBe(204);

    const survivorRes = await authedRequest('GET', `/api/positions/${legB.id}`, cookie);
    expect(survivorRes.status).toBe(200);
    const survivor = await survivorRes.json();
    expect(survivor.groupId ?? null).toBeNull();

    const list = await (await authedRequest('GET', '/api/positions', cookie)).json();
    expect(list.some((e: { kind?: string }) => e.kind === 'group')).toBe(false);
    const survivorEntry = list.find((e: { id: string }) => e.id === legB.id);
    expect(survivorEntry).toBeDefined();
    expect(survivorEntry.kind).not.toBe('group');
  });

  it('returns 409 when the leg is grouped by the time its lock is acquired', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    // The ungrouped leg under test, plus an unrelated 2-leg group that will
    // stand in for "another transaction linked it" — the forged update below
    // only needs a group row that satisfies the FK, not real membership.
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C500');
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C510', { side: 'short' });
    const legC = await createOpenLeg(cookie, account.id, 'AAPL260116C520');
    const linkRes = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [legB.id, legC.id],
    });
    expect(linkRes.status).toBe(201);
    const raceGroup = await linkRes.json();

    const realFindPositionById = positionsQuery.findPositionById;
    const spy = vi
      .spyOn(positionsQuery, 'findPositionById')
      .mockImplementation((dbArg, id, userId) => {
        const query = realFindPositionById(dbArg, id, userId);
        return query.then(async (rows) => {
          if (id === legA.id) {
            // Simulates a concurrent link committing between the unlocked read
            // and the lock, by mutating the row directly through the plain
            // `db` handle rather than the caller's (possibly uncommitted) tx.
            await db
              .update(positions)
              .set({ groupId: raceGroup.id })
              .where(eq(positions.id, legA.id));
          }
          return rows;
        }) as unknown as ReturnType<typeof positionsQuery.findPositionById>;
      });

    let res: Response;
    try {
      res = await authedRequest('DELETE', `/api/positions/${legA.id}`, cookie);
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('The group changed; try again.');
  });
});

describe('positions delete — ledger reversal for a grouped leg (AC 1.5)', () => {
  beforeAll(() => {
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    unregisterReverseHook('ledger');
  });

  async function getAccountBalance(cookie: string, accountId: string): Promise<number> {
    const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    return Number(body.balance);
  }

  it("reverses a closed leg's ledger entry exactly as it does for an ungrouped position", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const preClose = await getAccountBalance(cookie, account.id);

    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C600', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C610', {
      side: 'short',
      price: '2',
    });
    const linkRes = await authedRequest('POST', '/api/position-groups/link', cookie, {
      positionIds: [legA.id, legB.id],
    });
    expect(linkRes.status).toBe(201);

    await addFill(cookie, legA.id, {
      type: 'exit',
      price: '7',
      quantity: '1',
      fees: '0',
      filledAt: '2025-01-02T00:00:00.000Z',
    });

    const postClose = await getAccountBalance(cookie, account.id);
    expect(postClose).not.toBe(preClose);

    const res = await authedRequest('DELETE', `/api/positions/${legA.id}`, cookie);
    expect(res.status).toBe(204);

    expect(await getAccountBalance(cookie, account.id)).toBe(preClose);

    const getRes = await authedRequest('GET', `/api/positions/${legA.id}`, cookie);
    expect(getRes.status).toBe(404);
  });
});

afterEach(() => {
  config.FEATURE_GATING = false;
});
