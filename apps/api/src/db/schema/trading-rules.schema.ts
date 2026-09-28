import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  boolean,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.schema';
import { tags } from './tags.schema';
import { users } from './users.schema';

// Per-user trading rules (design C2, Data Models). One row per rule; the score a
// position gets is computed on read and never stored (D1). The three cascading
// foreign keys remove a user's rules with the user, and a scoped rule with the
// account or tag it names. `dedup_key` is the canonical fingerprint of type,
// scope and parameters (D4); the unique index makes an exact duplicate a `23505`
// rather than a race. `params` holds the canonical rule parameters as decimal
// strings, with the currency inside for the amount types (D3).
export const tradingRules = pgTable(
  'trading_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    weight: varchar('weight', { length: 12 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').references(() => tags.id, { onDelete: 'cascade' }),
    dedupKey: text('dedup_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trading_rules_user_id_idx').on(t.userId),
    index('trading_rules_account_id_idx').on(t.accountId),
    index('trading_rules_tag_id_idx').on(t.tagId),
    uniqueIndex('trading_rules_user_dedup_unique').on(t.userId, t.dedupKey),
    check(
      'trading_rules_type_chk',
      sql`${t.type} IN ('max_risk_percent','max_risk_amount','max_position_size','min_risk_reward','max_daily_loss','max_weekly_loss','max_total_exposure','required_fields','allowed_markets','allowed_directions','no_trading_days','max_trades_per_day','cooldown_after_loss')`,
    ),
    check('trading_rules_weight_chk', sql`${t.weight} IN ('critical','important','nice_to_have')`),
  ],
);
