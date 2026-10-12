import { createHash } from 'node:crypto';

import { RateLimitError } from '@/lib/errors';

// Design C3 (Lockout), pure half. No Redis and no email: the counter lives in
// PostgreSQL (Req 3.8) and this module holds only the thresholds, the key
// formula and the locked-answer error.

/** An address locks after this many failures inside the window (Req 3.3). */
export const LOCKOUT_THRESHOLD = 10;
/** Failures older than this slide out of the counting window (Req 3.3). */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
/** How long an address stays locked once the threshold is hit (Req 3.3). */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * The lockout row key: a one-way SHA-256 hex of the normalised (trimmed,
 * lowercased) address, so the state stores no plaintext email (Req 3.6, D13).
 * Identical formula to account-deletion's `emailHash`
 * (`apps/api/src/features/account-deletion/account-deletion.service.ts:75-77`);
 * reimplemented here to keep this file free of that feature's import graph.
 */
export function lockoutKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * The locked sign-in answer (Req 3.4, D14). A `RateLimitError` subclass so the
 * existing handler branch (`apps/api/src/middleware/error.middleware.ts:11-19`)
 * returns 429 with `Retry-After` unchanged; `retryAfter` is in seconds.
 */
export class AccountLockedError extends RateLimitError {
  constructor(retryAfter: number) {
    super(retryAfter);
    this.code = 'ACCOUNT_LOCKED';
    this.message = `Too many failed sign-ins. Try again in ${Math.round(retryAfter / 60)} minutes.`;
  }
}
