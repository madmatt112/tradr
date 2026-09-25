/**
 * Per-user object-storage purge for account deletion (§39; design C9;
 * Req 5.1-5.3). For each user-scoped prefix, list the user's keys, delete each,
 * then list again: an empty re-list is an honest `complete`; a throw or a
 * non-empty re-list is `incomplete` (with one warn log naming the user and
 * prefix) so the caller can leave the tombstone for the age-guarded gc backstop
 * to finish. A null store — object storage unconfigured, self-host parity — is
 * `not_applicable`: there is nothing to purge.
 */
import type { PurgeOutcome } from '@tradr/shared';

import { logger } from '../logger';

import { USER_OBJECT_PREFIXES, type ObjectStorage } from './index';

/**
 * Delete every stored object for `userId` under each `USER_OBJECT_PREFIXES`
 * entry and report an honest outcome. Never throws: object storage is a
 * best-effort backend and the gc sweep is the backstop.
 */
export async function purgeUserObjects(
  storage: ObjectStorage | null,
  userId: string,
): Promise<PurgeOutcome> {
  if (!storage) return 'not_applicable';

  let outcome: PurgeOutcome = 'complete';
  for (const prefix of USER_OBJECT_PREFIXES) {
    const userPrefix = `${prefix}${userId}/`;
    try {
      const listed = await storage.list(userPrefix);
      for (const { key } of listed) {
        await storage.delete(key);
      }
      const remaining = await storage.list(userPrefix);
      if (remaining.length > 0) {
        logger.warn('account-deletion object purge: keys remain after delete', {
          userId,
          prefix,
        });
        outcome = 'incomplete';
      }
    } catch (error) {
      logger.warn('account-deletion object purge: list or delete failed', {
        userId,
        prefix,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = 'incomplete';
    }
  }
  return outcome;
}
