import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { emailTokens } from '@/db/schema';

export type EmailTokenPurpose = 'password_reset' | 'email_verification';

/**
 * Statement-level functions ONLY (structure.md): these never create their own
 * transactions — the service layer owns the transaction boundary (D13/MF-1).
 */

export function insertEmailToken(
  tx: Transaction,
  row: { userId: string; purpose: EmailTokenPurpose; tokenHash: string; expiresAt: Date },
) {
  return tx.insert(emailTokens).values(row);
}

/**
 * D7 atomic consume — ONE conditional UPDATE; PostgreSQL row-locking makes two
 * racing completions serialize so exactly one gets the row (REQ-4.3). Expired,
 * consumed, and unknown tokens are indistinguishable: all yield zero rows →
 * null (REQ-4.2). The purpose predicate makes cross-purpose confusion
 * structurally impossible (D4).
 */
export function consumeEmailToken(
  tx: Transaction,
  tokenHash: string,
  purpose: EmailTokenPurpose,
): Promise<{ userId: string } | null> {
  return tx
    .update(emailTokens)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.consumedAt),
        gt(emailTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: emailTokens.userId })
    .then((rows) => rows[0] ?? null);
}

/**
 * The ONE delete statement (MN-2): serves newest-wins issuance (passed the tx),
 * D8's defensive in-transaction delete, and CLI-adjacent invalidation.
 */
export function deleteEmailTokens(
  db: Database | Transaction,
  userId: string,
  purpose: EmailTokenPurpose,
) {
  return db
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)));
}
