import { and, eq, gt, gte, lt, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import {
  adminAuditLog,
  positions,
  sessions,
  usageRecords,
  users,
  walletTransactions,
  wallets,
} from '@/db/schema';

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

export interface AdminAuditEntryInsert {
  action: 'admin_toggle';
  actorUserId: string;
  actorEmail: string;
  targetUserId: string;
  targetEmail: string;
  oldValue: boolean;
  newValue: boolean;
}

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
