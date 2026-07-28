import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';

import { users } from './users.schema';

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    // SHA-256 hex of the raw 32-byte CSPRNG token — the sessions.token_hash posture.
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set by the atomic consume; NULL = live.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('email_tokens_purpose_chk', sql`${t.purpose} IN ('password_reset','email_verification')`),
    // Newest-wins delete + invalidation path.
    index('email_tokens_user_purpose_idx').on(t.userId, t.purpose),
    // ENFORCES at-most-one-live per (user, purpose) (D4/SF-1) — the delete-then-insert
    // alone is race-unsound under READ COMMITTED.
    uniqueIndex('email_tokens_one_live_per_user_purpose')
      .on(t.userId, t.purpose)
      .where(sql`consumed_at IS NULL`),
  ],
);
