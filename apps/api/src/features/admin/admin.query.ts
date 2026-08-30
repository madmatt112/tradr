import { and, eq, gt, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { Database, Transaction } from '@/db';
import {
  accounts,
  adminAuditLog,
  advisorConversations,
  advisorPersonas,
  advisorProviderKeys,
  brokerages,
  csvImportStaging,
  dashboardLayouts,
  expenses,
  externalApiKeys,
  fills,
  ledgerEntries,
  positions,
  sessions,
  usageRecords,
  users,
  walletTransactions,
  wallets,
} from '@/db/schema';
import type { AdminAuditDetail } from '@/db/schema/admin.schema';

import { currentPeriodKeyUtc, getTurnCount } from './gating.query';

// ---------------------------------------------------------------------------
// Admin system-query layer (admin-platform design Components 2-3 & 5).
//
// CROSS-USER SYSTEM QUERIES live ONLY here and this file is imported ONLY by
// the gated admin.service/admin.route (REQ-1.5, REQ-3.7) — never by any
// user-scoped feature. Every query selects an EXPLICIT column list:
// `password_hash`, session token hashes, and encrypted key material are never
// selected (REQ-3.6).
//
// Type rules (structure.md): locking/write queries take `Transaction` only;
// reads accept `Database | Transaction`. No new index on `users` or
// `positions` backs these queries — full scans/sorts are accepted at MVP
// scale (REQ-2.5; the recorded scaling trigger covers it).
// ---------------------------------------------------------------------------

// --- Component 2: platform statistics ---------------------------------------

/** Total registered users — `COUNT(*)` over `users` (REQ-2.2). */
export async function countAllUsers(db: Database | Transaction): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return row?.count ?? 0;
}

/**
 * "Active now (last 30 min)" — `COUNT(DISTINCT user_id)` over still-valid
 * sessions (REQ-2.3, pinned choice). The 30-minute bound matches
 * `IDLE_TIMEOUT_MS` (`auth.middleware.ts:18`); the 24 h `created_at` bound
 * excludes sessions past the absolute timeout (`auth.middleware.ts:19,48`)
 * whose rows linger because no cleanup job exists. `last_accessed` is touched
 * at most every 5 minutes, so the count lags real activity by up to 5 minutes
 * — never presented as a precise live count.
 */
