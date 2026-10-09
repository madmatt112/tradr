import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  bigint,
  smallint,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

// Design C1 (Data Models). Two-factor, challenge and lockout state. These four
// tables hold credentials and abuse counters only: they are never part of the
// account export (table-inventory EXCLUDED_TABLES) and every credential is stored
// one-way or as an encryption envelope, never in the clear.

// One row per user who has started or completed two-factor enrolment. `enabled_at`
// NULL marks a pending (unconfirmed) enrolment; a non-NULL value means two-factor
// is on. The secret is kept only as the encryption envelope (Req 1.5), never raw.
// `last_used_step` is the last accepted TOTP step, used to reject replays (Req 1.3);
// it is a bigint in `mode: 'number'` so it reads back as the JS number the TOTP
// step math uses (tasks D3). The row cascades with the user (Req 4/12).
export const userTwoFactor = pgTable('user_two_factor', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEnvelope: text('secret_envelope').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// The user's single-use backup codes, stored only as one-way hashes (Req 1.6, D9).
// UNIQUE (user_id, code_hash) stops the same code landing twice for one user; the
// user_id index serves the per-user lookup and delete. Rows cascade with the user.
export const userBackupCodes = pgTable(
  'user_backup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_backup_codes_user_id_idx').on(t.userId),
    uniqueIndex('user_backup_codes_user_id_code_hash_uq').on(t.userId, t.codeHash),
  ],
);

// The short-lived second-step challenge issued after a correct password for a
// two-factor user (Req 2.2-2.3). Single-use (`consumed_at`), 5-minute expiry and
// at most 5 `attempts`. The challenge token is stored only as its SHA-256 hash,
// the sessions/email-token posture. Rows cascade with the user.
export const loginChallenges = pgTable('login_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: smallint('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-address sign-in failure count and lock (Req 3). Keyed by `key_hash`, the
// SHA-256 of the normalised address, so it stores no plaintext email (Req 3.6) and
// has NO foreign key to `users` — it counts failures for unknown addresses too
// (D3). Account deletion removes the matching row by its key (Req 3.10, C16).
export const loginLockouts = pgTable('login_lockouts', {
  keyHash: varchar('key_hash', { length: 64 }).primaryKey(),
  failureCount: integer('failure_count').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});
