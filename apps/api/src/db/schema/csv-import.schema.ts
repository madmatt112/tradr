import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.schema';
import { users } from './users.schema';

export const csvImportStaging = pgTable(
  'csv_import_staging',
  {
    // id doubles as the single-use, unguessable import token.
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // staged | committing | committed | superseded | expired
    status: varchar('status', { length: 12 }).notNull().default('staged'),
    result: jsonb('result').notNull(),
    committedResult: jsonb('committed_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
  },
  (table) => [
    // ONE active import per user, across both pre-commit states.
    uniqueIndex('csv_import_staging_one_active_per_user_idx')
      .on(table.userId)
      .where(sql`${table.status} IN ('staged', 'committing')`),
    index('csv_import_staging_user_id_idx').on(table.userId),
    index('csv_import_staging_expires_at_idx').on(table.expiresAt),
  ],
);

// Plan-tiers REQ-10.2: lifetime committed-CSV-import counter. Incremented inside the
// commit transaction only; never decremented and never deleted by application flows
// (non-evasion) — the only removal path is the user-deletion CASCADE.
export const csvImportCounters = pgTable('csv_import_counters', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  committedCount: integer('committed_count')
    .notNull()
    .default(sql`0`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
