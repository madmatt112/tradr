import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { csvImportCounters, csvImportStaging } from '@/db/schema/csv-import.schema';
import { fills, positions } from '@/db/schema/positions.schema';
import { config } from '@/lib/config';

// ---------------------------------------------------------------------------
// Staging store (design Component 8) + windowed duplicate scan (Component 12).
//
// Locking/write queries take Transaction (structure.md); reads take
// Database | Transaction. Every query scopes to userId. The claim / finalize /
// recovery WHERE predicates are load-bearing for the concurrency guarantees —
// do not relax them. All values are parameterized via Drizzle (no string
// interpolation of user data).
// ---------------------------------------------------------------------------

/** Existing fill match-key tuple for in-memory duplicate comparison (Component 12). */
export interface AccountFillKey {
  symbol: string;
  filledAt: Date;
  price: string;
  quantity: string;
  type: string;
}

/** Stored Phase-B summary written into `committed_result` on finalize. */
export interface CommittedResult {
  positionsCreated: number;
  fillsCreated: number;
  positionIds: string[];
  accountId: string;
}

/**
 * Measure the serialized byte size of a staged `result` payload before insert
 * (Component 8 — enforced byte cap). Returns UTF-8 byte length.
 */
export function measureStagedBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/**
 * Lazy reaping (Component 8, no cron). On each preview/commit:
 * (1) delete expired terminal rows, (2) mark past-TTL `staged`/`committing`
 * rows `expired`, (3) delete orphaned `committing` rows (Phase B never
 * committed — `committed_result IS NULL` — and the claim is older than
 * CSV_IMPORT_CLAIM_TIMEOUT_SECONDS). Scoped to one user.
 */
export async function reapStaging(tx: Transaction, userId: string): Promise<void> {
  // (1) delete expired terminal rows for this user.
  await tx.execute(sql`
    DELETE FROM ${csvImportStaging}
    WHERE user_id = ${userId}
      AND status IN ('committed', 'superseded', 'expired')
      AND expires_at < now()
  `);

  // (2) mark past-TTL pre-commit rows as expired.
  await tx.execute(sql`
    UPDATE ${csvImportStaging}
    SET status = 'expired'
    WHERE user_id = ${userId}
      AND status IN ('staged', 'committing')
      AND expires_at < now()
  `);

  // (3) delete orphaned committing rows (process death between/within phases).
  await recoverOrphanedCommitting(tx, userId);
}

/**
 * Orphaned-`committing` recovery (Component 8, pinned query — DELETE, not
 * reset). A `committing` row with `committed_result IS NULL` whose claim is
 * older than the claim timeout never committed data (Phase B is atomic), so it
 * is safe to delete; a still-live slow Phase B is caught by its status-guarded
 * finalize (Component 7).
 */
