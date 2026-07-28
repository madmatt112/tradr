import { eq, and, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { positions, fills, accounts, brokerages, feeSchedules } from '@/db/schema';

export function insertPosition(
  tx: Transaction,
  data: {
    userId: string;
    accountId: string;
    symbol: string;
    side: string;
    assetType: string;
    notes?: string | null;
    targetPrice?: string | null;
    stopLoss?: string | null;
  },
) {
  return tx.insert(positions).values(data).returning();
}

/**
 * Per-user position count (all accounts, all statuses) for the L2 creation
 * cap (plan-tiers REQ-6.1/6.3). Indexed `count(*)` over
 * `positions_user_id_idx` — the `admin.query.ts` per-user count precedent;
 * the small concurrent-overshoot posture is accepted.
 */
export async function countPositionsByUser(
  db: Database | Transaction,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.userId, userId));
  return row?.count ?? 0;
}

export function findPositionListByUser(
  db: Database | Transaction,
  userId: string,
  filters?: { status?: string; accountId?: string },
) {
  const conditions = [eq(positions.userId, userId)];
  if (filters?.status) {
    conditions.push(eq(positions.status, filters.status));
  }
  if (filters?.accountId) {
    conditions.push(eq(positions.accountId, filters.accountId));
  }

  return db.execute(sql`
    SELECT p.*,
      a.name AS account_name,
      a.currency AS account_currency,
      a.timezone AS account_timezone,
      b.name AS brokerage_name,
      fs.stock_per_share_commission,
      fs.stock_min_per_fill,
      fs.stock_max_per_fill,
      fs.options_per_contract_commission,
      fs.options_per_contract_exchange_fee,
      fs.options_min_per_fill,
      fs.options_max_per_fill,
      agg.entry_qty, agg.exit_qty,
      agg.entry_cost, agg.exit_cost,
      agg.entry_fees, agg.exit_fees
    FROM positions p
    JOIN accounts a ON a.id = p.account_id
    LEFT JOIN brokerages b ON b.id = a.brokerage_id
    LEFT JOIN fee_schedules fs ON fs.brokerage_id = b.id
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(CASE WHEN f.type = 'entry' THEN f.quantity END), 0) AS entry_qty,
        COALESCE(SUM(CASE WHEN f.type = 'exit'  THEN f.quantity END), 0) AS exit_qty,
        COALESCE(SUM(CASE WHEN f.type = 'entry' THEN f.price * f.quantity END), 0) AS entry_cost,
        COALESCE(SUM(CASE WHEN f.type = 'exit'  THEN f.price * f.quantity END), 0) AS exit_cost,
        COALESCE(SUM(CASE WHEN f.type = 'entry' THEN f.fees END), 0) AS entry_fees,
        COALESCE(SUM(CASE WHEN f.type = 'exit'  THEN f.fees END), 0) AS exit_fees
      FROM fills f WHERE f.position_id = p.id
    ) agg ON true
    WHERE p.user_id = ${userId}
    ${filters?.status ? sql`AND p.status = ${filters.status}` : sql``}
    ${filters?.accountId ? sql`AND p.account_id = ${filters.accountId}` : sql``}
    ORDER BY p.updated_at DESC
  `);
}

export function findPositionById(db: Database | Transaction, id: string, userId: string) {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.id, id), eq(positions.userId, userId)))
    .limit(1);
}

export function findPositionWithAccount(db: Database | Transaction, id: string, userId: string) {
  return db
    .select({
      position: positions,
      accountCurrency: accounts.currency,
      accountTimezone: accounts.timezone,
      brokerageName: brokerages.name,
      stockPerShareCommission: feeSchedules.stockPerShareCommission,
      stockMinPerFill: feeSchedules.stockMinPerFill,
      stockMaxPerFill: feeSchedules.stockMaxPerFill,
      optionsPerContractCommission: feeSchedules.optionsPerContractCommission,
      optionsPerContractExchangeFee: feeSchedules.optionsPerContractExchangeFee,
      optionsMinPerFill: feeSchedules.optionsMinPerFill,
      optionsMaxPerFill: feeSchedules.optionsMaxPerFill,
    })
    .from(positions)
    .innerJoin(accounts, eq(positions.accountId, accounts.id))
    .leftJoin(brokerages, eq(accounts.brokerageId, brokerages.id))
    .leftJoin(feeSchedules, eq(feeSchedules.brokerageId, brokerages.id))
    .where(and(eq(positions.id, id), eq(positions.userId, userId)))
    .limit(1);
}

export function findFillsByPosition(db: Database | Transaction, positionId: string) {
  return db
    .select()
    .from(fills)
    .where(eq(fills.positionId, positionId))
    .orderBy(fills.filledAt, fills.createdAt);
}

export function findPositionForUpdate(tx: Transaction, id: string, userId: string) {
  return tx.execute(
    sql`SELECT * FROM positions WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`,
  );
}

export function updatePosition(
  tx: Transaction,
  id: string,
  userId: string,
  data: Record<string, unknown>,
) {
  return tx
    .update(positions)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(positions.id, id), eq(positions.userId, userId)))
    .returning();
}

export function deletePosition(tx: Transaction, id: string, userId: string) {
  return tx
    .delete(positions)
    .where(and(eq(positions.id, id), eq(positions.userId, userId)))
    .returning();
}

// ---------------------------------------------------------------------------
// Advisor trade-data summaries (advisor-tools §Component 7, REQ-9.4, REQ-9.7)
//
// NEW read-only, userId-scoped, compact-projection queries for the opt-in
// trade-data tools. These return a deliberately narrow shape (not the wide
// list row) and are hard-capped to bound egress. Every query filters by the
// caller's userId — no tool can read another user's data.
// ---------------------------------------------------------------------------

