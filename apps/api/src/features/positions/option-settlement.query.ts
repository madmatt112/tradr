import type { Transaction } from '@/db';
import { optionSettlementFills, optionSettlementRows, optionSettlements } from '@/db/schema';

// Writes for one settlement record (design C3 post-condition 8). Split out of
// the service so the transaction-scoped inserts have a single, testable seam —
// matching the repo convention of a thin query layer behind the service.

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
