/**
 * Close-all-legs (design C4 closeGroup, C5; multi-leg-positions task 6).
 * Black-box over `POST /api/position-groups/:id/close`, matching the house
 * style of `position-groups.test.ts` and `positions.bulk-tx.test.ts`.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * AC 4.1 (happy path) + AC 4.8 (no lot selection on write; stays settable)
 *   Pre: a 2-leg open group (BCS), both legs priced.
 *   Call: POST .../close with an explicit exit price/fees per leg and a
 *     closedAt instant.
 *   Result: 200; both legs 'closed'; each leg gets exactly one new exit fill
 *     for its open units, dated at the given instant, with lotSelection null;
 *     a later PUT on that exit fill can still set a lotSelection (200).
 *   Source: requirements.md AC 4.1, AC 4.8; design C4 closeGroup step 3/5.
 *
 * AC 4.1 (no date defaults to now)
 *   Pre: a 2-leg open group.
 *   Call: POST .../close with no closedAt.
 *   Result: 200; the group and legs' closedAt is within seconds of now.
 *   Source: requirements.md AC 4.1 ("defaulting to now").
 *
 * AC 4.3 (closed leg skipped even if named)
 *   Pre: a 3-leg group, one leg already closed via a plain per-leg exit.
 *   Call: POST .../close naming all three legs in `exits`.
 *   Result: 200; the two open legs close with one new exit fill each; the
 *     already-closed leg's fill count is unchanged (no fill written for it).
 *   Source: requirements.md AC 4.3; design C4 closeGroup step 2.
 *
 * Design C4 step 2 (open leg missing from `exits` → 400, naming it)
 *   Pre: a 2-leg open group.
 *   Call: POST .../close naming only one of the two open legs.
 *   Result: 400 VALIDATION_ERROR, message contains the omitted leg's symbol;
 *     neither leg gets a new fill or changes status.
 *   Source: design C4 closeGroup step 2.
 *
 * Design C4 step 2 (an id that is not a leg → 404)
 *   Pre: a 2-leg open group.
 *   Call: POST .../close naming both real legs plus a random, unrelated id.
 *   Result: 404 NOT_FOUND; neither real leg gets a new fill or changes status.
 *   Source: design C4 closeGroup step 2.
 *
 * Design C4 step 2 (all-closed group → 409)
 *   Pre: a 2-leg group, both legs already closed via plain per-leg exits.
 *   Call: POST .../close.
 *   Result: 409 CONFLICT.
 *   Source: design C4 closeGroup step 2.
 *
 * AC 4.4 (date before a leg's openedAt rolls back everything) + AC 4.7
 * ("primary failure leaving no ledger row", folded here)
 *   Pre: a 2-leg open group with the real ledger hooks registered; a
 *     closedAt before both legs' openedAt.
 *   Call: POST .../close with that closedAt.
 *   Result: 400, message names the leg whose open date it precedes; both legs
 *     stay open with their original fill count; zero ledger_entries rows for
 *     either leg (the whole transaction rolled back).
 *   Source: requirements.md AC 4.4; design C4 closeGroup step 4; AC 4.7's
 *     "primary failure" branch — no hook here, just the primary write guard.
 *
 * AC 4.4 (a leg refused by the reopen guard rolls back the same way)
 *   Pre: a 2-leg group where one leg was closed then reopened same-day with
 *     no new fill since (`reopenedWithoutNewFills`); the other leg is a
 *     normal open leg.
 *   Call: POST .../close naming both.
 *   Result: 409, message names the reopened leg; the other leg stays open
 *     with no new fill; the reopened leg is unchanged.
 *   Source: requirements.md AC 4.4; positions.query.ts reopenedWithoutNewFills.
 *
 * AC 4.1 (an open leg with zero open units still goes through closePositionTx)
 *   Pre: a 2-leg group where one leg's fills already reconcile to zero open
 *     units (written directly via addFillTx, bypassing auto-close) while
 *     still `open`; the other leg is a normal open leg.
 *   Call: POST .../close naming both.
 *   Result: 200; the zero-unit leg reads 'closed' with no new fill written
 *     for it; the other leg closes normally with one new exit fill.
 *   Source: design C4 closeGroup step 3 ("including one with zero open
 *     units, so its guards apply").
 *
 * AC 4.2 (lock order: every leg locked ascending before the first fill)
 *   Pre: a 2-leg open group.
 *   Call: POST .../close, with `findPositionForUpdate` and `insertFill`
 *     spied (pass-through).
 *   Result: 200; the first two lock calls carry the two leg ids sorted
 *     ascending; the first fill insert happens strictly after both.
 *   Source: requirements.md AC 4.2; design.md "Lock rule".
 *
 * AC 4.6/4.7 (hook success: per-leg ledger rows, no group row, balance moves
 * by the group's net P&L)
 *   Pre: a 2-leg open group (long/short call), the real ledger fill+close
 *     hooks registered.
 *   Call: POST .../close with exit prices giving a known net P&L.
 *   Result: 200; exactly one ledger_entries row per leg, each under that
 *     leg's own symbol; two rows total (no extra group-level row); the
 *     account balance moves by the group's summed net P&L.
 *   Source: requirements.md AC 4.6; accounting/ledger-hook.ts postRealizedDelta.
 *
 * AC 4.7 (a throwing close hook rolls back every leg's fills and status)
 *   Pre: a 2-leg open group; a close hook registered that throws.
 *   Call: POST .../close.
 *   Result: 500; both legs stay open with their original fill count.
 *   Source: requirements.md AC 4.7; positions.service.ts closeHooks registry.
 *
 * Folded/out-of-scope criteria (recorded, not retested here):
 *   - AC 4.8's second half (a selection stays settable on an exit fill
 *     afterwards) is folded into the happy-path test above — it PUTs a
 *     lotSelection onto a closeGroup-written exit and asserts 200.
 *   - AC 4.9 ("the last leg closing by any path reads the group closed with
 *     no extra call") needs no new code: `assembleListEntries`'s status
 *     derivation is `legRows.every(l => l.status === 'closed')`, already
 *     green-tested at `position-group-entries.test.ts:243-254` ("derives
 *     group status: open unless every leg is closed"), independent of how a
 *     leg reaches 'closed'. RED-IMPOSSIBLE.
 *   - AC 1.8 (existing per-position fill-add/edit/remove and same-day-reopen
 *     rules apply unchanged to a leg) needs no code: `fills.ts`/
 *     `positions.service.ts`'s per-fill and reopen paths never read
 *     `group_id`. RED-IMPOSSIBLE; a regression guard exercising a grouped
 *     leg through those unchanged routes is named for the implementer brief
 *     rather than committed here (it would be green from the first run).
 *   - The checklist items "`pnpm vitest run ...` passes", "tradr-api.json and
 *     _how-its-built.json are committed" and "`pnpm check-types` is clean"
 *     are implementer-side checks, not test-authorable criteria.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';

import { db } from '@/db';
import { fills, ledgerEntries, positions } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  postFillLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import * as fillsQuery from '@/features/positions/fills.query';
import * as positionsQuery from '@/features/positions/positions.query';
import {
  addFillTx,
  listCloseHooks,
  registerCloseHook,
  replaceCloseHook,
  replaceFillHook,
  replaceReverseHook,
  unregisterCloseHook,
  unregisterFillHook,
  unregisterReverseHook,
  type CloseHook,
} from '@/features/positions/positions.service';
import { withTransaction } from '@/lib/transaction';

let testCounter = 0;
function uniqueEmail() {
  return `posgroupclose-test${Date.now()}-${++testCounter}@example.com`;
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
  const app = (await import('@/app')).default;
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

async function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const app = (await import('@/app')).default;
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
  symbol: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol,
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
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, {
    fees: '0',
    ...data,
  });
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
  const pos = await createDraftPosition(cookie, accountId, symbol, { side, assetType: 'option' });
  await addFill(cookie, pos.id, { type: 'entry', price, quantity, filledAt });
  return openTestPosition(cookie, pos.id, filledAt);
}

/** Closes an open leg with a full, auto-closing exit (the plain per-leg path). */
async function closeLegPlain(
  cookie: string,
  positionId: string,
  quantity: string,
  overrides: { price?: string; filledAt?: string } = {},
) {
  const price = overrides.price ?? '7';
  const filledAt = overrides.filledAt ?? '2025-01-02T00:00:00.000Z';
  return addFill(cookie, positionId, { type: 'exit', price, quantity, filledAt });
}

