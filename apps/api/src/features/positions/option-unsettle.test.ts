/**
 * Unsettle and the reopen guard (design C4 last bullet, C5; task 9 of
 * option-lifecycle-events). Black-box over `unsettle`/`reopenPosition`
 * directly — the house style from `option-settlement.test.ts`: seed via raw
 * inserts and the existing `*Tx` seams (including `settleLeg` itself, task
 * 7/8's own core), drive the function under test, assert on committed state.
 * No route exists yet (task 13), so every call here is service-level.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * A. Unsettling a worthless settlement nets fills/ledger/status back (AC 4.1,
 *    4.6)
 *   Pre: a short leg settled worthless (one exit fill written, leg closed,
 *     a nonzero realised total posted).
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: the written exit fill is gone, the leg is `open` with
 *     `closedAt: null`, and its posted realised total is back to the
 *     pre-settlement value (0).
 *   Source: design C5 post-conditions 4-5; requirements AC 4.1, 4.6.
 *
 * B. Unsettling an assigned settlement deletes the opened stock row and nets
 *    both rows back (AC 4.1, 4.6)
 *   Pre: a short put settled assigned (opens a new long stock row).
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: the new stock row no longer exists; the leg reopens with
 *     `closedAt: null`; both rows' posted realised totals return to their
 *     pre-settlement values.
 *   Source: design C5 post-conditions 4-6; requirements AC 4.1, 4.3, 4.6.
 *
 * C. Unsettling a covered-call settlement (exits a held row) nets both rows
 *    back (AC 4.1, 4.6)
 *   Pre: a short call settled assigned against an already-held long stock
 *     row (exits it, no new row).
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: the held row reopens with `closedAt: null`; both rows' posted
 *     realised totals return to pre-settlement.
 *   Source: design C5 post-conditions 4-5; requirements AC 4.1, 4.6.
 *
 * D. Deleting the opened row never re-reverses an earlier partial exit's P&L
 *    on the leg (AC 4.3)
 *   Pre: a leg that took a manual partial exit before the remainder was
 *     settled assigned (opens a new stock row).
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: the new stock row is gone; the leg's own posted realised total
 *     is unchanged from right after the earlier partial exit (never
 *     re-reversed, as `deletePosition` carries no reverse-hook loop).
 *   Source: design C5 post-condition 6; requirements AC 4.3.
 *
 * E. A latch set from null returns to null (AC 4.4)
 *   Pre: a leg never previously flat, settled worthless (closing it sets the
 *     latch).
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: `lastFlatAt`/`lastFlatNetPnl` are null again.
 *   Source: design C5 post-condition 7; requirements AC 4.4.
 *
 * F. A prior latch figure is restored (AC 4.4)
 *   Pre: a leg closed once (latching a figure), reopened same-day, given a
 *     fresh entry, then settled worthless (overwriting the latch).
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: `lastFlatAt`/`lastFlatNetPnl` equal the figure from the first
 *     close, not the settlement's own.
 *   Source: design C5 post-condition 7; requirements AC 4.4.
 *
 * G. A group un-latches with its last leg, with no group write (AC 4.4)
 *   Pre: two grouped legs, one closed normally, the other settled worthless
 *     (now both flat, so `classifyGroup` reads the group as flat).
 *   Call: `unsettle(db, userId, leg2Id, result.settlementId)`.
 *   Result: `classifyGroup` over the same two legs now returns null again;
 *     the `position_groups` row is byte-identical before and after.
 *   Source: design C5 post-condition 7, performance.service.ts `classifyGroup`
 *     doc; requirements AC 4.4.
 *
 * H. Refusal: a later fill on a touched row (AC 4.7)
 *   Pre: an assigned settlement's opened stock row takes a further exit fill
 *     afterward.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: rejects; the settlement row, the leg's closed status and the
 *     stock row's fills are all unchanged.
 *   Source: design C5 post-condition 3; requirements AC 4.7.
 *
 * I. Refusal: a fill removed and a different one added, count unchanged
 *    (AC 4.7, design D2)
 *   Pre: the opened stock row's own written entry fill is deleted and
 *     replaced by a fresh fill of the same shape, so the row's fill count
 *     matches what the settlement itself recorded.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: rejects; the row still carries exactly one fill (the
 *     replacement, not reverted) and the settlement row still exists.
 *   Source: design D2 ("a count misses a removal paired with an addition");
 *     requirements AC 4.7.
 *
 * J. Refusal: an opened row no longer exists (AC 4.7)
 *   Pre: the opened stock row is deleted outright.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: rejects; the settlement row still exists; the leg is unchanged.
 *   Source: design C5 post-condition 3; requirements AC 4.7.
 *
 * K. Refusal: a written fill carries a transfer link (AC 4.7)
 *   Pre: the opened stock row's written entry fill is linked as the entry
 *     side of a transfer.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: rejects; the settlement row still exists; the leg is unchanged.
 *   Source: design C5 post-condition 3; requirements AC 4.7.
 *
 * L. Refusal: an opened row has joined a group (AC 4.7)
 *   Pre: the opened stock row is given a `group_id`.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: rejects; the settlement row still exists; the leg is unchanged.
 *   Source: design C5 post-condition 3; requirements AC 4.7.
 *
 * M. A second settlement touching the same row refuses the first, until
 *    undone (AC 4.7, design D2)
 *   Pre: a short put assigned (opens a long stock row), then a short call on
 *     the same underlying assigned against that same row (exits it).
 *   Call: `unsettle(db, userId, putLegId, result1.settlementId)`, then,
 *     after undoing the second settlement first, the same call again.
 *   Result: the first call rejects while the second settlement stands;
 *     after `unsettle`-ing the second settlement, the same call on the first
 *     succeeds.
 *   Source: design D2; requirements AC 4.7.
 *
 * N. A double submit gets 404 on the second (design C5 post-condition 2)
 *   Pre: a worthless settlement, unsettled once already.
 *   Call: `unsettle(db, userId, legId, result.settlementId)` a second time.
 *   Result: rejects `NotFoundError`.
 *   Source: design C5 post-condition 2.
 *
 * O. Another user's id is 404 (NFR Security)
 *   Pre: a worthless settlement belonging to user A.
 *   Call: `unsettle(db, userB.userId, legId, result.settlementId)`.
 *   Result: rejects `NotFoundError`.
 *   Source: requirements NFR Security.
 *
 * P. Across a year boundary, both years' tax summaries return to
 *    pre-settlement figures, under each lot method, reading an absent
 *    currency as 0 (AC 4.6)
 *   Pre, per lot method (US/fifo default, US/average, CA/acb): an unrelated
 *     prior-year tax summary baseline, and a leg entered in the earlier year
 *     settled worthless in the later year.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: both years' `getTaxSummary` figures equal their own
 *     pre-settlement values, for every method.
 *   Source: requirements AC 4.6.
 *
 * Q. Reopen of a touched row is a 409 naming unsettle, whatever the same-day
 *    guard says (AC 4.8)
 *   Pre: a leg settled worthless (closing it), same-day and a different-day
 *     relative to its `openedAt`.
 *   Call: `reopenPosition(db, userId, legId, reopenedAt?)`.
 *   Result: rejects `ConflictError` whose message names unsettle, in both
 *     the same-day and the different-day case.
 *   Source: design C4 (`reopenPositionTx`'s new check); requirements AC 4.8.
 *
 * R. A registered fill hook posts the correction at the settlement date
 *    (NFR Reliability)
 *   Pre: a worthless settlement; a fill hook registered to record contexts.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: the hook runs once with `occurredAt` equal to the removed exit
 *     fill's own `filledAt` (the settlement date).
 *   Source: design C5 post-condition 5; requirements NFR Reliability.
 *
 * S. A throwing hook rolls back everything and emits no event
 *    (NFR Reliability)
 *   Pre: a worthless settlement; a fill hook registered to throw.
 *   Call: `unsettle(db, userId, legId, result.settlementId)`.
 *   Result: rejects; the leg stays closed with its written exit fill intact;
 *     the settlement row still exists; `captureServerEvent` is never called.
 *   Source: requirements NFR Reliability.
 *
 * T. A refused unsettle fires no hook (NFR Reliability)
 *   Pre: a fill hook registered to record calls; a bogus settlement id.
 *   Call: `unsettle(db, userId, legId, 'not-a-real-id')`.
 *   Result: rejects `NotFoundError`; the hook is never called.
 *   Source: requirements NFR Reliability.
 *
 * Folded/out-of-scope criteria (recorded, not separately retested here):
 *   - AC 4.1 ("closed rows return open with closedAt null") folds into A, B
 *     and C, which each assert status/closedAt on every touched row as part
 *     of the "nets back" assertion.
 *   - AC 4.9 (compliance reads provisional after an unsettle) is
 *     RED-IMPOSSIBLE: `getPositionCompliance` (compliance.service.ts) takes
 *     the position's live `status` string as a plain parameter and stores no
 *     score; it has no special case for *how* a row became `open` again.
 *     `positions.compliance.test.ts`'s "marks an open position provisional,
 *     a closed one final, and a reopened one provisional again" test
 *     (:224-252) already proves the `status: 'open', closedAt: null`
 *     branch reads `finality: 'provisional'`, and unsettle's own flip
 *     (design C5 post-condition 4) produces that exact same state through
 *     the same `updatePosition` write. No new guard is added: the existing
 *     assertion at :252 already covers the one branch this criterion has.
 *   - The Restrictions ("no reverse hook runs", "never call removePosition",
 *     "the flip is never exposed alone") are implementation constraints, not
 *     separately observable success criteria; S's "stays closed, written
 *     exit fill intact" on a rollback is the closest observable proxy this
 *     task's scope allows for "the flip is never exposed alone" and
 *     "no reverse hook runs" (a reverse hook firing would itself attempt a
 *     ledger write inside the same rolled-back transaction).
 *   - `_how-its-built.json`, the eslint/check-types checklist items are
 *     implementer-side checks, not test-authorable criteria.
 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import {
  accounts,
  fills,
  optionSettlementRows,
  optionSettlements,
  positionGroups,
  positions,
  users,
} from '@/db/schema';
import { sumPostedRealizedForPosition } from '@/features/accounting/accounting.query';
import { postFillLedgerEntries } from '@/features/accounting/ledger-hook';
import {
  getTaxSummary,
  setTaxJurisdiction,
  setTaxLotMethod,
} from '@/features/expenses/expenses.service';
import type { SnapshotPosition } from '@/features/performance/performance.query';
import { classifyGroup } from '@/features/performance/performance.service';
import { deleteFill } from '@/features/positions/fills.query';
import { settleLeg, unsettle } from '@/features/positions/option-settlement.service';
import { insertPositionGroup } from '@/features/positions/position-groups.query';
import { linkPositionsTx } from '@/features/positions/position-groups.service';
import { deletePosition, updatePosition } from '@/features/positions/positions.query';
import {
  addFillTx,
  closePositionTx,
  createPositionTx,
  openPositionTx,
  registerFillHook,
  replaceFillHook,
  reopenPosition,
  reopenPositionTx,
  unregisterFillHook,
  type FillHookContext,
} from '@/features/positions/positions.service';
import { insertTransferLink } from '@/features/positions/transfer-links.query';
import { ConflictError, NotFoundError } from '@/lib/errors';
import * as posthog from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

// Form-3 OCC symbols, expiring 2026-07-17 (instant 2026-07-17T20:00:00.000Z —
// the same July EDT value `option-settlement.test.ts` proved).
const CALL_SYMBOL = 'AAPL260717C00150000';
const PUT_SYMBOL = 'AAPL260717P00150000';
const EXPIRY_INSTANT = new Date('2026-07-17T20:00:00.000Z');
const BEFORE_EXPIRY = '2026-06-01T00:00:00.000Z';

// A January expiry (EST, UTC-5) for the year-boundary test (P).
const JAN_SYMBOL = 'AAPL260117C00150000';
const JAN_EXPIRY = new Date('2026-01-17T21:00:00.000Z');

const HOOK_NAMES = ['option-unsettle-spy', 'option-unsettle-throw'];

afterEach(() => {
  for (const name of HOOK_NAMES) unregisterFillHook(name);
  unregisterFillHook('ledger');
  vi.restoreAllMocks();
});

let counter = 0;
function uniqueEmail() {
  return `option-unsettle-${Date.now()}-${++counter}@example.com`;
}

async function seedUserAndAccount(currency = 'USD') {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Unsettle Account', currency })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function createOptionLeg(params: {
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  filledAt: string;
  userId?: string;
  accountId?: string;
}) {
  const { userId, accountId } =
    params.userId && params.accountId
      ? { userId: params.userId, accountId: params.accountId }
      : await seedUserAndAccount();
  const { legId, entryFillId } = await withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, userId, {
      accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'option',
    });
    const entryFill = await addFillTx(tx, pos!.id, userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.filledAt,
    });
    await openPositionTx(tx, pos!.id, userId, params.filledAt);
    return { legId: pos!.id, entryFillId: entryFill.id as string };
  });
  return { userId, accountId, legId, entryFillId };
}

async function createStockRow(params: {
  userId: string;
  accountId: string;
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  entryFilledAt: string;
}) {
  return withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, params.userId, {
      accountId: params.accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'stock',
    });
    const entryFill = await addFillTx(tx, pos!.id, params.userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.entryFilledAt,
    });
    await openPositionTx(tx, pos!.id, params.userId, params.entryFilledAt);
    return { positionId: pos!.id, entryFillId: entryFill.id as string };
  });
}

async function getPositionRow(id: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id));
  return rows[0]!;
}

async function getPositionRowOrNull(id: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id));
  return rows[0] ?? null;
}

async function getFillsFor(positionId: string) {
  return db.select().from(fills).where(eq(fills.positionId, positionId));
}

async function getSettlementRow(settlementId: string) {
  const rows = await db
    .select()
    .from(optionSettlements)
    .where(eq(optionSettlements.id, settlementId));
  return rows[0] ?? null;
}

async function realizedTotal(positionId: string, userId: string): Promise<string> {
  const { total } = await withTransaction(db, (tx) =>
    sumPostedRealizedForPosition(tx, { userId, positionId }),
  );
  return total.toString();
}

function taxAmount(summary: Awaited<ReturnType<typeof getTaxSummary>>, currency: string): number {
  const row = summary.realisedPnl.perCurrency.find((c) => c.currency === currency);
  return row ? Number(row.amount) : 0;
}

// Registers the production 'ledger' fill hook (app.ts bootstrap's own
// registration) so the realized-P&L reads below (sumPostedRealizedForPosition,
// getTaxSummary's average-cost path) see real postings instead of a vacuous
// always-zero total. Unregistered by the top-level afterEach.
function registerLedger() {
  replaceFillHook('ledger', postFillLedgerEntries);
}

describe('unsettle — worthless settlement nets fills, ledger and status back (AC 4.1, 4.6)', () => {
  it('removes the written exit fill, reopens the leg, and returns the realised total to 0', async () => {
    registerLedger();
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const before = await realizedTotal(legId, userId);
    expect(before).toBe('0');

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    expect(await getFillsFor(legId)).toHaveLength(2);
    const afterSettle = await realizedTotal(legId, userId);
    expect(afterSettle).not.toBe('0');

    await unsettle(db, userId, legId, result.settlementId);

    const legFills = await getFillsFor(legId);
    expect(legFills).toHaveLength(1);
    expect(legFills[0]!.type).toBe('entry');

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(row.closedAt).toBeNull();

    expect(await realizedTotal(legId, userId)).toBe('0');
    expect(await getSettlementRow(result.settlementId)).toBeNull();
  });
});

describe('unsettle — assigned settlement deletes the opened stock row and nets both rows back (AC 4.1, 4.3, 4.6)', () => {
  it('deletes the new long row and reopens the leg', async () => {
    registerLedger();
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const stockRow = (
      await db.select().from(positions).where(eq(positions.accountId, accountId))
    ).find((p) => p.assetType === 'stock')!;
    expect(stockRow).toBeDefined();
    expect(await realizedTotal(legId, userId)).toBe('0'); // premium-priced exit is net-zero gross (AC 3.2)

    await unsettle(db, userId, legId, result.settlementId);

    expect(await getPositionRowOrNull(stockRow.id)).toBeNull();

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(row.closedAt).toBeNull();
    const legFills = await getFillsFor(legId);
    expect(legFills).toHaveLength(1);
    expect(legFills[0]!.type).toBe('entry');
  });
});

describe('unsettle — covered-call settlement exits a held row and nets both rows back (AC 4.1, 4.6)', () => {
  it('reopens the held long row with its original fill count and realised total', async () => {
    registerLedger();
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const held = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '90',
      entryQty: '100',
      entryFilledAt: '2026-01-01T00:00:00.000Z',
    });

    const beforeHeld = await realizedTotal(held.positionId, userId);
    expect(beforeHeld).toBe('0');

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    expect(await realizedTotal(held.positionId, userId)).not.toBe('0');
    const heldAfterSettle = await getPositionRow(held.positionId);
    expect(heldAfterSettle.status).toBe('closed');

    await unsettle(db, userId, legId, result.settlementId);

    const heldAfterUnsettle = await getPositionRow(held.positionId);
    expect(heldAfterUnsettle.status).toBe('open');
    expect(heldAfterUnsettle.closedAt).toBeNull();
    expect(await getFillsFor(held.positionId)).toHaveLength(1);
    expect(await realizedTotal(held.positionId, userId)).toBe(beforeHeld);

    const legRow = await getPositionRow(legId);
    expect(legRow.status).toBe('open');
    expect(legRow.closedAt).toBeNull();
  });
});

describe('unsettle — deleting the opened row never re-reverses an earlier partial exit on the leg (AC 4.3)', () => {
  it("leaves the leg's own posted realised total exactly where the partial exit left it", async () => {
    registerLedger();
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '2',
      filledAt: BEFORE_EXPIRY,
    });

    // A manual partial exit on the leg before the remainder is settled —
    // closes 1 of the 2 contracts early, realising its own P&L.
    await withTransaction(db, (tx) =>
      addFillTx(tx, legId, userId, {
        type: 'exit',
        price: '1.00',
        quantity: '1',
        fees: '0',
        filledAt: '2026-06-15T00:00:00.000Z',
      }),
    );
    const afterPartialExit = await realizedTotal(legId, userId);
    expect(afterPartialExit).not.toBe('0');

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const row = await getPositionRow(legId);
    expect(row.status).toBe('closed');

    const settlementRows = await db
      .select()
      .from(optionSettlementRows)
      .where(eq(optionSettlementRows.settlementId, result.settlementId));
    const openedRow = settlementRows.find((r) => r.touch === 'stock_opened')!;
    expect(openedRow).toBeDefined();

    await unsettle(db, userId, legId, result.settlementId);

    expect(await getPositionRowOrNull(openedRow.positionId!)).toBeNull();

    const legFills = await getFillsFor(legId);
    expect(legFills).toHaveLength(2); // entry + the earlier partial exit, settlement's own exit removed
    expect(await realizedTotal(legId, userId)).toBe(afterPartialExit);

    const reopenedLeg = await getPositionRow(legId);
    expect(reopenedLeg.status).toBe('open');
    expect(reopenedLeg.closedAt).toBeNull();
  });
});

describe('unsettle — a latch set from null returns to null (AC 4.4)', () => {
  it('clears lastFlatAt/lastFlatNetPnl set by the settlement itself', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    expect((await getPositionRow(legId)).lastFlatAt).toBeNull();

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    const afterSettle = await getPositionRow(legId);
    expect(afterSettle.lastFlatAt).not.toBeNull();

    await unsettle(db, userId, legId, result.settlementId);

    const afterUnsettle = await getPositionRow(legId);
    expect(afterUnsettle.lastFlatAt).toBeNull();
    expect(afterUnsettle.lastFlatNetPnl).toBeNull();
  });
});

describe('unsettle — a prior latch figure is restored (AC 4.4)', () => {
  it("restores the leg's latch from before the settlement overwrote it", async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const T0 = '2026-04-01T08:00:00.000Z';
    const T1 = '2026-04-01T09:00:00.000Z';
    const T2 = '2026-04-01T10:00:00.000Z';
    const T3 = '2026-04-01T11:00:00.000Z';

    const legId = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: CALL_SYMBOL,
        side: 'short',
        assetType: 'option',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '3',
        quantity: '2',
        fees: '0',
        filledAt: T0,
      });
      await openPositionTx(tx, pos!.id, userId, T0);
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '0.50',
        quantity: '2',
        fees: '0',
        filledAt: T1,
      });
      await closePositionTx(tx, pos!.id, userId, T1);
      await reopenPositionTx(tx, pos!.id, userId, T2);
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '3',
        quantity: '2',
        fees: '0',
        filledAt: T3,
      });
      return pos!.id;
    });

    const priorLatch = await getPositionRow(legId);
    expect(priorLatch.lastFlatAt).not.toBeNull();
    expect(priorLatch.lastFlatNetPnl).not.toBeNull();

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    const afterSettle = await getPositionRow(legId);
    expect(afterSettle.lastFlatAt!.getTime()).toBe(EXPIRY_INSTANT.getTime());

    await unsettle(db, userId, legId, result.settlementId);

    const afterUnsettle = await getPositionRow(legId);
    expect(afterUnsettle.lastFlatAt!.getTime()).toBe(priorLatch.lastFlatAt!.getTime());
    expect(afterUnsettle.lastFlatNetPnl).toBe(priorLatch.lastFlatNetPnl);
  });
});

describe('unsettle — a group un-latches with its last leg, with no group write (AC 4.4)', () => {
  it('reads flat before unsettle and not-flat after, with the group row unchanged', async () => {
    const {
      userId,
      accountId,
      legId: leg1Id,
    } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { legId: leg2Id } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
      userId,
      accountId,
    });

    const groupId = await withTransaction(db, (tx) =>
      linkPositionsTx(tx, userId, [leg1Id, leg2Id]),
    );
    const groupBefore = (
      await db.select().from(positionGroups).where(eq(positionGroups.id, groupId))
    )[0]!;

    // leg1 closes normally (never flat before), establishing its own latch.
    await withTransaction(db, async (tx) => {
      await addFillTx(tx, leg1Id, userId, {
        type: 'exit',
        price: '0.10',
        quantity: '1',
        fees: '0',
        filledAt: '2026-06-10T00:00:00.000Z',
      });
      await closePositionTx(tx, leg1Id, userId, '2026-06-10T00:00:00.000Z');
    });

    const result = await settleLeg(db, userId, leg2Id, { outcome: 'worthless' });

    async function snapshot(id: string): Promise<SnapshotPosition> {
      const row = await getPositionRow(id);
      const rowFills = await getFillsFor(id);
      return {
        id: row.id,
        side: row.side,
        assetType: row.assetType,
        symbol: row.symbol,
        currency: 'USD',
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
        status: row.status,
        lastFlatAt: row.lastFlatAt ? row.lastFlatAt.toISOString() : null,
        lastFlatNetPnl: row.lastFlatNetPnl,
        fills: rowFills.map((f) => ({
          type: f.type,
          price: f.price,
          quantity: f.quantity,
          fees: f.fees,
          filledAt: f.filledAt.toISOString(),
        })),
        tags: [],
        groupId,
      } as unknown as SnapshotPosition;
    }

    const beforeLegs = [await snapshot(leg1Id), await snapshot(leg2Id)];
    expect(classifyGroup(beforeLegs)).not.toBeNull();

    await unsettle(db, userId, leg2Id, result.settlementId);

    const afterLegs = [await snapshot(leg1Id), await snapshot(leg2Id)];
    expect(classifyGroup(afterLegs)).toBeNull();

    const groupAfter = (
      await db.select().from(positionGroups).where(eq(positionGroups.id, groupId))
    )[0]!;
    expect(groupAfter).toEqual(groupBefore);
  });
});

describe('unsettle — refusal: a later fill on a touched row (AC 4.7)', () => {
  it('rejects and writes nothing when the opened row took a fill after the settlement', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const stockRow = (
      await db.select().from(positions).where(eq(positions.accountId, accountId))
    ).find((p) => p.assetType === 'stock')!;

    await withTransaction(db, (tx) =>
      addFillTx(tx, stockRow.id, userId, {
        type: 'exit',
        price: '50',
        quantity: '10',
        fees: '0',
        filledAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    const fillsBefore = await getFillsFor(stockRow.id);

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect(await getSettlementRow(result.settlementId)).not.toBeNull();
    expect((await getPositionRow(legId)).status).toBe('closed');
    expect(await getFillsFor(stockRow.id)).toEqual(fillsBefore);
  });
});

describe('unsettle — refusal: a fill removed and a different one added, count unchanged (AC 4.7, design D2)', () => {
  it('still rejects even though the row carries the same fill count it did right after settlement', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const stockRow = (
      await db.select().from(positions).where(eq(positions.accountId, accountId))
    ).find((p) => p.assetType === 'stock')!;
    const writtenEntry = (await getFillsFor(stockRow.id))[0]!;
    expect(await getFillsFor(stockRow.id)).toHaveLength(1);

    await withTransaction(db, (tx) => deleteFill(tx, writtenEntry.id, stockRow.id));
    await withTransaction(db, (tx) =>
      addFillTx(tx, stockRow.id, userId, {
        type: 'entry',
        price: writtenEntry.price,
        quantity: writtenEntry.quantity,
        fees: '0',
        filledAt: writtenEntry.filledAt.toISOString(),
      }),
    );
    expect(await getFillsFor(stockRow.id)).toHaveLength(1); // same count as the settlement itself wrote

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect(await getFillsFor(stockRow.id)).toHaveLength(1);
    expect(await getSettlementRow(result.settlementId)).not.toBeNull();
  });
});

describe('unsettle — refusal: an opened row no longer exists (AC 4.7)', () => {
  it('rejects and leaves the settlement and leg untouched when the stock row was deleted', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const stockRow = (
      await db.select().from(positions).where(eq(positions.accountId, accountId))
    ).find((p) => p.assetType === 'stock')!;

    await withTransaction(db, (tx) => deletePosition(tx, stockRow.id, userId));

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect(await getSettlementRow(result.settlementId)).not.toBeNull();
    expect((await getPositionRow(legId)).status).toBe('closed');
  });
});

describe('unsettle — refusal: a written fill carries a transfer link (AC 4.7)', () => {
  it('rejects when the opened row’s entry fill is linked as a transfer', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const stockRow = (
      await db.select().from(positions).where(eq(positions.accountId, accountId))
    ).find((p) => p.assetType === 'stock')!;
    const writtenEntry = (await getFillsFor(stockRow.id))[0]!;

    const throwaway = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'MSFT',
      entryPrice: '50',
      entryQty: '10',
      entryFilledAt: '2026-05-01T00:00:00.000Z',
    });
    const throwawayExit = await withTransaction(db, (tx) =>
      addFillTx(tx, throwaway.positionId, userId, {
        type: 'exit',
        price: '55',
        quantity: '10',
        fees: '0',
        filledAt: '2026-05-02T00:00:00.000Z',
      }),
    );

    await withTransaction(db, (tx) =>
      insertTransferLink(tx, {
        userId,
        exitFillId: throwawayExit.id as string,
        entryFillId: writtenEntry.id,
      }),
    );

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect(await getSettlementRow(result.settlementId)).not.toBeNull();
    expect((await getPositionRow(legId)).status).toBe('closed');
  });
});

describe('unsettle — refusal: an opened row has joined a group (AC 4.7)', () => {
  it('rejects when the stock row the settlement opened now carries a group_id', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });
    const stockRow = (
      await db.select().from(positions).where(eq(positions.accountId, accountId))
    ).find((p) => p.assetType === 'stock')!;

    await withTransaction(db, async (tx) => {
      const [group] = await insertPositionGroup(tx, { userId, labelOverride: null });
      await updatePosition(tx, stockRow.id, userId, { groupId: group!.id });
    });

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect(await getSettlementRow(result.settlementId)).not.toBeNull();
    expect((await getPositionRow(legId)).status).toBe('closed');
  });
});

describe('unsettle — a second settlement touching the same row refuses the first, until undone (AC 4.7, design D2)', () => {
  it('refuses the put assignment while the call assignment stands, then succeeds once that is undone', async () => {
    const {
      userId,
      accountId,
      legId: putLegId,
    } = await createOptionLeg({
      side: 'short',
      symbol: PUT_SYMBOL,
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { legId: callLegId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
      userId,
      accountId,
    });

    const putResult = await settleLeg(db, userId, putLegId, { outcome: 'assigned' });
    const callResult = await settleLeg(db, userId, callLegId, { outcome: 'assigned' });

    await expect(unsettle(db, userId, putLegId, putResult.settlementId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    await unsettle(db, userId, callLegId, callResult.settlementId);

    await expect(unsettle(db, userId, putLegId, putResult.settlementId)).resolves.toBeUndefined();
  });
});

describe('unsettle — a double submit gets 404 on the second (design C5 post-condition 2)', () => {
  it('rejects NotFoundError once the settlement is already gone', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    await unsettle(db, userId, legId, result.settlementId);

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("unsettle — another user's id is 404 (NFR Security)", () => {
  it('rejects NotFoundError for a foreign userId', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    const { userId: otherUserId } = await seedUserAndAccount();

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });

    await expect(unsettle(db, otherUserId, legId, result.settlementId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("unsettle — across a year boundary, both years' tax summaries return to pre-settlement figures, under each lot method (AC 4.6)", () => {
  const configs: Array<{
    label: string;
    currency: string;
    jurisdiction: 'US' | 'CA';
    lotMethod: 'fifo' | 'average' | null;
  }> = [
    { label: 'US default (fifo)', currency: 'USD', jurisdiction: 'US', lotMethod: null },
    { label: 'US explicit average', currency: 'USD', jurisdiction: 'US', lotMethod: 'average' },
    { label: 'CA (acb)', currency: 'CAD', jurisdiction: 'CA', lotMethod: null },
  ];

  for (const cfg of configs) {
    it(`restores 2025 and 2026 for ${cfg.label}`, async () => {
      registerLedger();
      const { userId: seedUserId, accountId } = await seedUserAndAccount(cfg.currency);
      const { userId, legId } = await createOptionLeg({
        side: 'short',
        symbol: JAN_SYMBOL,
        entryPrice: '3',
        entryQty: '1',
        filledAt: '2025-12-01T00:00:00.000Z',
        userId: seedUserId,
        accountId,
      });

      await setTaxJurisdiction(userId, cfg.jurisdiction);
      if (cfg.lotMethod) await setTaxLotMethod(userId, cfg.lotMethod);

      const before2025 = await getTaxSummary(userId, 2025);
      const before2026 = await getTaxSummary(userId, 2026);

      const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
      expect(new Date(result.settledAt).getTime()).toBe(JAN_EXPIRY.getTime());

      const afterSettle2026 = await getTaxSummary(userId, 2026);
      expect(taxAmount(afterSettle2026, cfg.currency)).not.toBe(
        taxAmount(before2026, cfg.currency),
      );

      await unsettle(db, userId, legId, result.settlementId);

      const after2025 = await getTaxSummary(userId, 2025);
      const after2026 = await getTaxSummary(userId, 2026);
      expect(taxAmount(after2025, cfg.currency)).toBe(taxAmount(before2025, cfg.currency));
      expect(taxAmount(after2026, cfg.currency)).toBe(taxAmount(before2026, cfg.currency));
    });
  }
});

describe('unsettle — reopen of a touched row is a 409 naming unsettle, whatever the same-day guard says (AC 4.8)', () => {
  it('refuses a same-day reopen attempt', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2026-07-17T13:00:00.000Z', // same NY day as EXPIRY_INSTANT
    });

    await settleLeg(db, userId, legId, { outcome: 'worthless' });
    expect((await getPositionRow(legId)).status).toBe('closed');

    const err: unknown = await reopenPosition(db, legId, userId, '2026-07-17T21:00:00.000Z').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('unsettle');
  });

  it('refuses a different-day reopen attempt too', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'worthless' });

    const err: unknown = await reopenPosition(db, legId, userId).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('unsettle');
  });
});

describe('unsettle — a registered fill hook posts the correction at the settlement date (NFR Reliability)', () => {
  it('runs the hook once with occurredAt equal to the removed exit fill’s filledAt', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });

    const seen: FillHookContext[] = [];
    registerFillHook('option-unsettle-spy', async (_tx, ctx) => {
      seen.push(ctx);
    });

    await unsettle(db, userId, legId, result.settlementId);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.occurredAt.getTime()).toBe(EXPIRY_INSTANT.getTime());
  });
});

describe('unsettle — a throwing hook rolls back everything and emits no event (NFR Reliability)', () => {
  it('rejects, leaves the leg closed, and never captures position_unsettled', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });

    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});
    registerFillHook('option-unsettle-throw', async () => {
      throw new Error('injected unsettle fill-hook failure');
    });

    await expect(unsettle(db, userId, legId, result.settlementId)).rejects.toThrow(
      'injected unsettle fill-hook failure',
    );

    expect(captureSpy).not.toHaveBeenCalledWith('position_unsettled', expect.anything());
    const row = await getPositionRow(legId);
    expect(row.status).toBe('closed');
    expect(await getFillsFor(legId)).toHaveLength(2);
    expect(await getSettlementRow(result.settlementId)).not.toBeNull();
  });
});

describe('unsettle — a refused unsettle fires no hook (NFR Reliability)', () => {
  it('never calls the registered fill hook when the settlement id does not exist', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const seen: FillHookContext[] = [];
    registerFillHook('option-unsettle-spy', async (_tx, ctx) => {
      seen.push(ctx);
    });

    await expect(
      unsettle(db, userId, legId, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(seen).toHaveLength(0);
  });
});
