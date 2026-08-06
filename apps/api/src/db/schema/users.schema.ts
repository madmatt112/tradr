import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';

import type { StoredOnboardingState } from '@tradr/shared';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    // Default TRUE = the REQ-6.1 grandfathering (PostgreSQL fast-default backfills all
    // existing rows as verified, D10). Registration always writes the value explicitly.
    emailVerified: boolean('email_verified').notNull().default(true),
    displayCurrency: varchar('display_currency', { length: 3 }),
    // The user's REPORTING timezone (user-onboarding R2): the zone P&L is bucketed
    // into by day, week and month. It is not a display format — nothing renders a
    // timestamp in it. NOT the same thing as accounts.timezone,
    // which is the account's *trading-day boundary* and defaults to America/New_York
    // because that is where NYSE, NASDAQ and NYSE Arca run. This one is seeded from
    // the browser at registration and follows the person, not the market. Neither is
    // derived from the other (R2.7).
    // Nullable with no backfill: NULL marks a pre-migration row and is resolved at
    // read time by resolveTimezone (R2.5). No CHECK constraint enumerating zones —
    // validity is decided by resolveTimezone, and a hardcoded list would reject
    // legitimate Etc/* zones.
    timezone: varchar('timezone', { length: 64 }),
    taxJurisdiction: varchar('tax_jurisdiction', { length: 8 }),
    theme: varchar('theme', { length: 8 }).notNull().default('system'),
    // Which account figure the position-sizing calculator's buying-power cap is
    // computed against (calculator-balance-sizing). Defaults to 'cash' — including
    // for existing rows, via PostgreSQL's fast default — because sizing the cap
    // against total equity tells a user with capital already deployed to open a
    // position they cannot fund. 'balance' restores the pre-existing behaviour for
    // margin traders. Does NOT affect the risk budget, which is always a percent
    // of the balance.
    buyingPowerBasis: varchar('buying_power_basis', { length: 7 }).notNull().default('cash'),
    // FK to advisor_personas.id (ON DELETE SET NULL) enforced in the migration only;
    // a TS .references() here would create a circular import with advisor.schema.ts.
    advisorDefaultPersonaId: text('advisor_default_persona_id'),
    advisorTradeDataConsent: boolean('advisor_trade_data_consent').notNull().default(false),
    // Free-tier writable-account designation (plan-tiers D18, REQ-6.6). FK to
    // accounts.id (ON DELETE SET NULL) enforced in migration 0018 only; a TS
    // .references() here would create a circular import with accounts.schema.ts
    // (the advisor_default_persona_id precedent above).
    writableAccountId: uuid('writable_account_id'),
    changelogViewedAt: timestamp('changelog_viewed_at', { withTimezone: true }),
    // Onboarding PREFERENCE (user-onboarding R4.6): walkthrough status, the
    // first-calculator-use timestamp, and the set of coach marks already seen.
    // PREFERENCE ONLY — checklist item completion is DERIVED from the user's
    // real data (account/position/closed-position counts) and is never stored
    // here (R4.2). calculatorFirstUsedAt is the single named exception, and it
    // is a timestamp recording a fact, not a per-item completion flag: the
    // calculator writes nothing else, so item 2 has no other data trace.
    // One jsonb column rather than three scalars because coachMarksSeen is a
    // growing set that would otherwise need its own table for a UI preference
    // — the dashboard_layouts.widgets precedent.
    // NOT NULL DEFAULT '{}' so PostgreSQL's fast default makes every existing
    // row valid with no backfill; '{}' parses to sensible defaults via
    // OnboardingStateSchema. $type is the STORED shape (all keys optional),
    // because '{}' is not a valid resolved OnboardingState — see onboarding.ts.
    onboarding: jsonb('onboarding')
      .notNull()
      .$type<StoredOnboardingState>()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'users_tax_jurisdiction_chk',
      sql`${t.taxJurisdiction} IS NULL OR ${t.taxJurisdiction} IN ('US', 'CA', 'other')`,
    ),
    check('users_theme_chk', sql`${t.theme} IN ('light','dark','system')`),
    check('users_buying_power_basis_chk', sql`${t.buyingPowerBasis} IN ('cash','balance')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastAccessed: timestamp('last_accessed', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);
