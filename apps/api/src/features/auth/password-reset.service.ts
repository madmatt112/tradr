// Password-reset service (design Component 5, REQ-3). Holds the
// account-conditional half of the design's normative no-enumeration handler
// shape (Architecture §no-enumeration): lookup → silent-on-no-account token
// issuance → fire-and-forget dispatch → IssuanceConflictError swallowed. The
// route returns the identical generic 200 on every branch; nothing here may
// change the response, its timing shape beyond token issuance (the accepted
// REQ-3.2 residual), or the error surface between account-exists and
// account-absent.

import crypto from 'node:crypto';

import { db } from '@/db';
import { AppError } from '@/lib/errors';
import { dispatchEmail } from '@/lib/mailer';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  deleteAllUserSessions,
  selectUserByEmail,
  updateUserPasswordAndVerify,
} from './auth.query';
import { hashPassword } from './auth.service';
import { consumeEmailToken, deleteEmailTokens } from './email-tokens.query';
import { IssuanceConflictError, issueEmailToken, RESET_TOKEN_TTL_MS } from './email-tokens.service';

/**
 * Handle a reset request for a (schema-normalized) email. Resolves without
 * distinguishing outcomes:
 * - no account → nothing happens (no token, no send);
 * - account → newest-wins token issuance + `dispatchEmail` (void — the send
 *   is structurally un-awaitable, REQ-2.7);
 * - double 23505 issuance conflict → `IssuanceConflictError` swallowed (the
 *   Component 4 pinned translation: without it the conflict would escape as a
 *   500 that fires only on the account-exists branch — an oracle). Any other
 *   error rethrows.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await selectUserByEmail(db, email);
  if (!user) return;
  try {
    const raw = await issueEmailToken(user.id, 'password_reset', RESET_TOKEN_TTL_MS);
    dispatchEmail('password_reset', email, raw);
  } catch (err) {
    if (!(err instanceof IssuanceConflictError)) throw err;
  }
}

/**
 * Complete a reset: consume → revoke → rewrite (D8, REQ-4). The bcrypt hash is
 * computed BEFORE the transaction opens — unconditional work that keeps the
 * transaction short (D8). Then ONE `withTransaction` in the structure.md
 * alphabetical lock order (`email_tokens` → `sessions` → `users`; no other
 * flow locks any two of these):
 *
 * 1. `consumeEmailToken` — the D7 atomic UPDATE; zero rows (expired, consumed,
 *    unknown — indistinguishable) ⇒ generic 400 `INVALID_OR_EXPIRED_TOKEN`
 *    (REQ-4.2) and the transaction rolls back having written nothing.
 * 2. `deleteAllUserSessions` — every session revoked (REQ-4.5).
 * 3. `updateUserPasswordAndVerify` — new hash + reset⇒verified (D8).
 * 4. The defensive `deleteEmailTokens` (REQ-4.4's letter): provably redundant
 *    under D4's partial unique index (the consumed token was the only live
 *    row), kept as belt-and-braces; re-touching `email_tokens` late is
 *    deadlock-safe precisely because that index guarantees no second live row
 *    exists to form an AB/BA pair (D8).
 *
 * No auto-login: resolves void, the route returns a bare `{ success: true }`
 * and the page routes to login (D8). Needs no email config — consuming an
 * existing token sends nothing (D12).
 */
export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await withTransaction(db, async (tx) => {
    const consumed = await consumeEmailToken(tx, tokenHash, 'password_reset');
    if (!consumed) {
      throw new AppError(
        400,
        'INVALID_OR_EXPIRED_TOKEN',
        'This link is invalid or has expired. Request a new reset link.',
      );
    }
    await deleteAllUserSessions(tx, consumed.userId);
    await updateUserPasswordAndVerify(tx, consumed.userId, passwordHash);
    await deleteEmailTokens(tx, consumed.userId, 'password_reset');
    captureServerEvent('password_reset_completed', { distinctId: consumed.userId });
  });
}
