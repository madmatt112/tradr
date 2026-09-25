import { createHash } from 'node:crypto';

import type { PurgeOutcome } from '@tradr/shared';

import { db } from '@/db';
import {
  insertAdminAuditEntry,
  selectAdminIdsForUpdate,
  selectUserEmailById,
} from '@/features/admin/admin.query';
import { resolveTier } from '@/features/billing/tier.query';
import { AppError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getObjectStorage } from '@/lib/object-storage';
import { purgeUserObjects } from '@/lib/object-storage/purge';
import { captureServerEvent, deletePostHogPerson } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  deleteUserRow,
  insertTombstone,
  lockFiringSchedule,
  rewriteAuditEmails,
  selectUserForDeletion,
  updateTombstonePurge,
} from './account-deletion.query';

// ---------------------------------------------------------------------------
// The deletion service (design C5). This module owns the ONE path that deletes
// a user — the transaction and the post-commit side effects — shared by the
// self-service, admin and fire flows. The password gate, guard pre-checks,
// Stripe handling and schedule state machine that wrap it live in the request
// entry points (requestSelfDeletion / adminDeleteUser / fireScheduledDeletion),
// added in later tasks; this task builds only `emailHash` and `executeDeletion`.
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