/** Hard cap on open-position rows returned to the advisor (REQ-9.4). */
export const OPEN_POSITIONS_SUMMARY_CAP = 50;
/** Hard cap on recent-closed rows returned to the advisor (REQ-9.4). */
export const RECENT_CLOSED_SUMMARY_CAP = 20;

export interface OpenPositionSummary {
  id: string;
  symbol: string;
  side: string;
  assetType: string;
  accountName: string;
  currency: string;
  openedAt: Date | null;
}

export interface RecentClosedSummary {
  id: string;
  symbol: string;
  side: string;
  assetType: string;
  accountName: string;
  currency: string;
  closedAt: Date | null;
}

/**
 * Open positions for a user, most-recently-updated first, capped at
 * {@link OPEN_POSITIONS_SUMMARY_CAP}. Read-only, userId-scoped.
 */
export function selectOpenPositionsSummary(
  db: Database | Transaction,
  userId: string,
): Promise<OpenPositionSummary[]> {
  return db
    .select({
      id: positions.id,
      symbol: positions.symbol,
      side: positions.side,
      assetType: positions.assetType,
      accountName: accounts.name,
      currency: accounts.currency,
      openedAt: positions.openedAt,
    })
    .from(positions)
    .innerJoin(accounts, eq(positions.accountId, accounts.id))
    .where(and(eq(positions.userId, userId), eq(positions.status, 'open')))
    .orderBy(sql`${positions.updatedAt} DESC`)
    .limit(OPEN_POSITIONS_SUMMARY_CAP);
}

/**
 * Recently-closed positions for a user, most-recently-closed first. The
 * requested `limit` is clamped to {@link RECENT_CLOSED_SUMMARY_CAP}.
 * Read-only, userId-scoped.
 */
export function selectRecentClosedSummary(
  db: Database | Transaction,
  userId: string,
  limit: number,
): Promise<RecentClosedSummary[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 0), RECENT_CLOSED_SUMMARY_CAP);
  return db
    .select({
      id: positions.id,
      symbol: positions.symbol,
      side: positions.side,
      assetType: positions.assetType,
      accountName: accounts.name,
      currency: accounts.currency,
      closedAt: positions.closedAt,
    })
    .from(positions)
    .innerJoin(accounts, eq(positions.accountId, accounts.id))
    .where(and(eq(positions.userId, userId), eq(positions.status, 'closed')))
    .orderBy(sql`${positions.closedAt} DESC NULLS LAST`)
    .limit(capped);
}

/**
 * Zero-open-units re-close guard (R13 "reopen then scale in" note; design
 * "Reopen mechanics" mitigation). Right after a reopen the position is `open`
 * with `entryQty == exitQty` (openUnits == 0) carried from the prior close, so a
 * re-close would satisfy the reconcile precondition and churn the ledger with no
 * new activity. `openUnits == 0` alone cannot be rejected — that is exactly the
 * state of EVERY legitimate close. The real distinction is whether any fill was
 * added since the most recent reopen.
 *
 * The reopen instant is marked by the `position_pnl_reversal` ledger row the
 * co-registered reverse hook posts, using its `occurred_at` (the reopen
 * timestamp). We compare that with the latest fill's `filled_at`: a fill filled
 * after the reopen means real new activity. Deliberately using these LOGICAL
 * business timestamps, not the `created_at` insertion times — Postgres `now()`
 * (hence `created_at DEFAULT now()`) is fixed at transaction start, so every row
 * written inside one transaction shares an identical `created_at`, which the
 * per-test single-transaction harness would collapse. `occurred_at`/`filled_at`
 * are caller-supplied and therefore distinguishable in and out of a transaction.
 *
 * Returns true iff the position has been reopened AND no fill is filled strictly
 * after the reopen — the transient state `closePositionTx` rejects. A
 * never-reopened position has no reversal row and returns false (zero effect on
 * the normal close path, including a first close preceded by a notes/plan edit).
 * Known limitation: a fill whose `filled_at` is backdated to before the reopen
 * is not counted as "since reopen"; the natural input (fill at/after the reopen)
 * is handled correctly and this backstop is paired with the frontend disabling
 * Close while openUnits == 0.
 */
export async function reopenedWithoutNewFills(
  tx: Transaction,
  positionId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT
      (SELECT max(occurred_at) FROM ledger_entries
         WHERE position_id = ${positionId}
           AND entry_type = 'position_pnl_reversal') AS last_reopen_at,
      (SELECT max(filled_at) FROM fills WHERE position_id = ${positionId}) AS last_fill_at
  `)) as unknown as Array<{
    last_reopen_at: Date | string | null;
    last_fill_at: Date | string | null;
  }>;

  const lastReopenAt = rows[0]?.last_reopen_at ?? null;
  if (lastReopenAt === null) return false;
  const lastFillAt = rows[0]?.last_fill_at ?? null;
  if (lastFillAt === null) return true;
  return new Date(lastFillAt).getTime() <= new Date(lastReopenAt).getTime();
}

export function countFillsByType(tx: Transaction, positionId: string, type: string) {
  return tx
    .select({ count: sql<number>`count(*)::int` })
    .from(fills)
    .where(and(eq(fills.positionId, positionId), eq(fills.type, type)));
}

export function sumFillQuantityByType(tx: Transaction, positionId: string, type: string) {
  return tx
    .select({
      total: sql<string>`COALESCE(SUM(quantity), 0)`,
    })
    .from(fills)
    .where(and(eq(fills.positionId, positionId), eq(fills.type, type)));
}
