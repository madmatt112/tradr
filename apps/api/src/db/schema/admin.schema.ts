import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

// REQ-6.2: append-only per-user advisor-turn counter, keyed by UTC calendar month
// ('YYYY-MM'). Rows are never decremented and never deleted by application flows
// (non-evasion); the only removal path is the user-deletion CASCADE. The composite
// PK is the gate's O(1) read path.
export const advisorTurnCounters = pgTable(
  'advisor_turn_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodKey: varchar('period_key', { length: 7 }).notNull(),
    turnCount: integer('turn_count')
      .notNull()
      .default(sql`0`),
    // Within-allowance platform turns this period (plan-tiers D11). From plan-tiers on,
    // turn_count counts platform-key turns only (REQ-8.3, REQ-8.5).
    allowanceTurns: integer('allowance_turns')
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.periodKey] })],
);

// Plan-tiers REQ-9.1: per-user advisor image counter, keyed by UTC calendar month
// ('YYYY-MM') — mirrors advisor_turn_counters (append-only; composite PK is the
// gate's O(1) read path; only removal is the user-deletion CASCADE).
export const advisorImageCounters = pgTable(
  'advisor_image_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodKey: varchar('period_key', { length: 7 }).notNull(),
    imageCount: integer('image_count')
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.periodKey] })],
);

// REQ-3.5: append-only admin-action audit. Emails are snapshotted so entries stay
// meaningful after user deletion (FKs are ON DELETE SET NULL). No read endpoint/UI
// ships in admin-platform — operator SQL is the read path (design Component 4).
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: text('action').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: varchar('actor_email', { length: 255 }).notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    targetEmail: varchar('target_email', { length: 255 }).notNull(),
    oldValue: boolean('old_value').notNull(),
    newValue: boolean('new_value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('admin_audit_log_action_chk', sql`${t.action} IN ('admin_toggle')`),
    index('admin_audit_log_created_idx').on(t.createdAt),
  ],
);
