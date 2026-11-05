import { sql } from 'drizzle-orm';

import type { Transaction } from '@/db';
import { optionSettlementFills, optionSettlementRows, optionSettlements } from '@/db/schema';

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
