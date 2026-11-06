/**
 * Close and fill-removal seams (design C4; task 6 of option-lifecycle-events).
 * Black-box over the tx-accepting seams directly, matching the house style of
 * `positions.bulk-tx.test.ts` — seed via raw inserts, drive one transaction
 * at a time through the exported `*Tx` functions, assert on committed state.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * closeIfBalancedTx — closes a balanced open row (REQ-3.7)
 *   Pre: an open stock position with one entry fill and a balancing exit
 *     fill of the same quantity, added directly via `addFillTx` (no
 *     auto-close, since that lives in `addFill`, not this seam).
 *   Call: `closeIfBalancedTx(tx, positionId, userId, exitFilledAt)`.
 *   Result: the position closes — the returned row has `status: 'closed'`
 *     and `closedAt` equal to the exit's `filledAt`; committed state agrees.
 *   Source: design.md C4 ("extracted from addFill"); requirements.md AC 3.7.
 *
 * closeIfBalancedTx — returns null on an unbalanced row
 *   Pre: an open stock position with one entry fill and a smaller, partial
 *     exit fill.
 *   Call: `closeIfBalancedTx(tx, positionId, userId, exitFilledAt)`.
 *   Result: returns `null`; the position stays `open` in committed state.
 *   Source: design.md C4 Success bullet ("returns null on an unbalanced row").
 *
 * closeIfBalancedTx — clamps closedAt to openedAt for an older fill (D5)
 *   Pre: an open position whose `openedAt` is later than its balancing exit
 *     fill's `filledAt` (a backdated exit recorded after an undated open).
 *   Call: `closeIfBalancedTx(tx, positionId, userId, exitFilledAt)`.
 *   Result: the returned row's `closedAt` equals `openedAt`, not the earlier
 *     `exitFilledAt`.
 *   Source: design.md D5; positions.service.ts `addFill`'s existing clamp.
 *
 * closePositionTx — opts.fillJustWritten skips the reopen guard (D7)
 *   Pre: a position opened, closed, then reopened same-day (real close +
 *     reverse ledger hooks registered, so `reopenedWithoutNewFills` reads a
 *     true reopen marker) with no fill added since the reopen.
 *   Call: `closePositionTx(tx, id, userId, laterDate)` with no opts, then
 *     again with `{ fillJustWritten: true }` in a fresh transaction.
 *   Result: no opts → rejects with the existing reopen-guard ConflictError
 *     (409); `fillJustWritten: true` → succeeds, returning a closed row.
 *   Source: design.md D7; positions.service.ts closePositionTx's existing
 *     `reopenedWithoutNewFills` refusal.
 *
 * removeRecordedFillTx — removes an open row's sole entry, posts the
 * correcting delta at the fill's filledAt (REQ-4.2)
 *   Pre: an open position with exactly one fill (its entry); a fill hook
 *     registered to observe the hook context passed on removal.
 *   Call: `removeRecordedFillTx(tx, positionId, fill, userId)` with the
 *     entry fill's own row.
 *   Result: the position's fill count drops to zero; the registered fill
 *     hook runs exactly once with `ctx.occurredAt` equal to the removed
 *     fill's `filledAt` (the correcting delta's posting time); the position
 *     stays `open` (no status write of its own).
 *   Source: requirements.md AC 4.2; design.md C4 ("the deleteFill plus
 *     runFillHooks tail of removeFill").
 *
 * Folded/out-of-scope criteria (recorded, not retested here):
 *   - `positions.test.ts` and `fills.test.ts` are regression guards per the
 *     task: `addFill` and `removeFill` keep every existing behaviour and
 *     assertion unchanged. They are not new red tests — they already pass
 *     at base and must keep passing after the extraction.
 *   - `_how-its-built.json`, the eslint/check-types checklist items, are
 *     implementer-side checks, not test-authorable criteria.
 */
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { db } from '@/db';
import { accounts, fills, positions, users } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import {
  addFillTx,
  closeIfBalancedTx,
  closePositionTx,
  createPositionTx,
  openPositionTx,
  registerFillHook,
  reopenPositionTx,
  replaceCloseHook,
  replaceReverseHook,
  unregisterCloseHook,
  unregisterFillHook,
  unregisterReverseHook,
  removeRecordedFillTx,
  type FillHookContext,
} from '@/features/positions/positions.service';
import { withTransaction } from '@/lib/transaction';

let counter = 0;
function uniqueEmail() {
  return `option-seams-${Date.now()}-${++counter}@example.com`;
}

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Seams Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function getPositionRow(id: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id));
  return rows[0]!;
}

async function countFillsForPosition(positionId: string): Promise<number> {
  const rows = await db
    .select({ count: drizzleSql<number>`count(*)::int` })
    .from(fills)
    .where(eq(fills.positionId, positionId));
  return rows[0]!.count;
}

