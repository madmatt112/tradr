import { eq, sql as drizzleSql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { accounts, ledgerEntries, positions, users } from '@/db/schema';
import * as accountsQuery from '@/features/accounts/accounts.query';
import {
  addFillTx,
  closePositionTx,
  createPositionTx,
  listCloseHooks,
  openPositionTx,
  registerCloseHook,
  unregisterCloseHook,
  type CloseHook,
} from '@/features/positions/positions.service';
import {
  validateSegmentInvariants,
  type InMemoryFill,
} from '@/features/positions/segment-invariants';
import { withTransaction } from '@/lib/transaction';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail() {
  return `pos-bulk-${Date.now()}-${++counter}@example.com`;
}

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Bulk Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function countPositions(userId: string): Promise<number> {
  const rows = await db
    .select({ count: drizzleSql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.userId, userId));
  return rows[0]!.count;
}

// ---------------------------------------------------------------------------
// (a) FK 23503 propagates (not swallowed) and rolls back the whole import.
// ---------------------------------------------------------------------------

describe('bulk-composition — (a) FK 23503 propagates & rolls back', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createPositionTx propagates a 23503 FK violation, rolling back prior segment writes', async () => {
    const { userId, accountId } = await seedUserAndAccount();

    // Force the second createPositionTx to pass its ownership guard but hit a
    // missing-account FK at insert time: stub findAccountById to return a row
    // for a non-existent accountId. The catch-free *Tx variant must NOT swallow
    // the resulting 23503 — it propagates and rolls back the whole tx.
    const bogusAccountId = '00000000-0000-0000-0000-0000000000ff';
    const realFind = accountsQuery.findAccountById;
    const fakeFind = (async (
      executor: Parameters<typeof accountsQuery.findAccountById>[0],
      id: string,
      uid: string,
    ) => {
      if (id === bogusAccountId) {
        return [{ id: bogusAccountId, userId: uid, name: 'ghost', currency: 'USD' }];
      }
      return realFind(executor, id, uid);
    }) as unknown as typeof accountsQuery.findAccountById;
    vi.spyOn(accountsQuery, 'findAccountById').mockImplementation(fakeFind);

    await expect(
      withTransaction(db, async (tx) => {
        // First segment writes a real position.
        await createPositionTx(tx, userId, {
          accountId,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
        });
        // Second segment targets a non-existent account → FK 23503 at insert.
        await createPositionTx(tx, userId, {
          accountId: bogusAccountId,
          symbol: 'MSFT',
          side: 'long',
          assetType: 'stock',
        });
      }),
    ).rejects.toMatchObject({ code: '23503' });

    // Whole import rolled back — the first segment's position is gone.
    expect(await countPositions(userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) A mid-segment validation failure rolls back all prior segments.
// ---------------------------------------------------------------------------

describe('bulk-composition — (b) mid-segment validation failure rolls back prior segments', () => {
  it('a ConflictError in segment 2 rolls back segment 1', async () => {
    const { userId, accountId } = await seedUserAndAccount();

    await expect(
      withTransaction(db, async (tx) => {
        // Segment 1: a valid draft position + entry fill.
        const p1 = await createPositionTx(tx, userId, {
          accountId,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
        });
        await addFillTx(tx, p1!.id, userId, {
          type: 'entry',
          price: '100',
          quantity: '10',
          fees: '0',
          filledAt: '2026-01-01T00:00:00Z',
        });

        // Segment 2: attempt to add an exit fill to a draft position → the
        // live ConflictError guard inside addFillTx fires mid-import.
        const p2 = await createPositionTx(tx, userId, {
          accountId,
          symbol: 'MSFT',
          side: 'long',
          assetType: 'stock',
        });
        await addFillTx(tx, p2!.id, userId, {
          type: 'exit',
          price: '50',
          quantity: '5',
          fees: '0',
          filledAt: '2026-01-01T00:00:00Z',
        });
      }),
    ).rejects.toThrow('Cannot add exit fill to a draft position');

    // Both segments rolled back — no positions persisted, so segment 1's
    // entry fill (FK-bound to its position) is gone too.
    expect(await countPositions(userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) The close hook fires INSIDE the bulk tx.
// ---------------------------------------------------------------------------

describe('bulk-composition — (c) close hook fires inside the bulk tx', () => {
  afterEach(() => {
    for (const name of listCloseHooks()) unregisterCloseHook(name);
  });

  it('closePositionTx fires the registered hook within the injected tx and commits atomically', async () => {
    const { userId, accountId } = await seedUserAndAccount();

    let hookTxSeen = false;
    const groupId = crypto.randomUUID();
    const hook: CloseHook = async (tx, ctx) => {
      hookTxSeen = true;
      // Write a ledger entry inside the SAME injected tx.
      await tx.insert(ledgerEntries).values({
        userId: ctx.position.userId,
        accountId: ctx.account.id,
        positionId: ctx.position.id,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: ctx.netPnl,
        currency: ctx.account.currency,
        symbol: ctx.position.symbol,
        occurredAt: new Date('2026-01-02T00:00:00Z'),
        groupId,
        reversesGroupId: null,
      });
    };
    registerCloseHook('bulk-close-hook', hook);

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
        filledAt: '2026-01-01T00:00:00Z',
      });
      await openPositionTx(tx, pos!.id, userId, '2026-01-01T00:00:00Z');
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '105',
        quantity: '10',
        fees: '0',
        filledAt: '2026-01-02T00:00:00Z',
      });
      await closePositionTx(tx, pos!.id, userId, '2026-01-02T00:00:00Z');
      return pos!.id;
    });

    expect(hookTxSeen).toBe(true);

    // The ledger entry the hook wrote committed atomically with the close.
    const ledgerRows = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(ledgerRows[0]!.count).toBe(1);

    const posRow = await db.select().from(positions).where(eq(positions.id, positionId));
    expect(posRow[0]!.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// (d) Ordering-identity: segment-invariants driven incrementally (service path)
// and over the whole ordered set (preview path) produce identical results for
// the same-instant interleave fixture entry 100, exit 60, entry 50, exit 90.
// ---------------------------------------------------------------------------

describe('bulk-composition — (d) ordering-identity (segment-invariants)', () => {
  const sameInstant = '2026-01-01T00:00:00Z';
  const orderedFills: InMemoryFill[] = [
    { type: 'entry', quantity: '100', filledAt: sameInstant },
    { type: 'exit', quantity: '60', filledAt: sameInstant },
    { type: 'entry', quantity: '50', filledAt: sameInstant },
    { type: 'exit', quantity: '90', filledAt: sameInstant },
  ];

  it('the service (incremental) path commits the ordered interleave with no invariant errors', async () => {
    // Whole-set check (preview path) — the segment closes & reconciles
    // (150 entry == 150 exit), no exit ever exceeds the running entry total.
    const previewErrors = validateSegmentInvariants(orderedFills, {
      assetType: 'stock',
      closes: true,
      openedAt: sameInstant,
      closedAt: sameInstant,
    });
    expect(previewErrors).toEqual([]);

    // Service (incremental) path — replay the SAME ordered set through the
    // live *Tx writes and confirm each per-fill guard passes (no throw), then
    // the close reconciles. This is the same incremental walk the preview
    // composite performs, proving ordering identity.
    const { userId, accountId } = await seedUserAndAccount();
    const closed = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      let opened = false;
      for (const f of orderedFills) {
        if (!opened && f.type === 'exit') {
          await openPositionTx(tx, pos!.id, userId, sameInstant);
          opened = true;
        }
        await addFillTx(tx, pos!.id, userId, {
          type: f.type,
          price: '1',
          quantity: f.quantity,
          fees: '0',
          filledAt: sameInstant,
        });
      }
      return closePositionTx(tx, pos!.id, userId, sameInstant);
    });
    expect(closed.status).toBe('closed');
  });

  it('an out-of-order interleave (exit 90 before its entry) fails BOTH paths identically', async () => {
    // exit 90 lands while only 100 entry then 60 exit have accumulated:
    // running entry 100, exit total after 60 is 60; a 90 exit → 150 > 100 →
    // EXIT_EXCEEDS_ENTRY at index 1 in this reordering.
    const badOrder: InMemoryFill[] = [
      { type: 'entry', quantity: '100', filledAt: sameInstant },
      { type: 'exit', quantity: '90', filledAt: sameInstant },
      { type: 'exit', quantity: '60', filledAt: sameInstant },
      { type: 'entry', quantity: '50', filledAt: sameInstant },
    ];

    // Preview path: the whole-set walk flags the over-exit.
    const previewErrors = validateSegmentInvariants(badOrder, {
      assetType: 'stock',
      closes: true,
      openedAt: sameInstant,
      closedAt: sameInstant,
    });
    expect(previewErrors.some((e) => e.code === 'EXIT_EXCEEDS_ENTRY')).toBe(true);

    // Service path: the same over-exit trips addFillTx's live guard.
    const { userId, accountId } = await seedUserAndAccount();
    await expect(
      withTransaction(db, async (tx) => {
        const pos = await createPositionTx(tx, userId, {
          accountId,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
        });
        await addFillTx(tx, pos!.id, userId, {
          type: 'entry',
          price: '1',
          quantity: '100',
          fees: '0',
          filledAt: sameInstant,
        });
        await openPositionTx(tx, pos!.id, userId, sameInstant);
        await addFillTx(tx, pos!.id, userId, {
          type: 'exit',
          price: '1',
          quantity: '90',
          fees: '0',
          filledAt: sameInstant,
        });
        // This exit would push exit total to 150 > 100 entry → ValidationError.
        await addFillTx(tx, pos!.id, userId, {
          type: 'exit',
          price: '1',
          quantity: '60',
          fees: '0',
          filledAt: sameInstant,
        });
      }),
    ).rejects.toThrow('Exit quantity would exceed available entry quantity');

    expect(await countPositions(userId)).toBe(0);
  });
});
