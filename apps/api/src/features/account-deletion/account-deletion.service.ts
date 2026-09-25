import { createHash } from 'node:crypto';

import bcrypt from 'bcrypt';

import type { AccountDeletionResult, AccountDeletionStatus, PurgeOutcome } from '@tradr/shared';

import { db } from '@/db';
import {
  countAdmins,
  insertAdminAuditEntry,
  selectAdminIdsForUpdate,
  selectUserEmailById,
} from '@/features/admin/admin.query';
import { selectUserById } from '@/features/auth/auth.query';
import { getStripeClient } from '@/features/billing/stripe-client';
import {
  selectBillingCustomerByUser,
  selectSubscriptionsByUser,
} from '@/features/billing/subscription.query';
import { listLiveSubscriptions, setRenewal } from '@/features/billing/subscription.service';
import { resolveTier, TERMINAL_SUBSCRIPTION_STATUSES } from '@/features/billing/tier.query';
import { AppError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getObjectStorage } from '@/lib/object-storage';
import { purgeUserObjects } from '@/lib/object-storage/purge';
import { captureServerEvent, deletePostHogPerson } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  claimForCancel,
  deleteSchedule,
  deleteUserRow,
  insertTombstone,
  lockFiringSchedule,
  markScheduled,
  revertToScheduled,
  rewriteAuditEmails,
  selectPasswordHashById,
  selectSchedule,
  selectUserForDeletion,
  updateTombstonePurge,
  upsertPendingSchedule,
  type ScheduleState,
} from './account-deletion.query';

// ---------------------------------------------------------------------------
// The deletion service (design C5). This module owns the ONE path that deletes
// a user — `executeDeletion`, the transaction and the post-commit side effects
// shared by the self-service, admin and fire flows — plus the self-service
// entry points that wrap it: `requestSelfDeletion` (password gate, guard
// pre-checks, Stripe not-renew and the schedule state machine),
// `cancelScheduledDeletion` and `getDeletionStatus`. The admin
// (`adminDeleteUser`) and fire (`fireScheduledDeletion`) entry points are added
// in later tasks.
// ---------------------------------------------------------------------------

/** `deleted:` + the email hash is the audit-log marker (72 chars, design C5). */
const AUDIT_MARKER_PREFIX = 'deleted:';

/**
 * The tombstone / audit email hash: SHA-256 hex of the trimmed, lowercased
 * address (Req 4.2, unsalted so the operator can match a known address, D3).
 * Computed server-side and never returned in a response.
 */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export type ExecuteDeletionArgs = {
  userId: string;
  initiator: 'self' | 'admin';
  /** The acting admin's id (admin flow only) — audited as the actor. */
  actorId?: string;
  /** The fire's claim token (sweeper only): re-lock the `firing` row first. */
  fireClaim?: Date;
};

/**
 * Delete one user in a single transaction, then run the best-effort post-commit
 * side effects (design C5). Steps 1-9 run inside one locked transaction; a
 * pre-commit refusal (last admin, vanished user) throws and deletes nothing.
 * After commit the purge, analytics event and person deletion are best-effort:
 * a failure is logged and never reverses the deletion (Reliability, Req 5).
 */
export async function executeDeletion(
  args: ExecuteDeletionArgs,
): Promise<{ purgeOutcome: PurgeOutcome }> {
  const { userId, initiator, actorId, fireClaim } = args;

  const tombstoneId = await withTransaction(db, async (tx) => {
    // 1. Fire only: re-lock the `firing` row for this claim; a missing row means
    //    a cancel won the claim first (Req 3.7), so the fire is a no-op.
    if (fireClaim) {
      const firing = await lockFiringSchedule(tx, userId, fireClaim);
      if (!firing) return null;
    }
    // 2. Lock the admin set BEFORE the target row — the order `toggleAdmin` takes
    //    (admin.service.ts:177-185), so the last-admin guard is race-safe.
    const adminIds = await selectAdminIdsForUpdate(tx);
    // 3. Lock and read the target; a vanished user is a 404 (Req 6.5).
    const user = await selectUserForDeletion(tx, userId);
    if (!user) throw new NotFoundError('User', userId);
    // 4. Last-admin guard (Req 2.1-2.2, D2): deleting the only admin is refused.
    if (user.isAdmin && adminIds.length <= 1) {
      throw new AppError(409, 'LAST_ADMIN', 'Cannot delete the last admin');
    }
    // 5. Resolve the tier before the row (and its subscriptions) are gone.
    const { tier } = await resolveTier(tx, userId);
    // 6. Write the tombstone with `purge_outcome = 'pending'`.
    const hash = emailHash(user.email);
    const marker = `${AUDIT_MARKER_PREFIX}${hash}`;
    const id = await insertTombstone(tx, { userId, emailHash: hash, tier, initiator });
    // 7. Overwrite the deleted user's audit-email snapshots with the marker
    //    (Req 4.3) — before the delete, while the user-id columns still match.
    await rewriteAuditEmails(tx, userId, marker);
    // 8. Admin only: one `account_deletion` audit row for the deletion itself.
    if (initiator === 'admin' && actorId) {
      const actorEmail = await selectUserEmailById(tx, actorId);
      if (actorEmail === null) throw new NotFoundError('User', actorId);
      await insertAdminAuditEntry(tx, {
        action: 'account_deletion',
        actorUserId: actorId,
        actorEmail,
        targetUserId: null,
        targetEmail: marker,
      });
    }
    // 9. The single `DELETE FROM users`; the FK cascade removes every user-keyed
    //    row (rolled-back probe acct-del-cascade-probe3.sh, Postgres 16.15).
    await deleteUserRow(tx, userId);
    return id;
  });

  // A fire that found no `firing` row deleted nothing: no post-commit work.
  if (tombstoneId === null) {
    return { purgeOutcome: 'not_applicable' };
  }

  // After commit — best-effort, never reverses the deletion (Req 5, Reliability):
  const purgeOutcome = await purgeUserObjects(getObjectStorage(), userId);
  await updateTombstonePurge(db, tombstoneId, purgeOutcome);
  captureServerEvent('user_deleted', {
    distinctId: 'anonymous',
    properties: { initiator, purgeOutcome },
  });
  void deletePostHogPerson(userId);
  logger.info('account deleted', { userId, initiator, outcome: purgeOutcome });

  return { purgeOutcome };
}

