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
} from 'drizzle-orm/pg-core';

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
    taxJurisdiction: varchar('tax_jurisdiction', { length: 8 }),
    theme: varchar('theme', { length: 8 }).notNull().default('system'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'users_tax_jurisdiction_chk',
      sql`${t.taxJurisdiction} IS NULL OR ${t.taxJurisdiction} IN ('US', 'CA', 'other')`,
    ),
    check('users_theme_chk', sql`${t.theme} IN ('light','dark','system')`),
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
