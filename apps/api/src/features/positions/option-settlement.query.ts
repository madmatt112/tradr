import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Transaction } from '@/db';
import { fills, optionSettlementFills, optionSettlementRows, optionSettlements } from '@/db/schema';

// Writes for one settlement record (design C3 post-condition 8). Split out of
// the service so the transaction-scoped inserts have a single, testable seam —
// matching the repo convention of a thin query layer behind the service.

/**
 * The eligible stock rows for a leg's stock-side outcome (design C3 post-
 * condition 1): open, long, stock, same account, `symbol` equal to the OCC
 * underlying, open units above zero. Called unlocked before the lock and
 * again after it, so the caller can detect a changed set — the
 * `findOpenOptionLegs` open-units-in-SQL precedent (`positions.query.ts`).
 */
export async function findCandidateStockRows(
  tx: Transaction,
  userId: string,
  accountId: string,
  symbol: string,
): Promise<Array<{ id: string; openedAt: Date; openUnits: string }>> {
  const rows = await tx.execute(sql`
    SELECT p.id, p.opened_at,
      COALESCE(SUM(CASE WHEN f.type = 'entry' THEN f.quantity END), 0)
      - COALESCE(SUM(CASE WHEN f.type = 'exit' THEN f.quantity END), 0) AS open_units
    FROM positions p
    LEFT JOIN fills f ON f.position_id = p.id
    WHERE p.user_id = ${userId}
      AND p.account_id = ${accountId}
      AND p.symbol = ${symbol}
      AND p.status = 'open'
      AND p.side = 'long'
      AND p.asset_type = 'stock'
    GROUP BY p.id, p.opened_at
    HAVING COALESCE(SUM(CASE WHEN f.type = 'entry' THEN f.quantity END), 0)
         - COALESCE(SUM(CASE WHEN f.type = 'exit' THEN f.quantity END), 0) > 0
    ORDER BY p.opened_at ASC
  `);
  return rows.map((row) => ({
    id: row.id as string,
    openedAt: new Date(row.opened_at as string),
    openUnits: String(row.open_units),
  }));
}

export function insertOptionSettlement(
  tx: Transaction,
  data: {
    userId: string;
    positionId: string;
    outcome: string;
    quantity: string;
    premium: string;
    settledAt: Date;
  },
) {
  return tx.insert(optionSettlements).values(data).returning();
}

export function insertOptionSettlementRows(
  tx: Transaction,
  rows: Array<{
    settlementId: string;
    positionId: string | null;
    touch: string;
    closedRow: boolean;
    priorLastFlatAt: Date | null;
    priorLastFlatNetPnl: string | null;
  }>,
) {
  return tx.insert(optionSettlementRows).values(rows).returning();
}

export function insertOptionSettlementFills(
  tx: Transaction,
  rows: Array<{ settlementId: string; fillId: string; written: boolean }>,
) {
  return tx.insert(optionSettlementFills).values(rows).returning();
}

// Reads for unsettle (design C5). The record alone is the source of truth for
// every refusal check, so these are plain, unlocked selects — the caller locks
// the touched positions themselves via `lockLegs`.

/** Scoped by user and leg, so a foreign id or a wrong leg reads as a 404. */
export function findOptionSettlementByLeg(
  tx: Transaction,
  settlementId: string,
  legId: string,
  userId: string,
) {
  return tx
    .select()
    .from(optionSettlements)
    .where(
      and(
        eq(optionSettlements.id, settlementId),
        eq(optionSettlements.positionId, legId),
        eq(optionSettlements.userId, userId),
      ),
    )
    .limit(1);
}

export function findOptionSettlementRows(tx: Transaction, settlementId: string) {
  return tx
    .select()
    .from(optionSettlementRows)
    .where(eq(optionSettlementRows.settlementId, settlementId));
}

export function findOptionSettlementFills(tx: Transaction, settlementId: string) {
  return tx
    .select()
    .from(optionSettlementFills)
    .where(eq(optionSettlementFills.settlementId, settlementId));
}

/** The full fill rows for a settlement's written fills, read by id. */
export function findFillsByIds(tx: Transaction, fillIds: string[]) {
  if (fillIds.length === 0) return Promise.resolve([]);
  return tx.select().from(fills).where(inArray(fills.id, fillIds));
}

/** Cascades: its rows and fills (settlement_id CASCADE) go with it. */
export function deleteOptionSettlement(tx: Transaction, settlementId: string) {
  return tx.delete(optionSettlements).where(eq(optionSettlements.id, settlementId)).returning();
}

/**
 * Design C4 last bullet: whether any settlement has touched this position —
 * the reopen guard's own check. `position_id` is `SET NULL` on delete, so a
 * row that no longer exists stops being "touched" for this purpose, which is
 * fine: it has nothing left to reopen.
 */
export async function isRowSettlementTouched(
  tx: Transaction,
  positionId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: optionSettlementRows.id })
    .from(optionSettlementRows)
    .where(eq(optionSettlementRows.positionId, positionId))
    .limit(1);
  return rows.length > 0;
}
