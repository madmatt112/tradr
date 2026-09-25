import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';

import type { PurgeOutcome } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { accountDeletions, accountDeletionSchedules, adminAuditLog, users } from '@/db/schema';

// ---------------------------------------------------------------------------
// Account-deletion query layer (design C3). The thin claim/lock/write
// primitives the schedule state machine (C5/C6) rests on: no business rules
// live here, only the parametrised SQL. Locking and single-writer claims take a
// `Transaction`; reads and idempotent writes accept `Database | Transaction`.
//
// TIME NOTE (probe /tmp/scratchpad/acct-del-now-probe.sh): inside one
// transaction `now()` is frozen at the transaction start. The sweep therefore
// receives its `now` as an explicit parameter — never `now()` — so a caller
// (and a test) can drive due-at and lease comparisons at a chosen instant.
// ---------------------------------------------------------------------------

export type ScheduleState = 'pending' | 'scheduled' | 'cancelling' | 'firing';

/** The full schedule row, as the sweep and cancel paths read it. */
export type ScheduleRow = typeof accountDeletionSchedules.$inferSelect;

/** The tombstone fields the deletion transaction supplies; the rest default. */
export type TombstoneInsert = {
  userId: string;
  emailHash: string;
  tier: string;
  initiator: 'self' | 'admin';
};

/**
 * Persist (or refresh) the `pending` schedule row before Stripe is called
 * (Req 3.8, D4). One `INSERT … ON CONFLICT (user_id) DO UPDATE`:
 * - a fresh insert returns `{ inserted: true }` (the row's `xmax` is 0);
 * - an existing `pending`/`scheduled` row keeps its state, takes the new
 *   `due_at`, unions the stored not-renew ids, and returns `{ inserted: false }`;
 * - an existing `cancelling`/`firing` row is excluded by the `DO UPDATE` guard,
 *   so nothing is returned and the caller sees `null` (a deletion is already in
 *   progress — Req 3.7).
 */