export async function recoverOrphanedCommitting(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM ${csvImportStaging}
    WHERE user_id = ${userId}
      AND status = 'committing'
      AND committed_result IS NULL
      AND claimed_at < now() - make_interval(secs => ${config.CSV_IMPORT_CLAIM_TIMEOUT_SECONDS})
  `);
}

/**
 * Insert a new staged row (Component 8). Supersedes any existing `staged` row
 * for the user first, then inserts the new row. `expires_at = now() + TTL`.
 * Runs inside the preview tx (after `reapStaging`). The partial unique index
 * makes the insert collide if a live `committing` row exists — the caller maps
 * that to 409 CSV_IMPORT_IN_PROGRESS.
 *
 * Returns the new row id (the single-use token).
 */
export async function insertStaged(
  tx: Transaction,
  userId: string,
  accountId: string,
  result: unknown,
): Promise<string> {
  // Supersede the user's existing staged preview (one active import per user).
  await tx
    .update(csvImportStaging)
    .set({ status: 'superseded' })
    .where(and(eq(csvImportStaging.userId, userId), eq(csvImportStaging.status, 'staged')));

  const [row] = await tx
    .insert(csvImportStaging)
    .values({
      userId,
      accountId,
      status: 'staged',
      result,
      expiresAt: sql`now() + make_interval(mins => ${config.CSV_IMPORT_STAGING_TTL_MINUTES})`,
    })
    .returning({ id: csvImportStaging.id });

  return row.id;
}

/** A staged row as read for the commit Phase-A re-checks (Component 7). */
export interface StagedRow {
  id: string;
  userId: string;
  accountId: string;
  status: string;
  result: unknown;
  committedResult: CommittedResult | null;
  expiresAt: Date;
}

/**
 * Read a staged row by token for the authenticated user (Component 7 Phase A
 * re-checks). userId-scoped; safe to call outside a transaction.
 */
export async function selectStagedByToken(
  db: Database | Transaction,
  userId: string,
  token: string,
): Promise<StagedRow | undefined> {
  const [row] = await db
    .select({
      id: csvImportStaging.id,
      userId: csvImportStaging.userId,
      accountId: csvImportStaging.accountId,
      status: csvImportStaging.status,
      result: csvImportStaging.result,
      committedResult: csvImportStaging.committedResult,
      expiresAt: csvImportStaging.expiresAt,
    })
    .from(csvImportStaging)
    .where(and(eq(csvImportStaging.id, token), eq(csvImportStaging.userId, userId)))
    .limit(1);

  return row as StagedRow | undefined;
}

/**
 * Atomic, non-blocking claim (Component 7 Phase A). The conditional
 * `status='staged'` predicate makes a concurrent double-submit resolve with
 * exactly one winner; the loser matches zero rows. Returns the staged `result`
 * for the winner, or `undefined` (zero rows) for the loser.
 *
 * MUST run in its own short transaction that commits immediately (Phase A).
 */
export async function claimStaged(
  tx: Transaction,
  userId: string,
  token: string,
): Promise<{ result: unknown } | undefined> {
  const [row] = await tx
    .update(csvImportStaging)
    .set({ status: 'committing', claimedAt: sql`now()` })
    .where(
      and(
        eq(csvImportStaging.id, token),
        eq(csvImportStaging.userId, userId),
        eq(csvImportStaging.status, 'staged'),
      ),
    )
    .returning({ result: csvImportStaging.result });

  return row;
}

/**
 * Status-guarded finalize (Component 7 Phase B). The `status='committing'`
 * guard closes the recovery race: if a concurrent reap reset/deleted the row,
 * this matches zero rows and the caller rolls back the whole bulk tx. Runs
 * inside the bulk tx so the `committed` flag commits atomically with the data.
 *
 * Returns true if the row was finalized; false if the claim was lost.
 */
export async function finalizeStaged(
  tx: Transaction,
  token: string,
  summary: CommittedResult,
): Promise<boolean> {
  const rows = await tx
    .update(csvImportStaging)
    .set({ status: 'committed', committedResult: summary })
    .where(and(eq(csvImportStaging.id, token), eq(csvImportStaging.status, 'committing')))
    .returning({ id: csvImportStaging.id });

  return rows.length > 0;
}

/**
 * Phase-B-failure compensating delete (Component 7 / Component 8). The bulk tx
 * rolled back all data; delete the claimed `committing` row so a retry must
 * re-preview. Reset-to-`staged` is avoided (could collide under the widened
 * unique index). Runs in its own tiny tx.
 */
export async function deleteClaimedStaged(tx: Transaction, token: string): Promise<void> {
  await tx
    .delete(csvImportStaging)
    .where(and(eq(csvImportStaging.id, token), eq(csvImportStaging.status, 'committing')));
}

/**
 * Lifetime committed-import count for the L6 allowance (plan-tiers REQ-10.2).
 * PK read on `csv_import_counters`; 0 when the user has never committed an
 * import. Read-only: `Database | Transaction`.
 */
export async function selectCsvImportCount(
  db: Database | Transaction,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ committedCount: csvImportCounters.committedCount })
    .from(csvImportCounters)
    .where(eq(csvImportCounters.userId, userId))
    .limit(1);
  return row?.committedCount ?? 0;
}

/**
 * Upsert-increment of the lifetime committed-import counter (plan-tiers
 * REQ-10.2/10.4). MUST run inside the Phase-B bulk transaction immediately
 * before `finalizeStaged` so the increment commits atomically with the created
 * positions — a refusal or crashed commit consumes nothing. Never decremented
 * and no user-facing reset path exists (non-evasion); the only removal is the
 * user-deletion CASCADE.
 */
export async function incrementCsvImportCounter(tx: Transaction, userId: string): Promise<void> {
  await tx
    .insert(csvImportCounters)
    .values({ userId, committedCount: 1 })
    .onConflictDoUpdate({
      target: csvImportCounters.userId,
      set: {
        committedCount: sql`${csvImportCounters.committedCount} + 1`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Date-windowed duplicate scan (Component 12). Returns existing fill match-key
 * tuples for the target account, scoped to userId, bounded to the incoming
 * file's `[minFilledAt, maxFilledAt]` window (via `fills JOIN positions` on
 * account_id + user_id). Read-only; compared in-memory against incoming keys.
 */
export function selectAccountFillKeys(
  db: Database | Transaction,
  userId: string,
  accountId: string,
  minFilledAt: Date,
  maxFilledAt: Date,
): Promise<AccountFillKey[]> {
  return db
    .select({
      symbol: positions.symbol,
      filledAt: fills.filledAt,
      price: fills.price,
      quantity: fills.quantity,
      type: fills.type,
    })
    .from(fills)
    .innerJoin(positions, eq(fills.positionId, positions.id))
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.accountId, accountId),
        gte(fills.filledAt, minFilledAt),
        lte(fills.filledAt, maxFilledAt),
      ),
    );
}
