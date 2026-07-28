// Email-verification service (design Component 6, REQ-5). Two flows:
// - verifyEmail: the gesture-consumed verification POST — ONE transaction,
//   atomic consume → flag flip. Needs no email config (D12: consuming an
//   existing token sends nothing).
// - resendVerification: authenticated-only (D11 — no-enumeration by
//   construction; only the account owner can trigger it), newest-wins reissue
//   + fire-and-forget dispatch.

import crypto from 'node:crypto';

import { db } from '@/db';
import { isEmailConfigured } from '@/lib/config';
import { AppError, UnauthorizedError } from '@/lib/errors';
import { dispatchEmail } from '@/lib/mailer';
import { captureServerEvent, identifyServerUser } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import { markUserVerified, selectUserById } from './auth.query';
import { consumeEmailToken } from './email-tokens.query';
import {
  IssuanceConflictError,
  issueEmailToken,
  VERIFY_TOKEN_TTL_MS,
} from './email-tokens.service';

/**
 * Verify an email address with an emailed token: ONE `withTransaction` —
 * `consumeEmailToken` (the D7 atomic UPDATE; zero rows for expired, consumed,
 * and unknown tokens alike — indistinguishable ⇒ the generic 400
 * `INVALID_OR_EXPIRED_TOKEN`, REQ-5.3, and the transaction rolls back having
 * written nothing) → `markUserVerified` (users.email_verified = true; its own
 * small UPDATE — reusing D8's `updateUserPasswordAndVerify` would rewrite the
 * password hash). Consumption is this POST: the emailed GET link never mutates
 * (D6/REQ-4.8). Fully functional when SMTP is unconfigured (D12).
 */
export async function verifyEmail(token: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await withTransaction(db, async (tx) => {
    const consumed = await consumeEmailToken(tx, tokenHash, 'email_verification');
    if (!consumed) {
      throw new AppError(
        400,
        'INVALID_OR_EXPIRED_TOKEN',
        'This link is invalid or has expired. Request a new verification email.',
      );
    }
    await markUserVerified(tx, consumed.userId);
    // Post-commit: update person profile and capture the verification event.
    identifyServerUser(consumed.userId, { email_verified: true });
    captureServerEvent('email_verified', { distinctId: consumed.userId });
  });
}

/**
 * Resend the verification email for the authenticated account. Handler order
 * is pinned (Component 6): already verified ⇒ 409 `ALREADY_VERIFIED` (an authed
 * self-fact, not an enumeration surface — D11; checked FIRST, so a verified
 * user on an unconfigured instance learns the truer fact); unconfigured ⇒ 409
 * `EMAIL_NOT_CONFIGURED` (D12's pinned resend copy). The two 409s carry
 * distinct codes — the UI keys on code (SF-2). Otherwise: newest-wins issuance
 * + `dispatchEmail` (void — never awaited, REQ-2.7), with a double-23505
 * `IssuanceConflictError` swallowed into the same plain 200 (Component 4's
 * pinned translation — no send issued; clicking resend again cures it).
 */
export async function resendVerification(userId: string): Promise<void> {
  const user = await selectUserById(db, userId);
  // authMiddleware just proved the session's user exists; a vanishing row here
  // means the account was deleted mid-request — treat as unauthenticated.
  if (!user) throw new UnauthorizedError();

  if (user.emailVerified) {
    throw new AppError(409, 'ALREADY_VERIFIED', 'Your email address is already verified.');
  }
  if (!isEmailConfigured()) {
    throw new AppError(
      409,
      'EMAIL_NOT_CONFIGURED',
      'This instance has no email configured. Email verification is unavailable and not required.',
    );
  }

  try {
    const raw = await issueEmailToken(userId, 'email_verification', VERIFY_TOKEN_TTL_MS);
    dispatchEmail('email_verification', user.email, raw);
  } catch (err) {
    if (!(err instanceof IssuanceConflictError)) throw err;
  }
}