async function linkLegs(cookie: string, positionIds: string[]) {
  const res = await authedRequest('POST', '/api/position-groups/link', cookie, { positionIds });
  expect(res.status).toBe(201);
  return res.json();
}

async function closeAll(cookie: string, groupId: string, body: unknown) {
  return authedRequest('POST', `/api/position-groups/${groupId}/close`, cookie, body);
}

async function getPosition(cookie: string, id: string) {
  const res = await authedRequest('GET', `/api/positions/${id}`, cookie);
  return res.json();
}

async function countFills(positionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fills)
    .where(eq(fills.positionId, positionId));
  return row?.count ?? 0;
}

async function countLedgerRows(positionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.positionId, positionId));
  return row?.count ?? 0;
}

async function getStatus(positionId: string): Promise<string> {
  const [row] = await db.select().from(positions).where(eq(positions.id, positionId));
  return row!.status;
}

describe('position-groups close-all — happy path (AC 4.1, 4.8)', () => {
  it('closes both legs with one exit fill each, at the given instant, and the exit stays selectable afterward', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C100', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C110', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const closedAt = '2025-06-15T15:00:00.000Z';
    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
      closedAt,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('closed');
    for (const leg of body.legs) {
      expect(leg.status).toBe('closed');
      expect(new Date(leg.closedAt).toISOString()).toBe(new Date(closedAt).toISOString());
    }

    const detailA = await getPosition(cookie, legA.id);
    expect(detailA.fills).toHaveLength(2);
    const exitA = detailA.fills.find((f: { type: string }) => f.type === 'exit');
    // `fills.quantity`/`fills.price` are numeric(18,8) — Postgres always
    // returns the full fixed scale, so compare numerically, not by string.
    expect(Number(exitA.quantity)).toBe(1);
    expect(Number(exitA.price)).toBe(7);
    expect(exitA.lotSelection).toBeNull();

    const detailB = await getPosition(cookie, legB.id);
    const exitB = detailB.fills.find((f: { type: string }) => f.type === 'exit');
    expect(Number(exitB.price)).toBe(1);
    expect(exitB.lotSelection).toBeNull();

    // AC 4.8 invariant: a selection stays settable on the exit afterward.
    const entryA = detailA.fills.find((f: { type: string }) => f.type === 'entry');
    const setSelRes = await authedRequest(
      'PUT',
      `/api/positions/${legA.id}/fills/${exitA.id}`,
      cookie,
      { lotSelection: [{ entryFillId: entryA.id, quantity: '1' }] },
    );
    expect(setSelRes.status).toBe(200);
    const afterSel = await getPosition(cookie, legA.id);
    const exitAAfter = afterSel.fills.find((f: { id: string }) => f.id === exitA.id);
    expect(exitAAfter.lotSelection).toHaveLength(1);
    expect(exitAAfter.lotSelection[0].entryFillId).toBe(entryA.id);
    // `fill_lot_selections.quantity` is numeric(18,8) too — same fixed-scale
    // formatting as above.
    expect(Number(exitAAfter.lotSelection[0].quantity)).toBe(1);
  });

  it('defaults the instant to now when no closedAt is given', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C200', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C210', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const before = Date.now();
    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('closed');
    const closedAtMs = new Date(body.closedAt).getTime();
    expect(closedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(closedAtMs).toBeLessThanOrEqual(after + 10000);
  });
});