export async function countActiveUsersNow(db: Database | Transaction): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(DISTINCT ${sessions.userId})::int` })
    .from(sessions)
    .where(
      and(
        gt(sessions.lastAccessed, sql`now() - interval '30 minutes'`),
        gt(sessions.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  return row?.count ?? 0;
}

export interface PositionStatusCounts {
  total: number;
  draft: number;
  open: number;
  closed: number;
}

/**
 * Platform-wide position counts via a single `GROUP BY status` aggregate
 * (REQ-2.4). Index honesty (REQ-2.5, pinned choice (a)): no status-leading
 * index exists on `positions`, so this is a full count — accepted at MVP
 * scale; one bounded aggregate statement, not an N+1. No new index.
 */
export async function countAllPositionsByStatus(
  db: Database | Transaction,
): Promise<PositionStatusCounts> {
  const rows = await db
    .select({ status: positions.status, count: sql<number>`count(*)::int` })
    .from(positions)
    .groupBy(positions.status);
  const counts: PositionStatusCounts = { total: 0, draft: 0, open: 0, closed: 0 };
  for (const row of rows) {
    counts.total += row.count;
    if (row.status === 'draft' || row.status === 'open' || row.status === 'closed') {
      counts[row.status] = row.count;
    }
  }
  return counts;
}

/**
 * All-time revenue in micro-USD purchased-credit volume: `SUM(amount)` over
 * `wallet_transactions WHERE kind IN ('credit','reversal')` (REQ-4.4 / stats
 * `revenue.allTime`). Reversal amounts are stored negative, so the simple sum
 * is already net. May be negative in pathological refund cases. The
 * `revenue.currentMonth` figure is NOT computed here — it reuses the
 * reversal-attributed `sumPeriodRevenue` (Component 5).
 */
export async function sumAllTimeRevenue(db: Database | Transaction): Promise<bigint> {
  const [row] = await db
    .select({ sum: sql<string>`COALESCE(SUM(${walletTransactions.amount}), 0)::bigint` })
    .from(walletTransactions)
    .where(sql`${walletTransactions.kind} IN ('credit', 'reversal')`);
  return BigInt(row?.sum ?? 0);
}

// --- Component 3: user management --------------------------------------------

/**
 * Encode a `(created_at, id)` tuple into the stable base64 list cursor —
 * mirrors `encodeWalletCursor` (`billing.query.ts:286`).
 */
export function encodeAdminUserCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

/**
 * Decode a base64 list cursor into its tuple, or `null` if malformed —
 * mirrors `decodeWalletCursor` (`billing.query.ts:291`).
 */
export function decodeAdminUserCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep === -1) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const createdAt = new Date(iso);
    if (id.length === 0 || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface AdminUserListRow {
  id: string;
  email: string;
  isAdmin: boolean;
  /** Read-only verified signal (REQ-5.7) — v1 gates nothing on it. */
  emailVerified: boolean;
  createdAt: string;
  /** Last recorded session activity — may be arbitrarily old; null = never. */
  lastActiveAt: string | null;
}

export interface AdminUserListPage {
  items: AdminUserListRow[];
  nextCursor: string | null;
}

/**
 * Cursor-paginated user list, newest-first descending over the stable key
 * `(created_at, id)` (REQ-3.1). One query with a lateral subselect for
 * last-activity — no N+1; `sessions_user_id_idx` serves the lateral. The
 * outer sort has no `created_at` index on `users` — accepted at MVP scale.
 * Cursor precision (inherited from the wallet cursor, accepted): the cursor
 * encodes `toISOString()` at millisecond precision against a microsecond
 * timestamptz, so a boundary row with nonzero sub-millisecond digits can be
 * skipped across pages. `limit` is the already-clamped page size; `LIMIT
 * limit + 1` detects the next page.
 */
export async function selectAllUsersPage(
  db: Database | Transaction,
  cursor: { createdAt: Date; id: string } | null,
  limit: number,
): Promise<AdminUserListPage> {
  // Raw-SQL params bypass drizzle's column encoders, and drizzle's
  // postgres-js driver installs transparent serializers for timestamp OIDs —
  // a bare Date param crashes the wire encoder, so Dates are ISO-stringified
  // at this boundary.
  const cursorClause = cursor
    ? sql`WHERE (u.created_at, u.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    : sql``;
  const result = await db.execute(sql`
    SELECT u.id, u.email, u.is_admin, u.email_verified, u.created_at, la.last_active_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT max(s.last_accessed) AS last_active_at FROM sessions s WHERE s.user_id = u.id
    ) la ON true
    ${cursorClause}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${limit + 1}
  `);
  const rows = result as unknown as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((r) => ({
    id: r.id as string,
    email: r.email as string,
    isAdmin: r.is_admin as boolean,
    emailVerified: r.email_verified as boolean,
    createdAt: new Date(r.created_at as string | Date).toISOString(),
    lastActiveAt: r.last_active_at
      ? new Date(r.last_active_at as string | Date).toISOString()
      : null,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeAdminUserCursor(new Date(last.created_at as string | Date), last.id as string)
        : null,
  };
}

/**
 * Single-user list-fields read for the admin detail view (REQ-3.2): the same
 * explicit columns + lateral `max(last_accessed)` as `selectAllUsersPage`,
 * for one id. `null` = no such user (the detail 404 feeder).
 */
export async function selectAdminUserById(
  db: Database | Transaction,
  id: string,
): Promise<AdminUserListRow | null> {
  const result = await db.execute(sql`
    SELECT u.id, u.email, u.is_admin, u.email_verified, u.created_at, la.last_active_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT max(s.last_accessed) AS last_active_at FROM sessions s WHERE s.user_id = u.id
    ) la ON true
    WHERE u.id = ${id}::uuid
  `);
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    id: row.id as string,
    email: row.email as string,
    isAdmin: row.is_admin as boolean,
    emailVerified: row.email_verified as boolean,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    lastActiveAt: row.last_active_at
      ? new Date(row.last_active_at as string | Date).toISOString()
      : null,
  };
}

export interface AdminUserDetailAggregates {
  positionCount: number;
  /**
   * Platform-key advisor turns (current UTC month) — a PK lookup on
   * `advisor_turn_counters.turn_count`, which counts platform turns only from
   * plan-tiers on (REQ-8.3). No separate all-turns signal in v1.
   */
  advisorTurns: number;
  /** All-time sums over `usage_records` — served by `usage_records_user_created_idx`. */
  usage: { inputTokens: bigint; outputTokens: bigint; billedCredits: bigint };
  /** Cached wallet balance (micro-USD); 0n when no wallet row exists. */
  walletBalance: bigint;
}

/**
 * Per-user aggregates for the admin detail view (REQ-3.2). Cross-user-capable
 * reads routed through the gated admin layer only — nothing here flows
 * through user-scoped feature endpoints (REQ-3.7).
 */
export async function selectUserDetailAggregates(
  db: Database | Transaction,
  userId: string,
): Promise<AdminUserDetailAggregates> {
  const [positionRows, advisorTurns, usageRows, walletRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(positions)
      .where(eq(positions.userId, userId)),
    getTurnCount(db, userId, currentPeriodKeyUtc()),
    db
      .select({
        inputTokens: sql<string>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::bigint`,
        outputTokens: sql<string>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::bigint`,
        billedCredits: sql<string>`COALESCE(SUM(${usageRecords.creditCost}), 0)::bigint`,
      })
      .from(usageRecords)
      .where(eq(usageRecords.userId, userId)),
    db
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .limit(1),
  ]);
  return {
    positionCount: positionRows[0]?.count ?? 0,
    advisorTurns,
    usage: {
      inputTokens: BigInt(usageRows[0]?.inputTokens ?? 0),
      outputTokens: BigInt(usageRows[0]?.outputTokens ?? 0),
      billedCredits: BigInt(usageRows[0]?.billedCredits ?? 0),
    },
    walletBalance: walletRows[0]?.balance ?? 0n,
  };
}

