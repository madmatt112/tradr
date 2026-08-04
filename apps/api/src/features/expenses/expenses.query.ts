import { and, desc, eq, gte, lte, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { ledgerEntries } from '@/db/schema/accounting.schema';
import { accounts } from '@/db/schema/accounts.schema';
import { expenses } from '@/db/schema/expenses.schema';
import { fills, positions } from '@/db/schema/positions.schema';
import { users } from '@/db/schema/users.schema';

// ---------------------------------------------------------------------------
// Row / input types
// ---------------------------------------------------------------------------

export type ExpenseRow = typeof expenses.$inferSelect;
type NewExpense = typeof expenses.$inferInsert;
type ExpensePatch = Partial<Omit<NewExpense, 'id' | 'userId' | 'createdAt'>>;

// ---------------------------------------------------------------------------
// Writes (Transaction-only)
// ---------------------------------------------------------------------------

/**
 * Insert a new expense row. Transaction-only — write-side validation in the
 * service owns the surrounding transaction.
 */
export async function insertExpense(tx: Transaction, data: NewExpense): Promise<ExpenseRow> {
  const rows = await tx.insert(expenses).values(data).returning();
  return rows[0];
}

/**
 * Patch an expense, scoped to the owning user. Bumps `updated_at = now()`.
 * Returns the updated row, or `null` when no row matched (`id` + `userId`).
 */
export async function updateExpense(
  tx: Transaction,
  userId: string,
  id: string,
  patch: ExpensePatch,
): Promise<ExpenseRow | null> {
  const rows = await tx
    .update(expenses)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

/**
 * Delete an expense, scoped to the owning user. Returns `{ deleted: true }`
 * when a row was removed.
 */
export async function deleteExpense(
  tx: Transaction,
  userId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const rows = await tx
    .delete(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
    .returning({ id: expenses.id });
  return { deleted: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Reads (Database | Transaction)
// ---------------------------------------------------------------------------

/**
 * Look up a single expense by id, scoped to the owning user. Returns `null`
 * if the row does not exist or belongs to a different user.
 */
export async function findExpenseById(
  db: Database | Transaction,
  userId: string,
  id: string,
): Promise<ExpenseRow | null> {
  const rows = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Paginated list of expenses for a user, optionally filtered to a single
 * calendar year. Order is `occurredAt DESC, createdAt DESC`.
 *
 * `hasMore` is computed via `limit + 1` (precedent:
 * `accounting.query.ts#listLedgerEntriesForAccount`) — we request one extra
 * row and report `hasMore = rows.length > pageSize`, returning at most
 * `pageSize` rows in `expenses`.
 */
export async function listExpenses(
  db: Database | Transaction,
  userId: string,
  opts: { year?: number; page: number; pageSize: number },
): Promise<{ expenses: ExpenseRow[]; hasMore: boolean }> {
  const { year, page, pageSize } = opts;

  const yearPredicate = year
    ? and(gte(expenses.occurredAt, `${year}-01-01`), lte(expenses.occurredAt, `${year}-12-31`))
    : undefined;

  const rowsPlusOne = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.userId, userId), yearPredicate))
    .orderBy(desc(expenses.occurredAt), desc(expenses.createdAt))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const hasMore = rowsPlusOne.length > pageSize;
  return {
    expenses: hasMore ? rowsPlusOne.slice(0, pageSize) : rowsPlusOne,
    hasMore,
  };
}

/**
 * Sum expense amounts by `(category, currency)` for a single calendar year.
 * `total` is the raw `numeric` string — callers pass straight to `Decimal`.
 */
export async function aggregateExpensesByCategory(
  db: Database | Transaction,
  userId: string,
  year: number,
): Promise<Array<{ category: string; currency: string; total: string }>> {
  return db
    .select({
      category: expenses.category,
      currency: expenses.currency,
      total: sql<string>`SUM(${expenses.amount})::text`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.userId, userId),
        gte(expenses.occurredAt, `${year}-01-01`),
        lte(expenses.occurredAt, `${year}-12-31`),
      ),
    )
    .groupBy(expenses.category, expenses.currency);
}

/**
 * Per-currency SUM + total row count for the LIST filter (year or "all
 * years"). Composed as two parallel Drizzle queries via `Promise.all`.
 *
 * `totalRowCount` is cast to `::int` — Postgres `COUNT(*)` defaults to
 * `bigint`, which Drizzle returns as `string`. The cast makes Drizzle return
 * a TS `number`.
 *
 * `SUM(amount)` is NOT cast — the `numeric` string passes straight through to
 * `Decimal` per project convention.
 */
export async function aggregateExpenseTotalsByFilter(
  db: Database | Transaction,
  userId: string,
  opts: { year?: number },
): Promise<{
  perCurrency: Array<{ currency: string; total: string }>;
  totalRowCount: number;
}> {
  const yearPredicate = opts.year
    ? and(
        gte(expenses.occurredAt, `${opts.year}-01-01`),
        lte(expenses.occurredAt, `${opts.year}-12-31`),
      )
    : undefined;

  const perCurrencyQuery = db
    .select({
      currency: expenses.currency,
      total: sql<string>`SUM(${expenses.amount})::text`,
    })
    .from(expenses)
    .where(and(eq(expenses.userId, userId), yearPredicate))
    .groupBy(expenses.currency);

  const countQuery = db
    .select({
      totalRowCount: sql<number>`COUNT(*)::int`,
    })
    .from(expenses)
    .where(and(eq(expenses.userId, userId), yearPredicate));

  const [perCurrencyRows, countRows] = await Promise.all([perCurrencyQuery, countQuery]);

  return {
    perCurrency: perCurrencyRows,
    totalRowCount: countRows[0]?.totalRowCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Tax-summary / wash-sale joins (Task 7.2)
// ---------------------------------------------------------------------------

/**
 * One row per `(position, currency)` with the signed realised P&L for the
 * year, derived from the immutable ledger. Reversal pairs naturally cancel
 * against originals via the signed SUM, so no extra de-duplication is needed.
 */
export type RealisedPositionRow = {
  positionId: string;
  realisedPnl: string;
  openedAt: Date;
  closedAt: Date | null;
  symbol: string;
  assetType: 'stock' | 'option';
  side: 'long' | 'short';
  accountId: string;
  currency: string;
  /**
   * When this position's loss/gain was actually REALIZED — the latest realizing
   * fill in the year, not the position's close date. Never null: it comes from
   * the ledger rows that produced this row.
   *
   * Since ledger-balances Req 9 a position realizes P&L per fill, so a position
   * can be sitting OPEN with a realized loss. `closedAt` is null for those, and
   * the wash-sale matcher used to anchor on `closedAt` — skipping them entirely.
   */
  realisedAt: Date;
};

/**
 * Per-position realised P&L for a calendar year, computed from the ledger.
 *
 * Joins `ledger_entries → positions` on `position_id`. Filters
 * `entry_type IN ('position_pnl', 'position_pnl_reversal')` and bounds
 * `occurred_at` to `[year-01-01, year+1-01-01)` (half-open UTC window). The
 * per-position SUM signs each entry by `direction` so a `credit` reversal
 * cancels its `debit` original and vice versa (post-v3-fix #1).
 *
 * Both `ledger_entries.user_id = $u` AND `positions.user_id = $u` are
 * filtered — defence-in-depth (v3-10). FK invariants make the second
 * predicate redundant, but the cost is one extra predicate and it shuts down
 * the cross-user-leak hazard at the query layer.
 */
export async function listRealisedPositionsForYear(
  db: Database | Transaction,
  userId: string,
  year: number,
): Promise<RealisedPositionRow[]> {
  const windowStart = `${year}-01-01T00:00:00Z`;
  const windowEnd = `${year + 1}-01-01T00:00:00Z`;

  return db
    .select({
      positionId: positions.id,
      realisedPnl: sql<string>`SUM(CASE WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount} ELSE -${ledgerEntries.amount} END)::text`,
      realisedAt: sql<Date>`MAX(${ledgerEntries.occurredAt})`,
      openedAt: positions.openedAt,
      closedAt: positions.closedAt,
      symbol: positions.symbol,
      assetType: sql<'stock' | 'option'>`${positions.assetType}`,
      side: sql<'long' | 'short'>`${positions.side}`,
      accountId: positions.accountId,
      currency: ledgerEntries.currency,
    })
    .from(ledgerEntries)
    .innerJoin(positions, eq(ledgerEntries.positionId, positions.id))
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(positions.userId, userId),
        sql`${ledgerEntries.entryType} IN ('position_pnl', 'position_pnl_reversal')`,
        sql`${ledgerEntries.occurredAt} >= ${windowStart}`,
        sql`${ledgerEntries.occurredAt} < ${windowEnd}`,
      ),
    )
    .groupBy(
      positions.id,
      positions.openedAt,
      positions.closedAt,
      positions.symbol,
      positions.assetType,
      positions.side,
      positions.accountId,
      ledgerEntries.currency,
    ) as Promise<RealisedPositionRow[]>;
}

/**
 * Wash-sale / superficial-loss candidate row — projections needed to key by
 * `(underlying, side)` and check the 30-day window in memory. `assetType` is
 * required so the in-memory helper can partition stock vs option before any
 * symbol matching (post-review fix #7).
 */
export type CandidatePositionRow = {
  positionId: string;
  openedAt: Date | null;
  closedAt: Date | null;
  symbol: string;
  assetType: 'stock' | 'option';
  side: 'long' | 'short';
  accountId: string;
};

/**
 * Positions that could be wash-sale / superficial-loss counterparties for any
 * loss closed within `window`. Returns every position that either opened
 * inside `window` OR opened before `window.start` and was still open past
 * `window.start` (held-open-through-window).
 *
 * Single SQL statement — no per-symbol filter. The wash-sale helper
 * (Task 9) keys candidates by `(underlying, side)` in memory so we don't
 * round-trip the DB per loss.
 */
export async function listCandidatePositionsByYear(
  db: Database | Transaction,
  userId: string,
  window: { start: Date; end: Date },
): Promise<CandidatePositionRow[]> {
  // postgres-js cannot bind a `Date` directly through drizzle's `sql\`\``
  // template (it surfaces as "Received an instance of Date"). The typed
  // operators `gte`/`lte` handle Date → timestamp conversion themselves,
  // but the raw template comparisons need ISO strings.
  const startIso = window.start.toISOString();
  return db
    .select({
      positionId: positions.id,
      openedAt: positions.openedAt,
      closedAt: positions.closedAt,
      symbol: positions.symbol,
      assetType: sql<'stock' | 'option'>`${positions.assetType}`,
      side: sql<'long' | 'short'>`${positions.side}`,
      accountId: positions.accountId,
    })
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        or(
          and(gte(positions.openedAt, window.start), lte(positions.openedAt, window.end)),
          and(
            sql`${positions.openedAt} < ${startIso}`,
            or(sql`${positions.closedAt} IS NULL`, sql`${positions.closedAt} > ${startIso}`),
          ),
        ),
      ),
    ) as Promise<CandidatePositionRow[]>;
}