describe('option-seams — closeIfBalancedTx', () => {
  it('closes a balanced open row and returns it, with closedAt at the exit fill (AC 3.7)', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const openedAt = '2026-02-01T00:00:00.000Z';
    const exitFilledAt = '2026-02-02T00:00:00.000Z';

    const { positionId, closedRow } = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '0',
        filledAt: openedAt,
      });
      await openPositionTx(tx, pos!.id, userId, openedAt);
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '110',
        quantity: '10',
        fees: '0',
        filledAt: exitFilledAt,
      });
      const closedRow = await closeIfBalancedTx(tx, pos!.id, userId, exitFilledAt);
      return { positionId: pos!.id, closedRow };
    });

    expect(closedRow).not.toBeNull();
    expect(closedRow!.status).toBe('closed');
    expect(new Date(closedRow!.closedAt!).getTime()).toBe(new Date(exitFilledAt).getTime());

    const committed = await getPositionRow(positionId);
    expect(committed.status).toBe('closed');
    expect(new Date(committed.closedAt!).getTime()).toBe(new Date(exitFilledAt).getTime());
  });

  it('returns null on an unbalanced row and leaves the position open', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const openedAt = '2026-02-10T00:00:00.000Z';
    const exitFilledAt = '2026-02-11T00:00:00.000Z';

    const { positionId, closedRow } = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '0',
        filledAt: openedAt,
      });
      await openPositionTx(tx, pos!.id, userId, openedAt);
      // Partial exit — 4 of 10 — leaves the row unbalanced.
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '110',
        quantity: '4',
        fees: '0',
        filledAt: exitFilledAt,
      });
      const closedRow = await closeIfBalancedTx(tx, pos!.id, userId, exitFilledAt);
      return { positionId: pos!.id, closedRow };
    });

    expect(closedRow).toBeNull();
    const committed = await getPositionRow(positionId);
    expect(committed.status).toBe('open');
  });

  it('clamps closedAt to openedAt for a fill older than the open (design D5)', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    // Entry recorded before the (undated) open; the open is then stamped
    // later than both the entry and the balancing exit — the backdated-exit
    // scenario `addFill`'s existing clamp comment describes.
    const entryFilledAt = '2026-03-01T00:00:00.000Z';
    const exitFilledAt = '2026-03-02T00:00:00.000Z';
    const openedAt = '2026-03-05T00:00:00.000Z';

    const { positionId, closedRow } = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '0',
        filledAt: entryFilledAt,
      });
      await openPositionTx(tx, pos!.id, userId, openedAt);
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '110',
        quantity: '10',
        fees: '0',
        filledAt: exitFilledAt,
      });
      const closedRow = await closeIfBalancedTx(tx, pos!.id, userId, exitFilledAt);
      return { positionId: pos!.id, closedRow };
    });

    expect(closedRow).not.toBeNull();
    expect(new Date(closedRow!.closedAt!).getTime()).toBe(new Date(openedAt).getTime());

    const committed = await getPositionRow(positionId);
    expect(new Date(committed.closedAt!).getTime()).toBe(new Date(openedAt).getTime());
  });
});

describe('option-seams — closePositionTx opts.fillJustWritten (design D7)', () => {
  afterEach(() => {
    unregisterCloseHook('ledger');
    unregisterReverseHook('ledger');
  });

  it('is refused by the reopen guard without the opt, and succeeds with it', async () => {
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    replaceReverseHook('ledger', reversePositionCloseLedgerEntries);

    const { userId, accountId } = await seedUserAndAccount();
    // All same ET calendar day (America/New_York, the account default), so
    // the reopen's own same-day guard passes.
    const openedAt = '2026-04-01T10:00:00.000Z';
    const firstClosedAt = '2026-04-01T12:00:00.000Z';
    const reopenedAt = '2026-04-01T14:00:00.000Z';
    const secondClosedAt = '2026-04-01T16:00:00.000Z';

    const positionId = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '0',
        filledAt: openedAt,
      });
      await openPositionTx(tx, pos!.id, userId, openedAt);
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '105',
        quantity: '10',
        fees: '0',
        filledAt: firstClosedAt,
      });
      await closePositionTx(tx, pos!.id, userId, firstClosedAt);
      await reopenPositionTx(tx, pos!.id, userId, reopenedAt);
      return pos!.id;
    });
    expect((await getPositionRow(positionId)).status).toBe('open');

    // No new fill since the reopen, no opts — the existing refusal fires.
    await expect(
      withTransaction(db, (tx) => closePositionTx(tx, positionId, userId, secondClosedAt)),
    ).rejects.toMatchObject({
      message: expect.stringContaining('nothing has changed since the reopen'),
    });
    expect((await getPositionRow(positionId)).status).toBe('open');

    // Same scenario, fillJustWritten: true — the refusal is skipped.
    const closedRow = await withTransaction(db, (tx) =>
      closePositionTx(tx, positionId, userId, secondClosedAt, { fillJustWritten: true }),
    );
    expect(closedRow.status).toBe('closed');
    expect((await getPositionRow(positionId)).status).toBe('closed');
  });
});

describe('option-seams — removeRecordedFillTx', () => {
  afterEach(() => {
    unregisterFillHook('option-seams-spy');
  });

  it("removes an open row's sole entry and runs the fill hook at the fill's filledAt (AC 4.2)", async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const entryFilledAt = '2026-05-01T00:00:00.000Z';

    const seen: FillHookContext[] = [];
    registerFillHook('option-seams-spy', async (_tx, ctx) => {
      seen.push(ctx);
    });

    const { positionId, entryFill } = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      const entryFill = await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '0',
        filledAt: entryFilledAt,
      });
      await openPositionTx(tx, pos!.id, userId, entryFilledAt);
      // The hook above has already run once, for the add. Clear it so the
      // assertion below is only about the removal's own call.
      seen.length = 0;
      await removeRecordedFillTx(tx, pos!.id, entryFill, userId);
      return { positionId: pos!.id, entryFill };
    });

    expect(await countFillsForPosition(positionId)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.occurredAt.getTime()).toBe(new Date(entryFill.filledAt).getTime());

    const committed = await getPositionRow(positionId);
    expect(committed.status).toBe('open');
  });
});
