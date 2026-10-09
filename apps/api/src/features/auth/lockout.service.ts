// Lockout service — the unlock-email sender half of design C3. One
// transactional unlock link per lock, issued only when email is configured
// (REQ-4.10). Separate from the pure lockout logic and the queries: this is
// the one place that reaches the token issuer and the mailer.

import { isEmailConfigured } from '@/lib/config';
import { logger } from '@/lib/logger';
import { dispatchEmail } from '@/lib/mailer';

import { issueEmailToken, UNLOCK_TOKEN_TTL_MS } from './email-tokens.service';

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
