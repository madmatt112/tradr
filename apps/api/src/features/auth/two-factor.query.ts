import { and, eq, isNotNull } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { loginChallenges, userTwoFactor } from '@/db/schema';

// Design C1/C4 — the two statements login step one runs against the two-factor
// and challenge tables. Statement-level only (structure.md): the service owns
// any transaction boundary.

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
