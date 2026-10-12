// Lockout service — the unlock-email sender half of design C3 and the
// token-consuming unlock half of design C6. Separate from the pure lockout
// logic and the queries: this is the one place that reaches the token issuer,
// the mailer, and (for the emailed link) the atomic consume-and-clear.

import crypto from 'node:crypto';

import { db } from '@/db';
import { isEmailConfigured } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { dispatchEmail } from '@/lib/mailer';
import { withTransaction } from '@/lib/transaction';

import { selectUserById } from './auth.query';
import { consumeEmailToken } from './email-tokens.query';
import { issueEmailToken, UNLOCK_TOKEN_TTL_MS } from './email-tokens.service';
import { lockoutKey } from './lockout';
import { clearLockout } from './lockout.query';

/**
 * Issue one `account_unlock` token (15-minute TTL, D14) and dispatch the unlock
 * email (REQ-4.7, REQ-4.8). A no-op when email is unconfigured — no token is
 * issued and nothing is sent (REQ-4.10). Every failure is swallowed and logged
 * with `userId` and the purpose only — never the token, never the address
 * (Reliability NFR) — so the caller (fire-and-forget on `lockedNow`) is never
 * made to await a send or surface its failure.
 */
export async function sendUnlockEmail(userId: string, email: string): Promise<void> {
  if (!isEmailConfigured()) return;
  try {
    const rawToken = await issueEmailToken(userId, 'account_unlock', UNLOCK_TOKEN_TTL_MS);
    dispatchEmail(email, { kind: 'account_unlock', rawToken });
  } catch {
    logger.error('unlock_email_failed', { userId, purpose: 'account_unlock' });
  }
}

/**
 * Clear a lock from the emailed unlock link (design C6; Req 3.7, 4.7, 4.8). ONE
 * transaction, the `completePasswordReset` shape
 * (`password-reset.service.ts:75-83`):
 *
 * 1. `consumeEmailToken` — the D7 atomic conditional UPDATE scoped to the
 *    `account_unlock` purpose; zero rows (expired, consumed, unknown, or a
 *    wrong-purpose token such as `password_reset`) is indistinguishable → the
 *    transaction rolls back and we throw 400 `INVALID_OR_EXPIRED_TOKEN`.
 * 2. Read the token owner's address and clear the lock for its key (task 4's
 *    `clearLockout`). An address with no live lock clears nothing and still
 *    succeeds — the token was spent, so the answer is 200.
 *
 * Consumes an existing token and sends nothing: needs no email config.
 */
export async function unlockAccount(token: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await withTransaction(db, async (tx) => {
    const consumed = await consumeEmailToken(tx, tokenHash, 'account_unlock');
    if (!consumed) {
      throw new AppError(
        400,
        'INVALID_OR_EXPIRED_TOKEN',
        'This link is invalid or has expired. Request a new unlock link.',
      );
    }
    const user = await selectUserById(tx, consumed.userId);
    if (user) await clearLockout(tx, lockoutKey(user.email));
  });
}
