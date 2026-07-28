import { eq, and } from 'drizzle-orm';

import type { Transaction } from '@/db';
import { fills } from '@/db/schema';

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
