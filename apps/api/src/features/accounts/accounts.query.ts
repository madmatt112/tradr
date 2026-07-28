import { eq, and, sql, asc, desc } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { accounts, brokerages, users, ledgerEntries } from '@/db/schema';
import { positions } from '@/db/schema';

// LATERAL aggregate over ledger_entries computing the ledger part of the
// derived account balance as (SUM credits − SUM debits) restricted to P&L
// entry types. Backed by the partial covering index
// `ledger_user_account_direction_amount_pnl_idx` (see accounting.schema.ts).
// Inlined as a raw SQL fragment per the positions.query.ts LATERAL pattern.
const balanceLateral = sql`LATERAL (
  SELECT (
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
      - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)
  )::numeric(18,4) AS balance
  FROM ledger_entries le
  WHERE le.account_id = ${accounts.id}
    AND le.entry_type IN ('position_pnl', 'position_pnl_reversal')
) bal`;

// Derived balance = user-entered starting_balance + ledger aggregate, emitted
// at scale-4 precision (e.g. '0.0000') to match ledger_entries.amount. The
// COALESCE handles the LEFT JOIN producing no rows (impossible in practice
// since a LATERAL aggregate always yields one row, but kept for safety).
const balanceProjection =
  sql<string>`(${accounts.startingBalance} + COALESCE(bal.balance, 0))::numeric(18,4)::text`.as(
    'balance',
  );

export function findAccountsByUser(db: Database | Transaction, userId: string) {
  return db
    .select({
      id: accounts.id,
      userId: accounts.userId,
      name: accounts.name,
      currency: accounts.currency,
      timezone: accounts.timezone,
      brokerageId: accounts.brokerageId,
      brokerageName: brokerages.name,
      createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt,
      balance: balanceProjection,
    })
    .from(accounts)
    .leftJoin(brokerages, eq(accounts.brokerageId, brokerages.id))
    .leftJoin(balanceLateral, sql`true`)
    .where(eq(accounts.userId, userId));
}

export function findAccountById(db: Database | Transaction, id: string, userId: string) {
  return db
    .select({
      id: accounts.id,
      userId: accounts.userId,
      name: accounts.name,
      currency: accounts.currency,
      timezone: accounts.timezone,
      brokerageId: accounts.brokerageId,
      brokerageName: brokerages.name,
      createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt,
      balance: balanceProjection,
    })
    .from(accounts)
    .leftJoin(brokerages, eq(accounts.brokerageId, brokerages.id))
    .leftJoin(balanceLateral, sql`true`)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .limit(1);
}

export function insertAccount(
  tx: Transaction,
  data: {
    userId: string;
    name: string;
    currency: string;
    brokerageId?: string | null;
    startingBalance?: string;
    timezone?: string;
  },
) {
  return tx.insert(accounts).values(data).returning();
}

export function updateAccount(
  tx: Transaction,
  id: string,
  userId: string,
  data: Partial<{ name: string; currency: string; brokerageId: string | null; timezone: string }>,
) {
  return tx
    .update(accounts)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .returning();
}

export function deleteAccount(tx: Transaction, id: string, userId: string) {
  return tx
    .delete(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
    .returning();
}

// ---------------------------------------------------------------------------
// Advisor trade-data summary (advisor-tools §Component 7, REQ-9.4, REQ-9.7)
//
// NEW read-only, userId-scoped, compact projection for the opt-in
// trade_data_account_summary tool. Reuses the existing balance LATERAL so the
// derived balance matches the rest of the app. userId-scoped — no tool can
// read another user's accounts.
// ---------------------------------------------------------------------------

export interface AccountSummary {
  id: string;
  name: string;
  currency: string;
  brokerageName: string | null;
  balance: string;
}

/** Accounts + derived balances for a user. Read-only, userId-scoped. */
export function selectAccountSummaries(
  db: Database | Transaction,
  userId: string,
): Promise<AccountSummary[]> {
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      brokerageName: brokerages.name,
      balance: balanceProjection,
    })
    .from(accounts)
    .leftJoin(brokerages, eq(accounts.brokerageId, brokerages.id))
    .leftJoin(balanceLateral, sql`true`)
    .where(eq(accounts.userId, userId));
}

export function countPositionsByAccount(db: Database | Transaction, accountId: string) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.accountId, accountId));
}

/**
 * Cheap existence check: does this account have any ledger entries? Backed by
 * `ledger_account_id_idx`. Used by the currency-immutability guard so deleting
 * all positions cannot unlock currency while append-only ledger rows remain
 * (ledger-balances Req 7 cross-spec note, d-536e8750).
 */
export async function accountHasLedgerEntries(
  db: Database | Transaction,
  accountId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Plan-tiers L1 enforcement + writable-account designation (design D9/D18)
// ---------------------------------------------------------------------------

/**
 * Per-user account count for the L1 creation cap (plan-tiers REQ-6.1/6.3).
 * Indexed `count(*)` over `accounts_user_id_idx` — the `admin.query.ts`
 * per-user count precedent; the small concurrent-overshoot posture is accepted.
 */
export async function countAccountsByUser(
  db: Database | Transaction,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return row?.count ?? 0;
}

/**
 * The user's effective writable-account designation (plan-tiers D18,
 * REQ-6.6): the stored `users.writable_account_id` when set AND still owned;
 * else the deterministic default — the account with the most recent position
 * activity (`max(positions.updated_at)` per account), falling back to the
 * most-recently-created account, with a final `id` tiebreak so the rule is
 * total even under timestamp ties (bulk imports and same-transaction account
 * creation produce exact ties). Returns null only when the user has no
 * accounts. EVERY consumer (position create, csv commit, the tier surface)
 * calls this one function, so all observe the same designation.
 */
export async function resolveWritableAccountId(
  db: Database | Transaction,
  userId: string,
): Promise<string | null> {
  const [user] = await db
    .select({ writableAccountId: users.writableAccountId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user?.writableAccountId) {
    const owned = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, user.writableAccountId), eq(accounts.userId, userId)))
      .limit(1);
    if (owned.length > 0) return owned[0].id;
  }

  const [fallback] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .leftJoin(positions, eq(positions.accountId, accounts.id))
    .where(eq(accounts.userId, userId))
    .groupBy(accounts.id)
    .orderBy(
      sql`max(${positions.updatedAt}) DESC NULLS LAST`,
      desc(accounts.createdAt),
      asc(accounts.id),
    )
    .limit(1);
  return fallback?.id ?? null;
}

/**
 * Persist the writable-account designation (D18). Ownership validation is the
 * caller's (service) duty — this is the raw column write.
 */
export async function setWritableAccountId(
  db: Database | Transaction,
  userId: string,
  accountId: string,
): Promise<void> {
  await db
    .update(users)
    .set({ writableAccountId: accountId, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
