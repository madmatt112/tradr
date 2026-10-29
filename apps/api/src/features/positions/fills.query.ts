import { eq, and } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { fills, fillLotSelections } from '@/db/schema';

export function insertFill(
  tx: Transaction,
  data: {
    positionId: string;
    type: string;
    price: string;
    quantity: string;
    fees: string;
    notes?: string | null;
    filledAt: Date;
  },
) {
  return tx.insert(fills).values(data).returning();
}

export function findFillById(tx: Transaction, fillId: string, positionId: string) {
  return tx
    .select()
    .from(fills)
    .where(and(eq(fills.id, fillId), eq(fills.positionId, positionId)))
    .limit(1);
}

export function updateFill(
  tx: Transaction,
  fillId: string,
  positionId: string,
  data: Partial<{
    price: string;
    quantity: string;
    fees: string;
    notes: string | null;
    filledAt: Date;
  }>,
) {
  return tx
    .update(fills)
    .set(data)
    .where(and(eq(fills.id, fillId), eq(fills.positionId, positionId)))
    .returning();
}

export function deleteFill(tx: Transaction, fillId: string, positionId: string) {
  return tx
    .delete(fills)
    .where(and(eq(fills.id, fillId), eq(fills.positionId, positionId)))
    .returning();
}

// Lot selection store (design C3). Rows pair an exit fill with one entry
// fill it is matched against and the quantity consumed from that lot.
export function insertLotSelections(
  tx: Transaction,
  exitFillId: string,
  items: { entryFillId: string; quantity: string }[],
) {
  return tx
    .insert(fillLotSelections)
    .values(
      items.map((item) => ({ exitFillId, entryFillId: item.entryFillId, quantity: item.quantity })),
    )
    .returning();
}

export function deleteLotSelectionsForExit(tx: Transaction, exitFillId: string) {
  return tx
    .delete(fillLotSelections)
    .where(eq(fillLotSelections.exitFillId, exitFillId))
    .returning();
}

// All stored selections for a position's fills — joined through the exit
// fill so matching never crosses positions (design C4 / AC 1.6).
export function findLotSelectionsByPosition(db: Database | Transaction, positionId: string) {
  return db
    .select({
      exitFillId: fillLotSelections.exitFillId,
      entryFillId: fillLotSelections.entryFillId,
      quantity: fillLotSelections.quantity,
    })
    .from(fillLotSelections)
    .innerJoin(fills, eq(fills.id, fillLotSelections.exitFillId))
    .where(eq(fills.positionId, positionId));
}
