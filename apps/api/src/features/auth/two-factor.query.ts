import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { loginChallenges, userBackupCodes, userTwoFactor } from '@/db/schema';

// Design C1/C4 — the statements login step one and the second step run against
// the two-factor, challenge and backup-code tables. Statement-level only
// (structure.md): the service owns any transaction boundary.

/** A challenge is live for at most this many code attempts (Req 2.3). */
const MAX_CHALLENGE_ATTEMPTS = 5;

/**
 * The user's ENABLED two-factor row, or null. `enabled_at` NULL marks a pending
 * (unconfirmed) enrolment and does NOT gate login (Req 2.1); only a non-NULL
 * value turns the second step on. Reads `enabled_at` alone — the secret stays
 * untouched until the step-two decrypt.
 */
export async function selectEnabledTwoFactor(
  db: Database | Transaction,
  userId: string,
): Promise<{ userId: string } | null> {
  const rows = await db
    .select({ userId: userTwoFactor.userId })
    .from(userTwoFactor)
    .where(and(eq(userTwoFactor.userId, userId), isNotNull(userTwoFactor.enabledAt)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Store a login challenge as its SHA-256 hash with its expiry (Req 2.2-2.3).
 * The raw value never lands here — the caller returns it once in the 202 body
 * and this row holds only the hash, the sessions/email-token posture.
 */
export async function insertLoginChallenge(
  db: Database | Transaction,
  row: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.insert(loginChallenges).values(row);
}

/**
 * The two-factor secret and last accepted TOTP step the second step needs
 * (design C4 step 3). Keyed by user id alone: the challenge only exists because
 * login step one already found an enabled row, so the decrypt happens on every
 * attempt regardless of `enabled_at`.
 */
export async function selectTwoFactorForLogin(
  db: Database | Transaction,
  userId: string,
): Promise<{ secretEnvelope: string; lastUsedStep: number | null } | null> {
  const rows = await db
    .select({
      secretEnvelope: userTwoFactor.secretEnvelope,
      lastUsedStep: userTwoFactor.lastUsedStep,
    })
    .from(userTwoFactor)
    .where(eq(userTwoFactor.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The live challenge for a token hash, or null (design C4 step 1). Live means
 * unconsumed, unexpired and under 5 attempts; expired, consumed, over-attempted
 * and unknown challenges are indistinguishable — all yield null, the 400
 * `CHALLENGE_EXPIRED` the service returns.
 */
export async function selectLiveLoginChallenge(
  db: Database | Transaction,
  tokenHash: string,
): Promise<{ userId: string } | null> {
  const rows = await db
    .select({ userId: loginChallenges.userId })
    .from(loginChallenges)
    .where(
      and(
        eq(loginChallenges.tokenHash, tokenHash),
        isNull(loginChallenges.consumedAt),
        gt(loginChallenges.expiresAt, sql`now()`),
        lt(loginChallenges.attempts, MAX_CHALLENGE_ATTEMPTS),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Atomic single-use consume of the challenge (design C4 step 6), the
 * `consumeEmailToken` conditional-UPDATE pattern: ONE UPDATE guarded on
 * unconsumed/unexpired/under-attempts, so two racing second factors serialize
 * and exactly one wins the row. Zero rows → null, which rolls the success
 * transaction back to a 400 `CHALLENGE_EXPIRED` with no session (R1-2).
 */
export function consumeLoginChallenge(
  tx: Transaction,
  tokenHash: string,
): Promise<{ userId: string } | null> {
  return tx
    .update(loginChallenges)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(loginChallenges.tokenHash, tokenHash),
        isNull(loginChallenges.consumedAt),
        gt(loginChallenges.expiresAt, sql`now()`),
        lt(loginChallenges.attempts, MAX_CHALLENGE_ATTEMPTS),
      ),
    )
    .returning({ userId: loginChallenges.userId })
    .then((rows) => rows[0] ?? null);
}

/**
 * Count one failed code attempt against the challenge (design C4 step 5). Runs
 * OUTSIDE the success transaction so the bookkeeping commits even when a wrong
 * code rolls that transaction back (tasks D2).
 */
export async function incrementChallengeAttempts(
  db: Database | Transaction,
  tokenHash: string,
): Promise<void> {
  await db
    .update(loginChallenges)
    .set({ attempts: sql`${loginChallenges.attempts} + 1` })
    .where(eq(loginChallenges.tokenHash, tokenHash));
}

/**
 * Advance the last accepted TOTP step to `step`, but only when it is strictly
 * newer than the stored one (design C4 step 4). The conditional UPDATE rejects a
 * replay at the row level: two concurrent submissions of the same code both pass
 * `matchTotp` but only one advances the step, so zero rows means a replay → the
 * code is treated as wrong.
 */
export function advanceLastUsedStep(
  tx: Transaction,
  userId: string,
  step: number,
): Promise<{ userId: string } | null> {
  return tx
    .update(userTwoFactor)
    .set({ lastUsedStep: step })
    .where(
      and(
        eq(userTwoFactor.userId, userId),
        or(isNull(userTwoFactor.lastUsedStep), lt(userTwoFactor.lastUsedStep, step)),
      ),
    )
    .returning({ userId: userTwoFactor.userId })
    .then((rows) => rows[0] ?? null);
}

/**
 * Mark one unused backup code spent (design C4 step 4, Req 2.4). The conditional
 * `used_at IS NULL` guard makes a single-use: a code already spent (or unknown)
 * matches zero rows → null, which the service treats as a wrong code.
 */
export function consumeBackupCode(
  tx: Transaction,
  userId: string,
  codeHash: string,
): Promise<{ id: string } | null> {
  return tx
    .update(userBackupCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        eq(userBackupCodes.codeHash, codeHash),
        isNull(userBackupCodes.usedAt),
      ),
    )
    .returning({ id: userBackupCodes.id })
    .then((rows) => rows[0] ?? null);
}
