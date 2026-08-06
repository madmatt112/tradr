import crypto from 'node:crypto';

import bcrypt from 'bcrypt';

import { DEFAULT_REPORTING_TIMEZONE } from '@tradr/shared';

import { db } from '@/db';
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
} from './auth.query';
import { issueEmailToken, VERIFY_TOKEN_TTL_MS } from './email-tokens.service';

const BCRYPT_COST = 10;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5;
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWX.YZ';

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
    // The reporting zone (user-onboarding R2.2/R2.3) is seeded from the
    // client's browser-detected value, or from the defined default when the
    // client sends none — never left NULL to be guessed at later. A NULL
    // column is reserved for rows that predate the column (R2.5).
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
      dispatchEmail('email_verification', email, raw);
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

export async function loginUser(email: string, password: string) {
  const user = await selectUserByEmail(db, email);

  if (!user) {
    await bcrypt.compare('', DUMMY_HASH);
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
    // Wrong password for a real account — key to the user's opaque id so a
    // targeted attempt is visible on their profile (never the email).
    captureServerEvent('login_failed', {
      distinctId: user.id,
      properties: { reason: 'invalid_password' },
    });
    throw new UnauthorizedError('Invalid email or password');
  }

  const sessionCount = await countUserSessions(db, user.id);
  if (sessionCount >= MAX_SESSIONS) {
    await deleteOldestSession(db, user.id);
  }

  const { token, tokenHash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession(db, { userId: user.id, tokenHash, expiresAt });

  // Refresh the person profile on each login and capture the sign-in event
  // (fire-and-forget). email_verified can change between logins (verify flow).
  identifyServerUser(user.id, { email_verified: user.emailVerified });
  captureServerEvent('user_logged_in', { distinctId: user.id });

  return { user, token };
}

export async function logoutUser(tokenHash: string) {
  await deleteSessionByTokenHash(db, tokenHash);
}

/**
 * The user's REPORTING timezone — the zone P&L is bucketed into by day, week
 * and month (user-onboarding R2). Distinct from `accounts.timezone`, the
 * account's trading-day boundary; neither is derived from the other (R2.7).
 *
 * Always resolves to a usable zone, never null. `users.timezone` is nullable
 * with no DB default, so NULL means the row predates the column; registration
 * has seeded a value since (R2.3), so the fallback here is the pre-migration
 * path (R2.5) plus the missing-row case of a deleted user racing a request. It
 * is the SAME constant registration falls back to, so the two paths cannot
 * drift apart.
 *
 * `stored` reports WHICH of those two happened, and exists because the resolved
 * zone alone cannot tell a client "never set" from "deliberately UTC" — and the
 * client needs that distinction to seed a pre-migration row once with the zone
 * the user was already bucketing by, without ever overwriting a chosen one
 * (R2.5). The read itself stays side-effect-free: the server does not backfill.
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