/**
 * Self-service request (design C5, Req 1 and Req 3). The password gate, guards,
 * and the immediate-vs-scheduled decision, walking the schedule state table:
 *   1. bcrypt gate — a mismatch is `403 INVALID_PASSWORD`; no log or event
 *      carries the password or email.
 *   2. Guard pre-checks (fast refusals before any Stripe work): a last admin is
 *      `409 LAST_ADMIN` (the locked re-check in `executeDeletion` is the
 *      authority); Stripe unconfigured with a non-terminal mirror row is
 *      `409 SUBSCRIPTION_UNRESOLVED`, logged.
 *   3. A `cancelling`/`firing` schedule row is `409 DELETION_IN_PROGRESS`.
 *   4-5. No live subscription (Stripe unconfigured, unlinked, or all terminal):
 *      delete any pending/scheduled row and delete immediately.
 *   6. Live: persist the pending row, flip only the renewing ids not to renew,
 *      then either delete-and-fire (every renewing id already canceled — R4-3)
 *      or `markScheduled`. A failed flip compensates the flipped ids, deletes
 *      the row it inserted, and throws `502 STRIPE_CANCEL_FAILED`.
 */
export async function requestSelfDeletion(
  userId: string,
  password: string,
): Promise<AccountDeletionResult> {
  // 1. Password gate (Req 1.1), the bcrypt compare `loginUser` runs.
  const passwordHash = await selectPasswordHashById(db, userId);
  const valid = passwordHash !== null && (await bcrypt.compare(password, passwordHash));
  if (!valid) {
    throw new AppError(403, 'INVALID_PASSWORD', 'Incorrect password');
  }

  // The immediate-deletion tail, shared by the none-live and already-canceled
  // branches: drop any pending/scheduled row, then run the delete transaction.
  const deleteImmediately = async (): Promise<AccountDeletionResult> => {
    await deleteSchedule(db, userId);
    await executeDeletion({ userId, initiator: 'self' });
    return { outcome: 'deleted' };
  };

  // 2. Guard pre-checks (Req 2). Last admin: unlocked count plus the caller's
  //    flag; `executeDeletion`'s locked re-check is the race-safe authority.
  const caller = await selectUserById(db, userId);
  if (caller?.isAdmin && (await countAdmins(db)) <= 1) {
    throw new AppError(409, 'LAST_ADMIN', 'Cannot delete the last admin');
  }
  const stripe = getStripeClient();
  //    Req 2.3: Stripe unconfigured but a live mirror row remains — unresolvable.
  if (stripe === null) {
    const mirrors = await selectSubscriptionsByUser(db, userId);
    if (mirrors.some((m) => !TERMINAL_SUBSCRIPTION_STATUSES.has(m.status))) {
      logger.warn('account deletion refused: subscription unresolved', { userId });
      throw new AppError(
        409,
        'SUBSCRIPTION_UNRESOLVED',
        'Resolve your subscription before deleting your account',
      );
    }
  }

  // 3. A deletion already mid-flight (claimed by cancel or fire) blocks a new one.
  const existing = await selectSchedule(db, userId);
  if (existing !== null && (existing.state === 'cancelling' || existing.state === 'firing')) {
    throw new AppError(409, 'DELETION_IN_PROGRESS', 'A deletion is already in progress');
  }

  // 4-5. No live subscription → immediate deletion. Stripe unconfigured means
  //      no live subscription; the guard above already refused an unresolved one.
  if (stripe === null) {
    return deleteImmediately();
  }
  const link = await selectBillingCustomerByUser(db, userId);
  const live = link === null ? [] : await listLiveSubscriptions(stripe, link.stripeCustomerId);
  if (live.length === 0) {
    return deleteImmediately();
  }

  // 6. Live: schedule to the latest period end, flipping the renewing ids not to
  //    renew (a live id already not renewing is left alone — D6). Persist the
  //    pending row before any Stripe call (Req 3.8).
  const dueAt = live.reduce((max, s) => (s.periodEnd > max ? s.periodEnd : max), live[0].periodEnd);
  const renewingIds = live.filter((s) => !s.cancelAtPeriodEnd).map((s) => s.id);
  const upsert = await upsertPendingSchedule(db, { userId, dueAt, renewingIds });
  if (upsert === null) {
    throw new AppError(409, 'DELETION_IN_PROGRESS', 'A deletion is already in progress');
  }

  const flipped: string[] = [];
  try {
    for (const id of renewingIds) {
      const result = await setRenewal(stripe, id, false);
      if (result === 'ok') flipped.push(id);
    }
  } catch (err) {
    // Compensation (step 6, Error Handling 6): restore every id this request
    // flipped. A restore that itself throws leaves that id not renewing; the one
    // record is a `logger.error` naming the user and each still-flipped id.
    const stillFlipped: string[] = [];
    for (const id of flipped) {
      try {
        await setRenewal(stripe, id, true);
      } catch {
        stillFlipped.push(id);
      }
    }
    if (upsert.inserted) {
      await deleteSchedule(db, userId);
    }
    if (stillFlipped.length > 0) {
      logger.error('account deletion compensation failed', {
        userId,
        subscriptionIds: stillFlipped,
        error: err,
      });
    }
    throw new AppError(502, 'STRIPE_CANCEL_FAILED', 'Could not update your subscription');
  }

  // Every live subscription was renewing and Stripe reports each already
  // canceled: nothing will renew, so drop the row and delete now (R4-3).
  if (renewingIds.length === live.length && flipped.length === 0) {
    return deleteImmediately();
  }

  // Otherwise the schedule is armed for the fire at `dueAt`.
  await markScheduled(db, userId);
  return { outcome: 'scheduled', scheduledFor: dueAt.toISOString() };
}