/**
 * Resolve a user's email by id inside the toggle transaction — the actor
 * email snapshot for the audit row (`authMiddleware` exposes only
 * userId/isAdmin on context, not email). `null` = no such user row.
 */
export async function selectUserEmailById(tx: Transaction, id: string): Promise<string | null> {
  const rows = await tx.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
  return rows[0]?.email ?? null;
}

export interface AdminToggleTarget {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: Date;
}

/**
 * Explicit-column, UNLOCKED read of the toggle target — the 404 feeder and
 * the target-email snapshot for the audit row (REQ-3.3/3.5). `null` = 404.
 */
export async function selectUserForAdminToggle(
  tx: Transaction,
  id: string,
): Promise<AdminToggleTarget | null> {
  const rows = await tx
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Lock ONLY the target user row for a promotion, returning its current admin
 * flag so the no-op decision is made post-lock (REQ-3.3). Raw `FOR UPDATE`
 * idiom per `positions.query.ts:107`.
 */
export async function selectUserFlagForUpdate(
  tx: Transaction,
  id: string,
): Promise<{ id: string; isAdmin: boolean } | null> {
  const result = await tx.execute(sql`SELECT id, is_admin FROM users WHERE id = ${id} FOR UPDATE`);
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return { id: row.id as string, isAdmin: row.is_admin as boolean };
}

/**
 * Lock the current admin set for a demotion (REQ-3.4). `FOR UPDATE`
 * re-evaluates `is_admin = true` on lock-wait (EvalPlanQual), so a row
 * demoted by a concurrent committed transaction drops out of the returned
 * set — the race-safe last-admin guard.
 */
export async function selectAdminIdsForUpdate(tx: Transaction): Promise<string[]> {
  const result = await tx.execute(sql`SELECT id FROM users WHERE is_admin = true FOR UPDATE`);
  const rows = result as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => r.id as string);
}

/**
 * Flip the admin flag on an already-locked user row (REQ-3.3). Returns the
 * explicit-column row for the toggle response.
 */
