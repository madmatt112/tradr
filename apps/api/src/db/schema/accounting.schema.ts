import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  date,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.schema';
import { positions } from './positions.schema';
import { users } from './users.schema';

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    positionId: uuid('position_id').references(() => positions.id, { onDelete: 'set null' }),
    entryType: varchar('entry_type', { length: 32 }).notNull(),
    direction: varchar('direction', { length: 6 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    symbol: varchar('symbol', { length: 20 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // groupId is application-generated (NOT a DB default) so the deferred reversal
    // spec (d-536e8750) can insert rows with reversesGroupId pointing at this groupId.
    groupId: uuid('group_id').notNull(),
    reversesGroupId: uuid('reverses_group_id'),
  },
  (table) => [
    index('ledger_user_id_idx').on(table.userId),
    index('ledger_account_id_idx').on(table.accountId),
    // Partial index for per-account ledger LIST (Req 5). The WHERE predicate
    // includes both 'position_pnl' and 'position_pnl_reversal' so the reversal
    // spec (d-536e8750) does not need to rebuild this index when it ships.
    // Widened with 'balance_adjustment' by the reconciliation amendment
    // (Req 8.1, 2026-07-31) — a partial predicate cannot be ALTERed, so
    // migration 0022 rebuilds this index rather than patching it.
    index('ledger_user_account_occurred_pnl_idx')
      .on(table.userId, table.accountId, sql`${table.occurredAt} DESC`)
      .where(
        sql`${table.entryType} IN ('position_pnl', 'position_pnl_reversal', 'balance_adjustment')`,
      ),
    // Partial covering index for accounts-list balance aggregation (Req 3.3).
    // INCLUDE (amount) is hand-added to the migration SQL — see Task 5 +
    // design.md §Data Models. drizzle-orm@0.38.4's pg index() builder has no
    // .include() method.
    index('ledger_user_account_direction_amount_pnl_idx')
      .on(table.userId, table.accountId, table.direction)
      .where(
        sql`${table.entryType} IN ('position_pnl', 'position_pnl_reversal', 'balance_adjustment')`,
      ),
    // Partial index on reverses_group_id (forward-compat for d-536e8750).
    index('ledger_reverses_group_id_idx')
      .on(table.reversesGroupId)
      .where(sql`${table.reversesGroupId} IS NOT NULL`),
    // NOTE: the former `ledger_position_pnl_unique_idx` (one position_pnl row
    // per position) was DROPPED by the ledger-balances reversal amendment
    // (d-536e8750, 2026-07-20). A reopen→re-close legitimately writes multiple
    // position_pnl rows per position, and "net non-reversed" is not expressible
    // as a partial unique predicate. The "≤1 un-reversed position_pnl per
    // position" property is now guaranteed by the position state machine + the
    // reverse-hook co-registration invariant, not this index.
    check('ledger_amount_nonneg_chk', sql`${table.amount} >= 0`),
    check('ledger_direction_chk', sql`${table.direction} IN ('credit', 'debit')`),
    // 'balance_adjustment' (ledger-balances Req 8, 2026-07-31) is the ledger's
    // second writer: a user-initiated cash-balance reconciliation. It carries a
    // NULL positionId and symbol, and is INSERT-only like every other row here.
    check(
      'ledger_entry_type_chk',
      sql`${table.entryType} IN ('position_pnl', 'position_pnl_reversal', 'balance_adjustment')`,
    ),
  ],
);

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    baseCurrency: varchar('base_currency', { length: 3 }).notNull(),
    quoteCurrency: varchar('quote_currency', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 24, scale: 12 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('exchange_rates_user_pair_date_unique').on(
      table.userId,
      table.baseCurrency,
      table.quoteCurrency,
      table.effectiveDate,
    ),
    check(
      'exchange_rates_distinct_currencies_chk',
      sql`${table.baseCurrency} <> ${table.quoteCurrency}`,
    ),
    check('exchange_rates_rate_positive_chk', sql`${table.rate} > 0`),
  ],
);
