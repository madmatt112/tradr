import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { brokerages } from './brokerages.schema';
import { users } from './users.schema';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    // IANA zone name. Defines the account's *trading day* — the calendar day
    // openedAt/closedAt are compared in for R13's same-day reopen rule, so an
    // evening US session that crosses UTC midnight is still one trading day.
    // Validated against the IANA set at the validation layer, not in the DB.
    timezone: varchar('timezone', { length: 64 }).notNull().default('America/New_York'),
    brokerageId: uuid('brokerage_id').references(() => brokerages.id, { onDelete: 'restrict' }),
    // User-entered opening balance, NOT a cached aggregate — the derived
    // balance everywhere is starting_balance + SUM over ledger_entries, so the
    // ledger-balances "balance is never stored" invariant still holds for the
    // ledger-derived part. Matches ledger_entries.amount precision.
    startingBalance: numeric('starting_balance', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),
    // Share of the account balance the user is willing to risk per trade, used
    // to seed the position-size calculator's riskPercent input (user-onboarding
    // R1). NULL means "no rule set" and preserves today's calculator behaviour
    // exactly — an empty field the user fills in per calculation (R1.4). It is
    // NOT a default of 0, which would mean "risk nothing on every trade".
    //
    // Unlike starting_balance above, this stays editable after creation: it
    // seeds a form field and rewrites no history.
    defaultRiskPercent: numeric('default_risk_percent', { precision: 5, scale: 2 }),
    // Marks the disposable sample account seeded for users who want to see a
    // populated product before entering their own trades. It is the ONLY value
    // that unlocks the cascade delete path — the one-click teardown that
    // removes an account together with everything booked against it. Every
    // other account keeps the guard that refuses to delete an account holding
    // positions.
    //
    // The check on this column is server-side and authoritative. A request
    // asking for a cascade delete is a request, never an authorisation: read
    // this flag from the stored row before deleting anything, and never trust a
    // query parameter, header or body field claiming an account is a demo.
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('accounts_user_id_idx').on(table.userId),
    uniqueIndex('accounts_user_id_name_unique').on(table.userId, sql`lower(${table.name})`),
    index('accounts_brokerage_id_idx').on(table.brokerageId),
  ],
);