export async function updateUserIsAdmin(
  tx: Transaction,
  id: string,
  value: boolean,
): Promise<AdminToggleTarget> {
  const [row] = await tx
    .update(users)
    .set({ isAdmin: value, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    });
  return row;
}

/**
 * A discriminated union, not one shape with optional fields, so the DB's own
 * `admin_audit_log_toggle_values_chk` cannot be violated from TypeScript: a
 * toggle entry without both boolean ends does not typecheck, and a reset entry
 * cannot claim ones it does not have.
 */
export type AdminAuditEntryInsert =
  | {
      action: 'admin_toggle';
      actorUserId: string;
      actorEmail: string;
      targetUserId: string;
      targetEmail: string;
      oldValue: boolean;
      newValue: boolean;
    }
  | {
      action: 'factory_reset';
      actorUserId: string;
      actorEmail: string;
      targetUserId: string;
      targetEmail: string;
      detail: AdminAuditDetail;
    };

/**
 * Append the audit row in the SAME transaction as the flag flip (REQ-3.5).
 * Emails are snapshotted as text so the entry survives user deletion. Called
 * only after the post-lock no-op check, so every row is a real transition.
 */
export async function insertAdminAuditEntry(
  tx: Transaction,
  entry: AdminAuditEntryInsert,
): Promise<void> {
  await tx.insert(adminAuditLog).values(entry);
}

/** Count current admins — the last-admin guard read and the bootstrap gate (REQ-3.4, REQ-8.4). */
export async function countAdmins(db: Database | Transaction): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.isAdmin, true));
  return row?.count ?? 0;
}

/**
 * First-admin bootstrap promotion (REQ-8.4, Component 10): set `is_admin` on
 * the user with this email (already lowercased by the config transform —
 * registration stores lowercase). Returns whether a row was updated. The
 * zero-admins guard lives in the service, not here.
 */
export async function promoteUserByEmail(
  db: Database | Transaction,
  email: string,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ isAdmin: true, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  return rows.length > 0;
}

// --- Component 5: usage & revenue aggregation ---------------------------------

export interface UsageTotals {
  inputTokens: bigint;
  outputTokens: bigint;
  /** `SUM(credit_cost)` — billed/as-charged, markup-inclusive (REQ-4.2). */
  billedCredits: bigint;
  /**
   * `SUM(raw_cost)` over covered rows ONLY — persisted at turn time, NEVER
   * back-derived from current pricing config. `null` when zero covered rows.
   */
  providerCost: bigint | null;
  /** Coverage honesty: pre-0013 rows have `raw_cost IS NULL` and are excluded. */
  coverage: { records: number; recordsWithRawCost: number };
}

/**
 * Platform-wide usage totals over `[from, to)` in one aggregate statement
 * (REQ-4.1, REQ-4.2). `SUM(raw_cost)` skips NULLs by definition, so
 * `providerCost` covers exactly the rows counted by `recordsWithRawCost`;
 * served by `usage_records_created_idx` (REQ-4.3).
 */
export async function sumUsageTotals(
  db: Database | Transaction,
  from: Date,
  to: Date,
): Promise<UsageTotals> {
  const [row] = await db
    .select({
      inputTokens: sql<string>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::bigint`,
      outputTokens: sql<string>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::bigint`,
      billedCredits: sql<string>`COALESCE(SUM(${usageRecords.creditCost}), 0)::bigint`,
      providerCost: sql<string | null>`SUM(${usageRecords.rawCost})::bigint`,
      records: sql<number>`count(*)::int`,
      recordsWithRawCost: sql<number>`count(${usageRecords.rawCost})::int`,
    })
    .from(usageRecords)
    .where(and(gte(usageRecords.createdAt, from), lt(usageRecords.createdAt, to)));
  return {
    inputTokens: BigInt(row?.inputTokens ?? 0),
    outputTokens: BigInt(row?.outputTokens ?? 0),
    billedCredits: BigInt(row?.billedCredits ?? 0),
    providerCost: row?.providerCost != null ? BigInt(row.providerCost) : null,
    coverage: {
      records: row?.records ?? 0,
      recordsWithRawCost: row?.recordsWithRawCost ?? 0,
    },
  };
}