describe('position-groups close-all — skip and refusal paths (AC 4.3, design C4 step 2)', () => {
  it('skips an already-closed leg even when exits names it', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C300', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C310', {
      side: 'short',
      price: '2',
    });
    const legC = await createOpenLeg(cookie, account.id, 'AAPL260116C320', { price: '1' });
    const group = await linkLegs(cookie, [legA.id, legB.id, legC.id]);

    await closeLegPlain(cookie, legC.id, '1', { price: '3' });
    const closedCountBefore = await countFills(legC.id);
    expect(await getStatus(legC.id)).toBe('closed');

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
        { positionId: legC.id, price: '99', fees: '0' },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('closed');
    expect(await getStatus(legA.id)).toBe('closed');
    expect(await getStatus(legB.id)).toBe('closed');
    expect(await countFills(legC.id)).toBe(closedCountBefore);
  });

  it('refuses with 400 when an open leg is missing from exits, naming it, and writes nothing', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C400', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C410', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);
    const fillsBeforeA = await countFills(legA.id);
    const fillsBeforeB = await countFills(legB.id);

    const res = await closeAll(cookie, group.id, {
      exits: [{ positionId: legA.id, price: '7', fees: '0' }],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain(legB.symbol);
    expect(await getStatus(legA.id)).toBe('open');
    expect(await getStatus(legB.id)).toBe('open');
    expect(await countFills(legA.id)).toBe(fillsBeforeA);
    expect(await countFills(legB.id)).toBe(fillsBeforeB);
  });

  it('refuses with 404 when exits names an id that is not a leg of the group', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C500', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C510', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
        { positionId: crypto.randomUUID(), price: '1', fees: '0' },
      ],
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(await getStatus(legA.id)).toBe('open');
    expect(await getStatus(legB.id)).toBe('open');
  });

  it('refuses with 409 when every leg is already closed', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C600', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C610', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);
    await closeLegPlain(cookie, legA.id, '1', { price: '7' });
    await closeLegPlain(cookie, legB.id, '1', { price: '1' });

    const res = await closeAll(cookie, group.id, {
      exits: [{ positionId: legA.id, price: '0', fees: '0' }],
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });
});

