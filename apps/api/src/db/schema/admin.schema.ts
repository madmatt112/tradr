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
  jsonb,
  primaryKey,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

/**
 * What a `factory_reset` audit entry carries. `deleted` is keyed by table name
 * with the row count removed from each, so the entry answers "what did this
 * destroy?" without the rows it destroyed.
 */
export interface AdminAuditDetail {
  removeSettings: boolean;
  deleted: Record<string, number>;
}

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
//
// TWO ACTIONS NOW, AND THEY DO NOT HAVE THE SAME SHAPE. `admin_toggle` is a
// boolean transition and says everything it needs to in `old_value`/`new_value`.
// `factory_reset` has no before/after boolean — what it has is a list of what it
// destroyed — so those two columns became NULLABLE and `detail` was added to
// carry the per-action payload. A partial CHECK keeps `admin_toggle` honest
// rather than letting the relaxation apply to it as well: an entry for the one
// action that IS a transition must still record both ends of it.
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: text('action').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: varchar('actor_email', { length: 255 }).notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    targetEmail: varchar('target_email', { length: 255 }).notNull(),
    oldValue: boolean('old_value'),
    newValue: boolean('new_value'),
    /**
     * Action-specific payload. NULL for `admin_toggle`, which needs none.
     *
     * For `factory_reset` it is the ONLY record of what the reset destroyed —
     * the row counts per table and whether settings were included — and it is
     * written in the same transaction as the deletes, so an audited reset and a
     * performed reset are the same event. Nothing reconstructs those counts
     * afterwards: the rows are gone.
     */
    detail: jsonb('detail').$type<AdminAuditDetail>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('admin_audit_log_action_chk', sql`${t.action} IN ('admin_toggle', 'factory_reset')`),
    // The transition columns stay mandatory for the action that IS a transition.
    check(
      'admin_audit_log_toggle_values_chk',
      sql`${t.action} <> 'admin_toggle' OR (${t.oldValue} IS NOT NULL AND ${t.newValue} IS NOT NULL)`,
    ),
    index('admin_audit_log_created_idx').on(t.createdAt),
  ],
);
