import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, index, check } from 'drizzle-orm/pg-core';

import { users } from './users.schema';

// Design C2 (Data Models). Tombstone: the proof a user id was deleted, kept AFTER
// the user row is gone, so it has NO foreign key to `users` (Req 4.2). `user_id` is
// UNIQUE — the Req 4.6 backstop against a second tombstone for one deletion. The
// address is stored only as an unsalted SHA-256 hash, never raw. `purge_outcome`
// tracks the object-storage cleanup (Req 5): `pending` until the purge runs, then
// `complete`/`incomplete`, or `not_applicable` when no storage is configured.
export const accountDeletions = pgTable(
  'account_deletions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().unique(),
    emailHash: varchar('email_hash', { length: 64 }).notNull(),
    tier: text('tier').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
    initiator: text('initiator').notNull(),
    purgeOutcome: text('purge_outcome').notNull().default('pending'),
  },
  (t) => [
    check('account_deletions_tier_chk', sql`${t.tier} IN ('free', 'pro')`),
    check('account_deletions_initiator_chk', sql`${t.initiator} IN ('self', 'admin')`),
    check(
      'account_deletions_purge_outcome_chk',
      sql`${t.purgeOutcome} IN ('pending', 'complete', 'incomplete', 'not_applicable')`,
    ),
  ],
);

// Design C2 (Data Models). One row per user while a deletion is scheduled. It
// cascades with the user (D2), so an admin erasure of a scheduled target settles
// R4-2 with no extra step. `state` walks `pending` -> `scheduled` -> `cancelling`/
// `firing` (D4): a new row is `pending` until Stripe confirms. `stripe_subscription_ids`
// are the ids this spec set not to renew, to re-enable on cancel (D6). `claimed_at`
// is the sweep's claim lease (D3). The (state, due_at) index is the sweep's scan path.
export const accountDeletionSchedules = pgTable(
  'account_deletion_schedules',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    stripeSubscriptionIds: text('stripe_subscription_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'account_deletion_schedules_state_chk',
      sql`${t.state} IN ('pending', 'scheduled', 'cancelling', 'firing')`,
    ),
    index('account_deletion_schedules_state_due_idx').on(t.state, t.dueAt),
  ],
);
