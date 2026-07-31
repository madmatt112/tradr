import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  numeric,
  index,
  check,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts.schema';
import { users } from './users.schema';

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    symbol: varchar('symbol', { length: 20 }).notNull(),
    side: varchar('side', { length: 5 }).notNull(),
    assetType: varchar('asset_type', { length: 6 }).notNull(),
    status: varchar('status', { length: 6 }).notNull().default('draft'),
    notes: text('notes'),
    targetPrice: numeric('target_price', { precision: 18, scale: 8 }),
    stopLoss: numeric('stop_loss', { precision: 18, scale: 8 }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    // --- Latched flat-only snapshot (performance bucket A) ---
    // Set every time the position goes flat, and NEVER cleared — not on reopen,
    // not on re-close (it is overwritten with the newer flat value).
    //
    // `closedAt` is nulled on reopen, so without these a reopened position
    // vanishes from the completed-trade statistics until it goes flat again.
    // The rule is that such a metric keeps its LAST FLAT value in the meantime;
    // recomputing from the current fills would give a different number, because
    // the fills have changed since. Hence a frozen snapshot rather than a
    // derivation.
    //
    // This is deliberately NOT a cached aggregate — the no-stored-balance
    // invariant is about values that must track their inputs. This one must
    // NOT track its inputs; being stale is the point.
    lastFlatAt: timestamp('last_flat_at', { withTimezone: true }),
    lastFlatNetPnl: numeric('last_flat_net_pnl', { precision: 18, scale: 4 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('positions_user_id_idx').on(table.userId),
    index('positions_account_id_idx').on(table.accountId),
    index('positions_user_id_status_updated_at_idx').on(
      table.userId,
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    index('positions_user_status_closed_at_idx').on(table.userId, table.status, table.closedAt),
    check(
      'positions_closed_at_when_closed_chk',
      sql`${table.status} <> 'closed' OR ${table.closedAt} IS NOT NULL`,
    ),
  ],
);

export const fills = pgTable(
  'fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 5 }).notNull(),
    price: numeric('price', { precision: 18, scale: 8 }).notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 8 }).notNull(),
    fees: numeric('fees', { precision: 18, scale: 8 }).notNull().default('0'),
    notes: text('notes'),
    filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('fills_position_id_idx').on(table.positionId)],
);
