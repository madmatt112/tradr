import crypto from 'node:crypto';

import bcrypt from 'bcrypt';

import { DEFAULT_REPORTING_TIMEZONE, OnboardingStateSchema } from '@tradr/shared';
import type { OnboardingPatch, OnboardingState } from '@tradr/shared';

import { db } from '@/db';
import type { Database, Transaction } from '@/db';
import { isEmailConfigured } from '@/lib/config';
import { ConflictError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { dispatchEmail } from '@/lib/mailer';
import { captureServerEvent, identifyServerUser } from '@/lib/posthog';
import { scrubString } from '@/lib/telemetry-redact';

import {
  insertUser,
  selectUserByEmail,
  insertSession,
  deleteSessionByTokenHash,
  countUserSessions,
  deleteOldestSession,
  selectUserTimezone,
  updateUserTimezone,
  selectUserOnboarding,
  updateUserOnboarding,
} from './auth.query';
import { issueEmailToken, VERIFY_TOKEN_TTL_MS } from './email-tokens.service';
import { AccountLockedError, lockoutKey, LOCKOUT_DURATION_MS } from './lockout';
import { clearLockout, recordLoginFailure, selectActiveLock } from './lockout.query';
import { sendUnlockEmail } from './lockout.service';
import { insertLoginChallenge, selectEnabledTwoFactor } from './two-factor.query';

const BCRYPT_COST = 10;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5;
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWX.YZ';
// The second-step challenge lives five minutes (Req 2.3, design C4 step 4).
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** The persisted user row `selectUserByEmail` returns for a real account. */
type LoggedInUser = NonNullable<Awaited<ReturnType<typeof selectUserByEmail>>>;

/**
 * The outcome of login step one (design C4): either a started session (the
 * password-only path) or a single-use challenge a two-factor user must answer
 * with a second step before any session exists.
 */
export type LoginResult =
  | { kind: 'session'; user: LoggedInUser; token: string }
  | { kind: 'challenge'; challenge: string };

function generateSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function registerUser(email: string, password: string, timezone?: string) {
  const passwordHash = await hashPassword(password);

  let user;
  try {
    // Verified-at-creation on email-less instances (REQ-6.4(a)'s
    // zero-persistence branch, D10): configured ⇒ false (verification email
    // follows below); unconfigured ⇒ true (nothing is ever demanded).
    //
    // The reporting zone is seeded from the client's browser-detected value, or
    // from the defined default when the client sends none — never left NULL to
    // be guessed at later. A NULL column is reserved for rows that predate the
    // column.
    user = await insertUser(db, {
      email,
      passwordHash,
      emailVerified: !isEmailConfigured(),
      timezone: timezone ?? DEFAULT_REPORTING_TIMEZONE,
    });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === '23505') {
      throw new ConflictError('An account with this email already exists');
    }
    throw error;
  }

  const { token, tokenHash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession(db, { userId: user.id, tokenHash, expiresAt });

  // Post-commit verification issuance (REQ-5.2; all writes above are committed
  // — registerUser has no wrapping transaction). The whole block swallows
  // EVERY throw, including IssuanceConflictError (the positions.service.ts
  // post-commit precedent, Error Scenario 12): the account exists, so a 500
  // here would be a lie and a retry hits the duplicate-email 409 trap; the
  // user lands with emailVerified: false and resend cures it. The log carries
  // neither the raw token nor the recipient address (REQ-2.5).
  if (isEmailConfigured()) {
    try {
      const raw = await issueEmailToken(user.id, 'email_verification', VERIFY_TOKEN_TTL_MS);
      dispatchEmail(email, { kind: 'email_verification', rawToken: raw });
    } catch (error: unknown) {
      logger.warn('email_verification_issuance_failed', {
        userId: user.id,
        purpose: 'email_verification',
        // scrubString masks email-shaped substrings — the stdout line has no
        // redaction of its own (the mailer's email_send_failed precedent).
        error: scrubString(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  // Identify the new user and capture sign-up event (fire-and-forget, post-commit).
  identifyServerUser(user.id, { email_verified: user.emailVerified });
  captureServerEvent('user_signed_up', { distinctId: user.id });

  return { user, token };
}

/**
 * Login step one (design C4). Resolves to a `session` for a password-only
 * account or a `challenge` for a two-factor one; a locked address throws
 * `AccountLockedError`, and a wrong email or password throws the same
 * `UnauthorizedError` as before. The lockout counter is keyed to the address
 * hash, so it counts failures for unknown addresses too (Req 3.1, D3).
 */
export async function loginUser(email: string, password: string): Promise<LoginResult> {
  const key = lockoutKey(email);

  // (1) Active lock. Spend one dummy comparison so a locked answer costs the
  // same bcrypt work as the other failure paths, then refuse. `retryAfter` is
  // the full lock duration, not the live remainder, so a locked known address
  // and a locked unknown one answer with an identical Retry-After (Req 3.5).
  const lock = await selectActiveLock(db, key);
  if (lock) {
    await bcrypt.compare('', DUMMY_HASH);
    throw new AccountLockedError(LOCKOUT_DURATION_MS / 1000);
  }

  const user = await selectUserByEmail(db, email);

  if (!user) {
    await bcrypt.compare('', DUMMY_HASH);
    // Count the failure against the address so an unknown address locks the
    // same way a known one does (Req 3.1). No user ⇒ no unlock email.
    await recordLoginFailure(db, key);
    // No account for this email — key the failure to a non-PII 'anonymous'
    // bucket (the email is never a distinctId or a property). reason lets an
    // enumeration probe be told apart from a legitimate typo. Fire-and-forget;
    // no-op when PostHog is unconfigured, so the login path is unchanged.
    captureServerEvent('login_failed', {
      distinctId: 'anonymous',
      properties: { reason: 'unknown_user' },
    });
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const { lockedNow } = await recordLoginFailure(db, key);
    if (lockedNow) {
      // D14 fire-and-forget: the failure the lock-triggering attempt gets back
      // must not wait on SMTP, and sendUnlockEmail is a no-op when email is
      // unconfigured (Req 4.7, 4.10).
      void sendUnlockEmail(user.id, user.email);
    }
    // Wrong password for a real account — key to the user's opaque id so a
    // targeted attempt is visible on their profile (never the email).
    captureServerEvent('login_failed', {
      distinctId: user.id,
      properties: { reason: 'invalid_password' },
    });
    throw new UnauthorizedError('Invalid email or password');
  }

  // (4) Correct password, two-factor on. Issue a single-use challenge and hand
  // back the raw value for the 202; no session and no cleared lock yet — the
  // second step does that (Req 2.2-2.3).
  const twoFactor = await selectEnabledTwoFactor(db, user.id);
  if (twoFactor) {
    const challenge = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(challenge).digest('hex');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await insertLoginChallenge(db, { userId: user.id, tokenHash, expiresAt });
    return { kind: 'challenge', challenge };
  }

  // (5) Correct password, no second factor. Clear the counter and lock, then
  // start the session (Req 3.7).
  await clearLockout(db, key);
  return startSession(user);
}

/**
 * Establish a session for an authenticated user — the tail of the login path
 * (session eviction, token mint, PostHog identify/capture), extracted so the
 * two-factor second step (task 7) reaches the same code. The optional `executor`
 * lets the second step run the session start inside its success transaction
 * (design C4); login step one calls it with the default pool.
 */
export async function startSession(
  user: LoggedInUser,
  executor: Database | Transaction = db,
): Promise<{ kind: 'session'; user: LoggedInUser; token: string }> {
  const sessionCount = await countUserSessions(executor, user.id);
  if (sessionCount >= MAX_SESSIONS) {
    await deleteOldestSession(executor, user.id);
  }

  const { token, tokenHash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession(executor, { userId: user.id, tokenHash, expiresAt });

  // Refresh the person profile on each login and capture the sign-in event
  // (fire-and-forget). email_verified can change between logins (verify flow).
  identifyServerUser(user.id, { email_verified: user.emailVerified });
  captureServerEvent('user_logged_in', { distinctId: user.id });

  return { kind: 'session', user, token };
}

export async function logoutUser(tokenHash: string) {
  await deleteSessionByTokenHash(db, tokenHash);
}

/**
 * The user's REPORTING timezone — the zone P&L is bucketed into by day, week
 * and month. Distinct from `accounts.timezone`, the account's trading-day
 * boundary; neither is derived from the other.
 *
 * Always resolves to a usable zone, never null. `users.timezone` is nullable
 * with no DB default, so NULL means the row predates the column; registration
 * has seeded a value ever since, so the fallback here is the pre-migration path
 * plus the missing-row case of a deleted user racing a request. It is the SAME
 * constant registration falls back to, so the two paths cannot drift apart.
 *
 * `stored` reports WHICH of those two happened, and exists because the resolved
 * zone alone cannot tell a client "never set" from "deliberately UTC" — and the
 * client needs that distinction to seed a pre-migration row once with the zone
 * the user was already bucketing by, without ever overwriting a chosen one. The
 * read itself stays side-effect-free: the server does not backfill.
 */
export async function getReportingTimezone(
  userId: string,
): Promise<{ timezone: string; stored: boolean }> {
  const stored = await selectUserTimezone(db, userId);
  return stored == null
    ? { timezone: DEFAULT_REPORTING_TIMEZONE, stored: false }
    : { timezone: stored, stored: true };
}

/** Persist the reporting timezone. Zone validity is the route's Zod duty. */
export async function setReportingTimezone(userId: string, timezone: string): Promise<void> {
  await updateUserTimezone(db, userId, timezone);
}

/**
 * The user's onboarding PREFERENCE — walkthrough status, the
 * first-calculator-use timestamp and the coach marks already seen. Never
 * checklist item completion: that is derived from the user's real data, so it
 * cannot disagree with reality or need repair.
 *
 * The raw column is `{}` for anyone who has never expressed a preference,
 * including every row that predates it, so the resolution is
 * `OnboardingStateSchema`'s defaulting and nothing else. No `?? 'pending'`
 * fallbacks here — a second copy of the defaults would drift from the schema's.
 * `?? {}` covers only the missing-row case of a deleted user racing a request
 * (the `getReportingTimezone` precedent).
 *
 * Side-effect-free, and must stay so: the SameSite=Lax cookie posture makes any
 * side-effecting GET a CSRF vector.
 */
export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  const stored = await selectUserOnboarding(db, userId);
  return OnboardingStateSchema.parse(stored ?? {});
}

/**
 * Apply a partial onboarding preference and return the resulting state. The
 * merge itself happens in SQL — see `updateUserOnboarding` for why a
 * read-modify-write here would destroy keys written by a newer deployment and
 * lose concurrent appends.
 */
export async function patchOnboardingState(
  userId: string,
  patch: OnboardingPatch,
): Promise<OnboardingState> {
  const updated = await updateUserOnboarding(db, userId, patch);
  return OnboardingStateSchema.parse(updated ?? {});
}