describe('position-groups close-all — rollback on a bad date (AC 4.4, AC 4.7 primary failure)', () => {
  beforeAll(() => {
    replaceFillHook('ledger', postFillLedgerEntries);
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  });
  afterAll(() => {
    unregisterFillHook('ledger');
    unregisterCloseHook('ledger');
  });

  it('rolls back every leg when the date precedes a leg openedAt, naming it and leaving no fill or ledger row', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const openedAt = '2025-06-15T14:00:00.000Z';
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C700', {
      price: '5',
      filledAt: openedAt,
    });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C710', {
      side: 'short',
      price: '2',
      filledAt: openedAt,
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);
    const fillsBeforeA = await countFills(legA.id);
    const fillsBeforeB = await countFills(legB.id);

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
      closedAt: '2025-06-10T00:00:00.000Z',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect([legA.symbol, legB.symbol].some((s) => body.error.message.includes(s))).toBe(true);

    expect(await getStatus(legA.id)).toBe('open');
    expect(await getStatus(legB.id)).toBe('open');
    expect(await countFills(legA.id)).toBe(fillsBeforeA);
    expect(await countFills(legB.id)).toBe(fillsBeforeB);
    expect(await countLedgerRows(legA.id)).toBe(0);
    expect(await countLedgerRows(legB.id)).toBe(0);
  });
});

describe('position-groups close-all — rollback on the reopen guard (AC 4.4)', () => {
  // The reopen guard (`reopenedWithoutNewFills`) reads the `position_pnl_reversal`
  // row the reverse hook posts on reopen, which only exists once a prior
  // `position_pnl` row exists to reverse — so the close hook must be live for
  // the fixture's plain close too. Both are registered for this block.
  beforeAll(() => {
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    unregisterReverseHook('ledger');
  });

  it('rolls back every leg when one is refused by the reopen guard, naming it', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const openedAt = '2025-06-15T10:00:00.000Z';
    const closedAt = '2025-06-15T12:00:00.000Z';
    const reopenedAt = '2025-06-15T14:00:00.000Z';

    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C800', {
      price: '5',
      filledAt: openedAt,
    });
    await closeLegPlain(cookie, legA.id, '1', { price: '7', filledAt: closedAt });
    expect(await getStatus(legA.id)).toBe('closed');
    const reopenRes = await authedRequest('POST', `/api/positions/${legA.id}/reopen`, cookie, {
      reopenedAt,
    });
    expect(reopenRes.status).toBe(200);
    expect(await getStatus(legA.id)).toBe('open');
    const fillsBeforeA = await countFills(legA.id);

    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C810', {
      side: 'short',
      price: '2',
    });
    const fillsBeforeB = await countFills(legB.id);

    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '0', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(legA.symbol);

    expect(await getStatus(legA.id)).toBe('open');
    expect(await getStatus(legB.id)).toBe('open');
    expect(await countFills(legA.id)).toBe(fillsBeforeA);
    expect(await countFills(legB.id)).toBe(fillsBeforeB);
  });
});

describe('position-groups close-all — zero-open-units leg (AC 4.1, design C4 step 3)', () => {
  it('still runs closePositionTx on a leg already reconciled to zero open units, with no new fill for it', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createDraftPosition(cookie, account.id, 'AAPL260116C900');
    const openedAt = '2025-01-01T00:00:00.000Z';

    // Write a reconciling entry/exit pair directly via addFillTx, bypassing
    // the per-leg route's auto-close, so the leg stays `open` with zero open
    // units and no reopen marker at all.
    await withTransaction(db, (tx) =>
      addFillTx(tx, legA.id, userId, {
        type: 'entry',
        price: '5',
        quantity: '1',
        fees: '0',
        filledAt: openedAt,
      }),
    );
    await openTestPosition(cookie, legA.id, openedAt);
    await withTransaction(db, (tx) =>
      addFillTx(tx, legA.id, userId, {
        type: 'exit',
        price: '7',
        quantity: '1',
        fees: '0',
        filledAt: openedAt,
      }),
    );
    expect(await getStatus(legA.id)).toBe('open');
    const fillsBeforeA = await countFills(legA.id);

    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C910', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '0', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
    });

    expect(res.status).toBe(200);
    expect(await getStatus(legA.id)).toBe('closed');
    expect(await countFills(legA.id)).toBe(fillsBeforeA);
    expect(await getStatus(legB.id)).toBe('closed');
    expect(await countFills(legB.id)).toBe(2);
  });
});

