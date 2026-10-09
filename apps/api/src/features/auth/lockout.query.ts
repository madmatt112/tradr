import { and, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { loginLockouts } from '@/db/schema';

import { LOCKOUT_DURATION_MS, LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_MS } from './lockout';

// Design C3 (Lockout), query half. The four statements the login, unlock and
// sweeper paths run against the task-1 `login_lockouts` table.

/**
 * Record one failed sign-in for `key` and report whether this statement is the
 * one that locked the address (Req 3.3). A single upsert: a first failure
 * inserts the window at one; a window older than 15 minutes restarts at one and
 * drops any stale lock; otherwise the count increments and, as it reaches the
 * 10th failure, `locked_until` is set 15 minutes out. `lockedNow` is true only
 * for the statement whose new count equals the threshold.
 */
export async function recordLoginFailure(
  db: Database | Transaction,
  key: string,
): Promise<{ lockedNow: boolean }> {
  const now = new Date();
  // Bound as `::timestamptz` ISO strings: a raw `sql` template does not run the
  // column's Date-to-driver mapper, so postgres.js would mis-serialise a bare
  // Date parameter.
  const nowIso = now.toISOString();
  const windowStartIso = new Date(now.getTime() - LOCKOUT_WINDOW_MS).toISOString();
  const lockUntilIso = new Date(now.getTime() + LOCKOUT_DURATION_MS).toISOString();
  const windowStarted = loginLockouts.windowStartedAt;

  const rows = await db
    .insert(loginLockouts)
    .values({
      keyHash: key,
      failureCount: 1,
      windowStartedAt: now,
      lockedUntil: null,
    })
    .onConflictDoUpdate({
      target: loginLockouts.keyHash,
      set: {
        failureCount: sql`case when ${windowStarted} < ${windowStartIso}::timestamptz then 1 else ${loginLockouts.failureCount} + 1 end`,
        windowStartedAt: sql`case when ${windowStarted} < ${windowStartIso}::timestamptz then ${nowIso}::timestamptz else ${windowStarted} end`,
        lockedUntil: sql`case when ${windowStarted} < ${windowStartIso}::timestamptz then null when ${loginLockouts.failureCount} + 1 >= ${LOCKOUT_THRESHOLD} then ${lockUntilIso}::timestamptz else ${loginLockouts.lockedUntil} end`,
      },
    })
    .returning({ failureCount: loginLockouts.failureCount });

  return { lockedNow: rows[0].failureCount === LOCKOUT_THRESHOLD };
}

/**
 * The live lock for `key`, or null when the address is not currently locked
 * (Req 3.7). A `locked_until` in the past or null does not count.
 */
export async function selectActiveLock(
  db: Database | Transaction,
  key: string,
): Promise<{ lockedUntil: Date } | null> {
  const rows = await db
    .select({ lockedUntil: loginLockouts.lockedUntil })
    .from(loginLockouts)
    .where(and(eq(loginLockouts.keyHash, key), gt(loginLockouts.lockedUntil, new Date())))
    .limit(1);

  const row = rows[0];
  return row?.lockedUntil ? { lockedUntil: row.lockedUntil } : null;
}

/**
 * Clear the counter and lock for `key` (Req 3.7, 3.10). Takes a `Database` or a
 * `Transaction` so the sign-in and account-deletion paths can clear in-line.
 */
export async function clearLockout(db: Database | Transaction, key: string): Promise<void> {
  await db.delete(loginLockouts).where(eq(loginLockouts.keyHash, key));
}

/**
 * Sweep rows whose lock and window have both passed (Req 3.10, D15): a row
 * survives while its lock is live or its window is still inside 15 minutes.
 * The account-deleted row is cleared by `clearLockout` on the deletion path.
 */
export async function deleteStaleLockouts(db: Database | Transaction): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - LOCKOUT_WINDOW_MS);

  await db
    .delete(loginLockouts)
    .where(
      and(
        or(isNull(loginLockouts.lockedUntil), lte(loginLockouts.lockedUntil, now)),
        lt(loginLockouts.windowStartedAt, windowStart),
      ),
    );
}
