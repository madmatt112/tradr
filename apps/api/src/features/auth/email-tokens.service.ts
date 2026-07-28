import crypto from 'node:crypto';

import { db } from '@/db';
import { logger } from '@/lib/logger';
import { withTransaction } from '@/lib/transaction';

import { deleteEmailTokens, insertEmailToken, type EmailTokenPurpose } from './email-tokens.query';

// TTLs are code constants, not env vars (D5).
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Thrown when issuance loses two consecutive 23505 races on the partial unique
 * index (D4). Caller translations are pinned per-endpoint (Component 4): every
 * caller maps this to its normal success response — non-oracle, cured by
 * re-requesting.
 */
export class IssuanceConflictError extends Error {
  constructor() {
    super('Token issuance lost two consecutive uniqueness races');
    this.name = 'IssuanceConflictError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code: string }).code === '23505';
}

/**
 * Newest-wins issuance (D4): ONE transaction deleting the pair's outstanding
 * rows and inserting the new one. On a 23505 from the partial unique index
 * (a concurrent issuance won the race) it re-invokes `withTransaction` for
 * exactly one retry of the whole delete+insert — necessarily a FRESH
 * transaction (the conflicting one is already aborted; an in-callback retry
 * would die 25P02), and by the time the conflict surfaces the rival's row is
 * committed, so the retry's DELETE sees it. A second consecutive conflict logs
 * at `warn` and throws `IssuanceConflictError`.
 *
 * Returns the RAW token — the only moment it exists server-side; never logged.
 */
export async function issueEmailToken(
  userId: string,
  purpose: EmailTokenPurpose,
  ttlMs: number,
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + ttlMs);

  const attempt = () =>
    withTransaction(db, async (tx) => {
      await deleteEmailTokens(tx, userId, purpose);
      await insertEmailToken(tx, { userId, purpose, tokenHash, expiresAt });
    });

  try {
    await attempt();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      await attempt();
    } catch (retryError) {
      if (!isUniqueViolation(retryError)) throw retryError;
      logger.warn('email_token_issuance_conflict', { userId, purpose });
      throw new IssuanceConflictError();
    }
  }

  return token;
}