describe('position-groups close-all — lock order (AC 4.2)', () => {
  it('locks every leg ascending by id before the first fill insert', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C150', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C160', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const calls: Array<{ kind: 'lock' | 'fill'; id?: string }> = [];
    const realFindForUpdate = positionsQuery.findPositionForUpdate;
    const findSpy = vi
      .spyOn(positionsQuery, 'findPositionForUpdate')
      .mockImplementation((tx, id, uid) => {
        calls.push({ kind: 'lock', id });
        return realFindForUpdate(tx, id, uid);
      });
    const realInsertFill = fillsQuery.insertFill;
    const insertSpy = vi.spyOn(fillsQuery, 'insertFill').mockImplementation((tx, data) => {
      calls.push({ kind: 'fill' });
      return realInsertFill(tx, data);
    });

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
    });
    expect(res.status).toBe(200);

    findSpy.mockRestore();
    insertSpy.mockRestore();

    const expectedAscending = [legA.id, legB.id].sort();
    const lockCalls = calls.filter((c) => c.kind === 'lock');
    expect(lockCalls.slice(0, 2).map((c) => c.id)).toEqual(expectedAscending);

    const firstFillIndex = calls.findIndex((c) => c.kind === 'fill');
    const secondLockIndex = calls.indexOf(lockCalls[1]!);
    expect(firstFillIndex).toBeGreaterThan(secondLockIndex);
  });
});

describe('position-groups close-all — hook success (AC 4.6, AC 4.7)', () => {
  beforeAll(() => {
    replaceFillHook('ledger', postFillLedgerEntries);
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  });
  afterAll(() => {
    unregisterFillHook('ledger');
    unregisterCloseHook('ledger');
  });

  it('posts one ledger row per leg under its own symbol, no group row, and moves the balance by net P&L', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C250', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C260', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);

    const beforeRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    const balanceBefore = Number((await beforeRes.json()).balance);

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
      closedAt: '2025-06-15T15:00:00.000Z',
    });
    expect(res.status).toBe(200);

    const rowsA = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, legA.id));
    const rowsB = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, legB.id));
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.symbol).toBe(legA.symbol);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.symbol).toBe(legB.symbol);
    expect(rowsA.length + rowsB.length).toBe(2);

    const afterRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    const balanceAfter = Number((await afterRes.json()).balance);
    // Long call: (7-5)*1*100 = 200. Short call: (2-1)*1*100 = 100. Net = 300.
    expect(balanceAfter - balanceBefore).toBeCloseTo(300, 2);
  });
});

describe('position-groups close-all — rollback on a throwing close hook (AC 4.7)', () => {
  afterEach(() => {
    for (const name of listCloseHooks()) unregisterCloseHook(name);
  });

  it('rolls back every leg fills and status when a close hook throws', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const legA = await createOpenLeg(cookie, account.id, 'AAPL260116C350', { price: '5' });
    const legB = await createOpenLeg(cookie, account.id, 'AAPL260116C360', {
      side: 'short',
      price: '2',
    });
    const group = await linkLegs(cookie, [legA.id, legB.id]);
    const fillsBeforeA = await countFills(legA.id);
    const fillsBeforeB = await countFills(legB.id);

    const boom: CloseHook = async () => {
      throw new Error('intentional close-hook failure');
    };
    registerCloseHook('close-all-boom', boom);

    const res = await closeAll(cookie, group.id, {
      exits: [
        { positionId: legA.id, price: '7', fees: '0' },
        { positionId: legB.id, price: '1', fees: '0' },
      ],
    });

    expect(res.status).toBe(500);
    expect(await getStatus(legA.id)).toBe('open');
    expect(await getStatus(legB.id)).toBe('open');
    expect(await countFills(legA.id)).toBe(fillsBeforeA);
    expect(await countFills(legB.id)).toBe(fillsBeforeB);
  });
});