export async function upsertPendingSchedule(
  db: Database | Transaction,
  { userId, dueAt, renewingIds }: { userId: string; dueAt: Date; renewingIds: string[] },
): Promise<{ inserted: boolean } | null> {
  const rows = await db
    .insert(accountDeletionSchedules)
    .values({ userId, state: 'pending', dueAt, stripeSubscriptionIds: renewingIds })
    .onConflictDoUpdate({
      target: accountDeletionSchedules.userId,
      set: {
        dueAt,
        stripeSubscriptionIds: sql`ARRAY(SELECT DISTINCT unnest(${accountDeletionSchedules.stripeSubscriptionIds} || excluded.stripe_subscription_ids))`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${accountDeletionSchedules.state} IN ('pending', 'scheduled')`,
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return rows[0] ?? null;
}

/** `pending` → `scheduled` once Stripe has confirmed the not-renew flip (C5). */
export async function markScheduled(db: Database | Transaction, userId: string): Promise<void> {
  await db
    .update(accountDeletionSchedules)
    .set({ state: 'scheduled', updatedAt: sql`now()` })
    .where(
      and(
        eq(accountDeletionSchedules.userId, userId),
        inArray(accountDeletionSchedules.state, ['pending', 'scheduled']),
      ),
    );
}

/**
 * Delete the schedule row. `opts.state` and `opts.claimedAt` narrow the delete —
 * the cancel path passes the claim token so it removes only the row it claimed.
 */
export async function deleteSchedule(
  db: Database | Transaction,
  userId: string,
  opts?: { state?: ScheduleState; claimedAt?: Date },
): Promise<void> {
  const conditions = [eq(accountDeletionSchedules.userId, userId)];
  if (opts?.state) conditions.push(eq(accountDeletionSchedules.state, opts.state));
  if (opts?.claimedAt) conditions.push(eq(accountDeletionSchedules.claimedAt, opts.claimedAt));
  await db.delete(accountDeletionSchedules).where(and(...conditions));
}

/** Read the schedule row for a user, or `null` when none is scheduled. */
export async function selectSchedule(
  db: Database | Transaction,
  userId: string,
): Promise<ScheduleRow | null> {
  const [row] = await db
    .select()
    .from(accountDeletionSchedules)
    .where(eq(accountDeletionSchedules.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Cancel's atomic claim (Req 3.7): `scheduled` → `cancelling`, stamping a claim
 * token. The conditional `UPDATE … RETURNING` returns the claimed row, or `null`
 * when the row is not `scheduled` — a second claim, or a fire that already won.
 */
export async function claimForCancel(
  db: Database | Transaction,
  userId: string,
): Promise<ScheduleRow | null> {
  const [row] = await db
    .update(accountDeletionSchedules)
    .set({ state: 'cancelling', claimedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(accountDeletionSchedules.userId, userId),
        eq(accountDeletionSchedules.state, 'scheduled'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Re-arm the fire: `cancelling`/`firing` → `scheduled`, guarded on the claim
 * token so only the holder of that claim reverts it. Used when a cancel's Stripe
 * re-enable fails (D18) and when the sweep releases a stale `cancelling` row.
 */
export async function revertToScheduled(
  db: Database | Transaction,
  userId: string,
  claimedAt: Date,
): Promise<ScheduleRow | null> {
  const [row] = await db
    .update(accountDeletionSchedules)
    .set({ state: 'scheduled', claimedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(accountDeletionSchedules.userId, userId),
        inArray(accountDeletionSchedules.state, ['cancelling', 'firing']),
        eq(accountDeletionSchedules.claimedAt, claimedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The sweep's fire claim (D3): one `UPDATE` moving due `scheduled` rows and
 * lease-expired `firing` rows to `firing`, stamping `claimed_at = now` (the
 * explicit sweep instant). The inner `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`
 * lets concurrent sweepers take disjoint batches. `now` and `leaseMs` are
 * parameters so the lease cutoff is computed against the caller's clock, not the
 * frozen transaction `now()`.
 */
export async function claimDueSchedules(
  db: Database | Transaction,
  now: Date,
  leaseMs: number,
  limit: number,
): Promise<ScheduleRow[]> {
  const leaseCutoff = new Date(now.getTime() - leaseMs);
  const due = db
    .select({ userId: accountDeletionSchedules.userId })
    .from(accountDeletionSchedules)
    .where(
      or(
        and(
          eq(accountDeletionSchedules.state, 'scheduled'),
          lte(accountDeletionSchedules.dueAt, now),
        ),
        and(
          eq(accountDeletionSchedules.state, 'firing'),
          isNotNull(accountDeletionSchedules.claimedAt),
          lte(accountDeletionSchedules.claimedAt, leaseCutoff),
        ),
      ),
    )
    .orderBy(accountDeletionSchedules.dueAt)
    .limit(limit)
    .for('update', { skipLocked: true });

  return db
    .update(accountDeletionSchedules)
    .set({ state: 'firing', claimedAt: now, updatedAt: sql`now()` })
    .where(inArray(accountDeletionSchedules.userId, due))
    .returning();
}

/**
 * Release rows a crash left mid-flight (measured against `now - leaseMs`): a
 * `pending` row whose Stripe call never landed is deleted, and a stuck
 * `cancelling` row is reverted to `scheduled` so the fire re-arms. Returns the
 * user ids of each so the sweeper can warn on them.
 */
export async function sweepStaleSchedules(
  db: Database | Transaction,
  now: Date,
  leaseMs: number,
): Promise<{ pendingDeleted: string[]; cancellingReverted: string[] }> {
  const leaseCutoff = new Date(now.getTime() - leaseMs);
  const pending = await db
    .delete(accountDeletionSchedules)
    .where(
      and(
        eq(accountDeletionSchedules.state, 'pending'),
        lte(accountDeletionSchedules.updatedAt, leaseCutoff),
      ),
    )
    .returning({ userId: accountDeletionSchedules.userId });
  const cancelling = await db
    .update(accountDeletionSchedules)
    .set({ state: 'scheduled', claimedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(accountDeletionSchedules.state, 'cancelling'),
        isNotNull(accountDeletionSchedules.claimedAt),
        lte(accountDeletionSchedules.claimedAt, leaseCutoff),
      ),
    )
    .returning({ userId: accountDeletionSchedules.userId });
  return {
    pendingDeleted: pending.map((r) => r.userId),
    cancellingReverted: cancelling.map((r) => r.userId),
  };
}

/**
 * Lock the `firing` row the fire claimed before `executeDeletion` runs, guarded
 * on the claim token. `FOR UPDATE`, raw SQL per the `selectUserFlagForUpdate`
 * idiom (`apps/api/src/features/admin/admin.query.ts:351-359`). `null` when a
 * cancel won the claim first — the fire aborts as a no-op.
 */
export async function lockFiringSchedule(
  tx: Transaction,
  userId: string,
  claimedAt: Date,
): Promise<ScheduleRow | null> {
  // A raw `sql` template binds a Date as a row composite, not a timestamp, so
  // pass the ISO string and let Postgres cast it (the performance.query.ts idiom).
  const result = await tx.execute(
    sql`SELECT * FROM account_deletion_schedules WHERE user_id = ${userId} AND state = 'firing' AND claimed_at = ${claimedAt.toISOString()} FOR UPDATE`,
  );
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    userId: row.user_id as string,
    state: row.state as ScheduleState,
    dueAt: new Date(row.due_at as string),
    stripeSubscriptionIds: row.stripe_subscription_ids as string[],
    claimedAt: row.claimed_at == null ? null : new Date(row.claimed_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Lock the target `users` row for the deletion transaction and return the
 * fields the guards read. `FOR UPDATE`, raw SQL per `selectUserFlagForUpdate`
 * (`apps/api/src/features/admin/admin.query.ts:351-359`); `null` when the user
 * is already gone.
 */
export async function selectUserForDeletion(
  tx: Transaction,
  id: string,
): Promise<{ id: string; email: string; isAdmin: boolean } | null> {
  const result = await tx.execute(
    sql`SELECT id, email, is_admin FROM users WHERE id = ${id} FOR UPDATE`,
  );
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return { id: row.id as string, email: row.email as string, isAdmin: row.is_admin as boolean };
}

/** The password-gate read (Req 1.1): unlocked, hash only. */
export async function selectPasswordHashById(
  db: Database | Transaction,
  id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row?.passwordHash ?? null;
}

/** Write the tombstone with `purge_outcome = 'pending'` (defaults); return its id. */
export async function insertTombstone(tx: Transaction, row: TombstoneInsert): Promise<string> {
  const [inserted] = await tx
    .insert(accountDeletions)
    .values({
      userId: row.userId,
      emailHash: row.emailHash,
      tier: row.tier,
      initiator: row.initiator,
    })
    .returning({ id: accountDeletions.id });
  return inserted.id;
}

/** Set the tombstone's terminal purge outcome after the post-commit purge (Req 5.2). */
export async function updateTombstonePurge(
  db: Database | Transaction,
  id: string,
  outcome: PurgeOutcome,
): Promise<void> {
  await db
    .update(accountDeletions)
    .set({ purgeOutcome: outcome })
    .where(eq(accountDeletions.id, id));
}

/**
 * Overwrite the deleted user's email snapshots in `admin_audit_log` with the
 * tombstone marker (Req 4.3): two `UPDATE`s, one per role the user held.
 */
export async function rewriteAuditEmails(
  tx: Transaction,
  userId: string,
  marker: string,
): Promise<void> {
  await tx
    .update(adminAuditLog)
    .set({ actorEmail: marker })
    .where(eq(adminAuditLog.actorUserId, userId));
  await tx
    .update(adminAuditLog)
    .set({ targetEmail: marker })
    .where(eq(adminAuditLog.targetUserId, userId));
}

/** The single `DELETE FROM users`; the FK cascade removes every user-keyed row. */
export async function deleteUserRow(tx: Transaction, userId: string): Promise<number> {
  const deleted = await tx.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  return deleted.length;
}