export interface UsageDayRow {
  /** UTC day bucket, `'YYYY-MM-DD'`. Days with no rows are absent. */
  day: string;
  inputTokens: bigint;
  outputTokens: bigint;
  billedCredits: bigint;
}

/**
 * Per-day usage series over `[from, to)` — one
 * `GROUP BY date_trunc('day', created_at AT TIME ZONE 'UTC')` statement
 * served by `usage_records_created_idx` (REQ-4.3); no N+1.
 */
export async function selectUsageDaySeries(
  db: Database | Transaction,
  from: Date,
  to: Date,
): Promise<UsageDayRow[]> {
  const dayBucket = sql`date_trunc('day', ${usageRecords.createdAt} AT TIME ZONE 'UTC')`;
  const rows = await db
    .select({
      day: sql<string>`to_char(${dayBucket}, 'YYYY-MM-DD')`,
      inputTokens: sql<string>`SUM(${usageRecords.inputTokens})::bigint`,
      outputTokens: sql<string>`SUM(${usageRecords.outputTokens})::bigint`,
      billedCredits: sql<string>`SUM(${usageRecords.creditCost})::bigint`,
    })
    .from(usageRecords)
    .where(and(gte(usageRecords.createdAt, from), lt(usageRecords.createdAt, to)))
    .groupBy(dayBucket)
    .orderBy(dayBucket);
  return rows.map((r) => ({
    day: r.day,
    inputTokens: BigInt(r.inputTokens),
    outputTokens: BigInt(r.outputTokens),
    billedCredits: BigInt(r.billedCredits),
  }));
}

export interface TopUserUsageRow {
  userId: string;
  email: string;
  inputTokens: bigint;
  outputTokens: bigint;
  billedCredits: bigint;
  /** Committed platform turns in period — one `usage_records` row per turn. */
  turns: number;
}

/**
 * Top 50 users by billed credits over `[from, to)` — one
 * `GROUP BY user_id ORDER BY SUM(credit_cost) DESC LIMIT 50` joined to
 * `users` for email (REQ-4.3); no N+1. The top-50 bound is disclosed in the
 * UI.
 */
export async function selectTopUsersByBilledCredits(
  db: Database | Transaction,
  from: Date,
  to: Date,
): Promise<TopUserUsageRow[]> {
  const billedCredits = sql`SUM(${usageRecords.creditCost})`;
  const rows = await db
    .select({
      userId: usageRecords.userId,
      email: users.email,
      inputTokens: sql<string>`SUM(${usageRecords.inputTokens})::bigint`,
      outputTokens: sql<string>`SUM(${usageRecords.outputTokens})::bigint`,
      billedCredits: sql<string>`${billedCredits}::bigint`,
      turns: sql<number>`count(*)::int`,
    })
    .from(usageRecords)
    .innerJoin(users, eq(users.id, usageRecords.userId))
    .where(and(gte(usageRecords.createdAt, from), lt(usageRecords.createdAt, to)))
    .groupBy(usageRecords.userId, users.email)
    .orderBy(sql`${billedCredits} DESC`)
    .limit(50);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    inputTokens: BigInt(r.inputTokens),
    outputTokens: BigInt(r.outputTokens),
    billedCredits: BigInt(r.billedCredits),
    turns: r.turns,
  }));
}

export interface PeriodRevenue {
  /** Micro-USD credited in period (`kind = 'credit'`). */
  credited: bigint;
  /** Reversals attributed to the originating credit's period — stored negative. */
  reversed: bigint;
  /** `credited + reversed` (reversal amounts are negative, so this is net). */
  net: bigint;
}