/**
 * Cancel a scheduled self-service deletion (design C5, Req 3.3, Req 3.7). One
 * atomic claim decides cancel-versus-fire: `claimForCancel` flips `scheduled` →
 * `cancelling`, so a lost claim (no row, or a row already `pending`/`cancelling`/
 * `firing`) makes no Stripe call. On a claimed row every stored not-renew id is
 * re-enabled; a Stripe failure reverts the row to `scheduled` (re-arming the
 * fire, D18) and errors so the user can retry.
 */
export async function cancelScheduledDeletion(userId: string): Promise<void> {
  // The caller owns the claim token so it round-trips exactly through the token
  // guards (a `now()`-stamped token loses microseconds on read — see
  // `claimForCancel`).
  const claimToken = new Date();
  const claimed = await claimForCancel(db, userId, claimToken);
  if (claimed === null) {
    const existing = await selectSchedule(db, userId);
    if (existing === null) {
      throw new AppError(404, 'NO_DELETION_SCHEDULED', 'No scheduled deletion to cancel');
    }
    // A `pending`, `cancelling` or `firing` row: a deletion is already in flight.
    throw new AppError(409, 'DELETION_IN_PROGRESS', 'A deletion is already in progress');
  }

  const stripe = getStripeClient();
  if (stripe === null) {
    await revertToScheduled(db, userId, claimToken);
    throw new AppError(402, 'BILLING_NOT_AVAILABLE', 'Billing is not available');
  }

  try {
    for (const id of claimed.stripeSubscriptionIds) {
      // An `already_canceled` result has nothing to restore; a real error reverts.
      await setRenewal(stripe, id, true);
    }
  } catch {
    await revertToScheduled(db, userId, claimToken);
    throw new AppError(502, 'STRIPE_REENABLE_FAILED', 'Could not restore your subscription');
  }

  await deleteSchedule(db, userId, { state: 'cancelling', claimedAt: claimToken });
}

/**
 * The scheduled-deletion status for the Account settings section (design C5/C7,
 * Req 8.4). No row → `{ scheduledFor: null, state: null }` (the C7 cancel
 * response); a row → its `due_at` as an ISO string and its state.
 */
export async function getDeletionStatus(userId: string): Promise<AccountDeletionStatus> {
  const row = await selectSchedule(db, userId);
  if (row === null) {
    return { scheduledFor: null, state: null };
  }
  return { scheduledFor: row.dueAt.toISOString(), state: row.state as ScheduleState };
}
