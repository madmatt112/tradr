import {
  pgTable,
  uuid,
  text,
  smallint,
  varchar,
  timestamp,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.schema';
import { users } from './users.schema';

// One IBKR Flex Web Service connection per Tradr account (design C1). The token
// and query id are stored only as ciphertext; `token_hint_tail` holds the last
// four characters for display. The last-fetch columns record only the time and
// the report's trade-date span — never any report content (Req 7.4). Both FKs
// cascade, so a deleted account or user takes its connections with it (C12).
export const ibkrFlexConnections = pgTable(
  'ibkr_flex_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    encryptedToken: text('encrypted_token').notNull(),
    encryptedQueryId: text('encrypted_query_id').notNull(),
    keyVersion: smallint('key_version').notNull(),
    tokenHintTail: varchar('token_hint_tail', { length: 8 }).notNull(),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastPeriodStart: date('last_period_start'),
    lastPeriodEnd: date('last_period_end'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ibkr_flex_connections_account_id_uniq').on(t.accountId),
    index('ibkr_flex_connections_user_id_idx').on(t.userId),
  ],
);