/**
 * Period revenue over `[from, to)` with reversal attribution (REQ-4.4) —
 * design Component 5's two statements verbatim. Reversals count against the
 * period of the credit they reverse, joined via the indexed
 * `stripe_payment_intent_id` (`wallet_transactions_payment_intent_idx`,
 * `wallet.schema.ts:83`). The `DISTINCT ON` subquery is hardened to exactly
 * ONE credit row per payment intent (the earliest) even under multi-grant
 * drift. Dual-use: the `/usage` endpoint's period revenue AND the stats
 * `revenue.currentMonth` figure (called over the current UTC month).
 * Platform-wide period scans over `wallet_transactions` are accepted without
 * a new index (pinned) — purchase volume is orders of magnitude below usage
 * volume.
 */
export async function sumPeriodRevenue(
  db: Database | Transaction,
  from: Date,
  to: Date,
): Promise<PeriodRevenue> {
  // Raw-SQL params bypass drizzle's column encoders, and drizzle's
  // postgres-js driver installs transparent serializers for timestamp OIDs —
  // a bare Date param crashes the wire encoder, so Dates are ISO-stringified
  // at this boundary.
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const [creditedResult, reversedResult] = await Promise.all([
    // credited in period
    db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::bigint AS sum FROM wallet_transactions
      WHERE kind = 'credit' AND created_at >= ${fromIso} AND created_at < ${toIso}
    `),
    // reversals attributed to the originating credit's period (amounts are negative).
    // Join to exactly ONE credit row per payment intent (the earliest): wallet-billing
    // produces one credit per PI operationally (selectCreditTrigger admits one settled
    // trigger per checkout session), but nothing schema-enforces it and its own
    // reverseForEvent defensively handles multiple grants per PI — so the attribution
    // join is hardened against that drift rather than trusting it.
    db.execute(sql`
      SELECT COALESCE(SUM(r.amount), 0)::bigint AS sum
      FROM wallet_transactions r
      JOIN (
        SELECT DISTINCT ON (stripe_payment_intent_id) stripe_payment_intent_id, created_at
        FROM wallet_transactions WHERE kind = 'credit' AND stripe_payment_intent_id IS NOT NULL
        ORDER BY stripe_payment_intent_id, created_at
      ) c ON c.stripe_payment_intent_id = r.stripe_payment_intent_id
      WHERE r.kind = 'reversal' AND c.created_at >= ${fromIso} AND c.created_at < ${toIso}
    `),
  ]);
  const creditedRow = (creditedResult as unknown as Array<Record<string, unknown>>)[0];
  const reversedRow = (reversedResult as unknown as Array<Record<string, unknown>>)[0];
  const credited = BigInt((creditedRow?.sum as string | undefined) ?? 0);
  const reversed = BigInt((reversedRow?.sum as string | undefined) ?? 0);
  return { credited, reversed, net: credited + reversed };
}

// --- Component 13: factory reset --------------------------------------------
//
// WHAT A RESET DOES NOT TOUCH IS THE PART WORTH READING, because the deletes
// below are unremarkable and the omissions are load-bearing:
//
// - BILLING AND WALLET (`wallets`, `wallet_transactions`, `usage_records`,
//   `subscriptions`, `billing_customers`, `webhook_events`). `subscriptions` and
//   `billing_customers` are local MIRRORS of Stripe, so deleting them cancels
//   nothing — it orphans a live Stripe Customer and leaves the next webhook
//   writing rows for a subscription the app no longer believes in. The wallet
//   holds credit the user paid real money for. A journal reset is not a refund
//   and must not look like one.
// - QUOTA COUNTERS (`csv_import_counters`, `advisor_turn_counters`,
//   `advisor_image_counters`). Their own schema comments say they are "never
//   decremented and never deleted by application flows (non-evasion)", with the
//   user-deletion CASCADE as the only removal path. Resetting them would turn
//   this button into a way to refill a free-tier allowance on demand — exactly
//   the evasion those comments exist to prevent.
// - IDENTITY (`email`, `password_hash`, `is_admin`, `email_verified`,
//   `created_at`) and `sessions`. The user is returned to the state they were in
//   just after registering and verifying: the account still exists, still
//   belongs to them, and stays logged in.
//
// ORDER IS NOT COSMETIC. Three FKs into this graph are ON DELETE RESTRICT —
// `positions.account_id`, `ledger_entries.account_id` and
// `accounts.brokerage_id` — so PostgreSQL refuses to delete an account while a
// position or ledger entry still points at it, and refuses to delete a
// user-owned brokerage while an account still points at that. The sequence below
// is the topological one those constraints force; reordering it does not lose
// data, it aborts the transaction.

/** Rows removed, keyed by table name. */
export type ResetDeleteCounts = Record<string, number>;

/** `COUNT(*)` over one table for one user — the shape all twelve counts share. */
async function countBy(
  db: Database | Transaction,
  table: PgTable,
  column: PgColumn,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(column, userId));
  return row?.count ?? 0;
}

/** `fills` has no `user_id`; it is reached through the user's positions. */
async function countFillsForUser(db: Database | Transaction, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fills)
    .where(
      inArray(
        fills.positionId,
        db.select({ id: positions.id }).from(positions).where(eq(positions.userId, userId)),
      ),
    );
  return row?.count ?? 0;
}

/**
 * The always-deleted half: everything the user has journalled.
 *
 * `fills` and `fee_schedules` are not deleted directly — they CASCADE from
 * `positions` and `brokerages` — so the fill count is taken before the parent
 * goes, which is the only moment it can be.
 */
export async function deleteTradingData(
  tx: Transaction,
  userId: string,
): Promise<ResetDeleteCounts> {
  const counts: ResetDeleteCounts = {};

  // Counted before the cascade takes them.
  counts.fills = await countFillsForUser(tx, userId);

  // 1. Ledger entries — RESTRICT on accounts, so they go first.
  counts.ledger_entries = (
    await tx
      .delete(ledgerEntries)
      .where(eq(ledgerEntries.userId, userId))
      .returning({ id: ledgerEntries.id })
  ).length;

  // 2. Positions — RESTRICT on accounts; cascades fills.
  counts.positions = (
    await tx.delete(positions).where(eq(positions.userId, userId)).returning({ id: positions.id })
  ).length;

  // 3. Staged CSV rows — cascade from accounts anyway, deleted explicitly so the
  //    count is reported rather than silently absorbed.
  counts.csv_import_staging = (
    await tx
      .delete(csvImportStaging)
      .where(eq(csvImportStaging.userId, userId))
      .returning({ id: csvImportStaging.id })
  ).length;

  counts.expenses = (
    await tx.delete(expenses).where(eq(expenses.userId, userId)).returning({ id: expenses.id })
  ).length;

  // 4. Accounts — now unblocked. `users.writable_account_id` is ON DELETE SET
  //    NULL, so the free-tier writable-account designation clears itself.
  counts.accounts = (
    await tx.delete(accounts).where(eq(accounts.userId, userId)).returning({ id: accounts.id })
  ).length;

  // 5. The user's OWN brokerages only. `brokerages.user_id` is nullable: NULL
  //    marks the system brokerages every user shares, and deleting those would
  //    empty the picker for the whole instance. `isNotNull` is redundant against
  //    `eq` — NULL never equals — and kept as the statement of intent, because
  //    the cost of that line being wrong is instance-wide.
  counts.brokerages = (
    await tx
      .delete(brokerages)
      .where(and(eq(brokerages.userId, userId), isNotNull(brokerages.userId)))
      .returning({ id: brokerages.id })
  ).length;

  return counts;
}

/**
 * The opt-in half: configuration the operator chose to remove as well.
 *
 * Deliberately NOT including `users.onboarding` — that is reset on every run by
 * `resetUserPreferences` below, whatever the flag says, because a reset user
 * whose walkthrough still believes it has been completed cannot do the one thing
 * this feature exists for.
 */
export async function deleteUserSettings(
  tx: Transaction,
  userId: string,
): Promise<ResetDeleteCounts> {
  const counts: ResetDeleteCounts = {};

  counts.advisor_provider_keys = (
    await tx
      .delete(advisorProviderKeys)
      .where(eq(advisorProviderKeys.userId, userId))
      .returning({ id: advisorProviderKeys.id })
  ).length;

  counts.external_api_keys = (
    await tx
      .delete(externalApiKeys)
      .where(eq(externalApiKeys.userId, userId))
      .returning({ id: externalApiKeys.id })
  ).length;

  // Cascades advisor_messages and advisor_summaries.
  counts.advisor_conversations = (
    await tx
      .delete(advisorConversations)
      .where(eq(advisorConversations.userId, userId))
      .returning({ id: advisorConversations.id })
  ).length;

  // `users.advisor_default_persona_id` is ON DELETE SET NULL, so the default
  // clears itself rather than pointing at a persona that no longer exists.
  counts.advisor_personas = (
    await tx
      .delete(advisorPersonas)
      .where(eq(advisorPersonas.userId, userId))
      .returning({ id: advisorPersonas.id })
  ).length;

  counts.dashboard_layouts = (
    await tx
      .delete(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId))
      .returning({ userId: dashboardLayouts.userId })
  ).length;

  return counts;
}

/**
 * Return the `users` row to its post-registration state.
 *
 * `onboarding` is reset UNCONDITIONALLY — see `deleteUserSettings`. The
 * preference columns go back to their schema defaults only when the operator
 * asked for settings to be removed, and the values written are the ones a
 * brand-new row carries, so "reset" and "newly registered" mean the same thing.
 *
 * Never touched: `email`, `password_hash`, `is_admin`, `email_verified`,
 * `created_at`. The account is being emptied, not re-created.
 */
export async function resetUserPreferences(
  tx: Transaction,
  userId: string,
  removeSettings: boolean,
): Promise<void> {
  await tx
    .update(users)
    .set({
      // Always: the walkthrough status, the first-calculator-use stamp and the
      // set of coach marks seen. '{}' is what a brand-new row carries.
      onboarding: {},
      ...(removeSettings
        ? {
            displayCurrency: null,
            timezone: null,
            taxJurisdiction: null,
            theme: 'system',
            buyingPowerBasis: 'cash',
            advisorTradeDataConsent: false,
            changelogViewedAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/**
 * Count what a reset WOULD remove, without removing it.
 *
 * Both halves are always counted, whatever the operator has ticked, so the
 * dialog can show what including settings would add without a second request
 * that could come back with different numbers.
 */
export async function countResettableData(
  db: Database | Transaction,
  userId: string,
): Promise<{
  tradingData: {
    accounts: number;
    positions: number;
    fills: number;
    ledgerEntries: number;
    expenses: number;
    brokerages: number;
    csvImportStaging: number;
  };
  settings: {
    providerKeys: number;
    externalApiKeys: number;
    advisorPersonas: number;
    advisorConversations: number;
    dashboardLayouts: number;
  };
}> {
  const [
    accountCount,
    positionCount,
    fillCount,
    ledgerCount,
    expenseCount,
    brokerageCount,
    stagingCount,
    providerKeyCount,
    externalKeyCount,
    personaCount,
    conversationCount,
    layoutCount,
  ] = await Promise.all([
    countBy(db, accounts, accounts.userId, userId),
    countBy(db, positions, positions.userId, userId),
    countFillsForUser(db, userId),
    countBy(db, ledgerEntries, ledgerEntries.userId, userId),
    countBy(db, expenses, expenses.userId, userId),
    countBy(db, brokerages, brokerages.userId, userId),
    countBy(db, csvImportStaging, csvImportStaging.userId, userId),
    countBy(db, advisorProviderKeys, advisorProviderKeys.userId, userId),
    countBy(db, externalApiKeys, externalApiKeys.userId, userId),
    countBy(db, advisorPersonas, advisorPersonas.userId, userId),
    countBy(db, advisorConversations, advisorConversations.userId, userId),
    countBy(db, dashboardLayouts, dashboardLayouts.userId, userId),
  ]);

  return {
    tradingData: {
      accounts: accountCount,
      positions: positionCount,
      fills: fillCount,
      ledgerEntries: ledgerCount,
      expenses: expenseCount,
      brokerages: brokerageCount,
      csvImportStaging: stagingCount,
    },
    settings: {
      providerKeys: providerKeyCount,
      externalApiKeys: externalKeyCount,
      advisorPersonas: personaCount,
      advisorConversations: conversationCount,
      dashboardLayouts: layoutCount,
    },
  };
}