// ---------------------------------------------------------------------------
// Fee-rollup join (Task 7.3)
// ---------------------------------------------------------------------------

/**
 * One row per `(account, assetType, currency)` with the total fees paid on
 * fills that settled in the calendar year. Both open and closed positions
 * contribute — Req 3.2 explicitly counts fees as they occur, irrespective of
 * the parent position's lifecycle state.
 */
export type FeeRollupRow = {
  accountId: string;
  accountName: string;
  assetType: 'stock' | 'option';
  currency: string;
  totalFees: string;
};

/**
 * Aggregate trading fees by `(account, assetType, currency)` for a calendar
 * year, sourced from `fills.fees`.
 *
 * Joins `fills → positions → accounts`. Filters `fills.filled_at` to the
 * half-open UTC window `[year-01-01, year+1-01-01)`. Both
 * `positions.user_id = $u` AND `accounts.user_id = $u` are filtered —
 * defence-in-depth on the `accounts` join (v3-10). Currency comes from
 * `accounts.currency` (no brokerage join needed).
 *
 * No `positions.status` filter: open and closed positions both count per
 * Req 3.2. `SUM(fills.fees)` is NOT cast — the `numeric` string passes
 * straight through to `Decimal` per project convention.
 */
export async function aggregateFeesByAccountForYear(
  db: Database | Transaction,
  userId: string,
  year: number,
): Promise<FeeRollupRow[]> {
  const windowStart = `${year}-01-01T00:00:00Z`;
  const windowEnd = `${year + 1}-01-01T00:00:00Z`;

  return db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      assetType: sql<'stock' | 'option'>`${positions.assetType}`,
      currency: accounts.currency,
      totalFees: sql<string>`SUM(${fills.fees})`,
    })
    .from(fills)
    .innerJoin(positions, eq(fills.positionId, positions.id))
    .innerJoin(accounts, eq(positions.accountId, accounts.id))
    .where(
      and(
        eq(positions.userId, userId),
        eq(accounts.userId, userId),
        sql`${fills.filledAt} >= ${windowStart}`,
        sql`${fills.filledAt} < ${windowEnd}`,
      ),
    )
    .groupBy(accounts.id, accounts.name, positions.assetType, accounts.currency) as Promise<
    FeeRollupRow[]
  >;
}

// ---------------------------------------------------------------------------
// Jurisdiction queries (Task 7.4)
// ---------------------------------------------------------------------------

export type TaxJurisdiction = 'US' | 'CA' | 'other';

/**
 * Read the user's stored tax jurisdiction. Returns NULL straight through —
 * the service materializes NULL to `'other'` per Req 4.2; the query does NOT
 * materialize.
 */
export async function getUserTaxJurisdiction(
  db: Database | Transaction,
  userId: string,
): Promise<TaxJurisdiction | null> {
  const rows = await db
    .select({ taxJurisdiction: users.taxJurisdiction })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (rows[0]?.taxJurisdiction as TaxJurisdiction | null | undefined) ?? null;
}

/**
 * Update the user's stored tax jurisdiction. Write-side — Transaction only.
 * The CHECK constraint on `users.tax_jurisdiction` enforces the allowed set
 * (`'US' | 'CA' | 'other'` or NULL).
 */
export async function updateUserTaxJurisdiction(
  tx: Transaction,
  userId: string,
  value: TaxJurisdiction | null,
): Promise<void> {
  await tx.update(users).set({ taxJurisdiction: value }).where(eq(users.id, userId));
}
