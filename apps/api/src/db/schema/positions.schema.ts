import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
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

// Per-exit lot selections (tax-lots C3, Data Models). Each row pairs an exit
// fill with one entry fill it is matched against and the quantity consumed from
// that lot. Only explicit selections are stored; every lot figure is otherwise
// re-derived from the position's fills and effective method (AC 1.5). Both
// references cascade, so removing a fill — or the position that owns it, or the
// user above that — removes its selection rows with it (AC 3.9, AC 9.5).
export const fillLotSelections = pgTable(
  'fill_lot_selections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exitFillId: uuid('exit_fill_id')
      .notNull()
      .references(() => fills.id, { onDelete: 'cascade' }),
    entryFillId: uuid('entry_fill_id')
      .notNull()
      .references(() => fills.id, { onDelete: 'cascade' }),
    quantity: numeric('quantity', { precision: 18, scale: 8 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('fill_lot_selections_exit_entry_unique').on(table.exitFillId, table.entryFillId),
    index('fill_lot_selections_entry_fill_id_idx').on(table.entryFillId),
    check('fill_lot_selections_quantity_positive_chk', sql`${table.quantity} > 0`),
    check(
      'fill_lot_selections_distinct_fills_chk',
      sql`${table.exitFillId} <> ${table.entryFillId}`,
    ),
  ],
);

// Transfer-in/transfer-out links (ca-acb-pooling C7, Data Models). Each row
// pairs the exit fill that left one account with the entry fill that arrived in
// another, so a transfer realises nothing in the pooled-ACB summary. Only the
// pairing is stored; the quantity rides on the fills themselves. One link per
// exit fill and one per entry fill (the two unique indexes), and the two fills
// must differ (fill_transfer_links_distinct_fills_chk). Every reference
// cascades, so removing a fill — or the position that owns it, or the user
// above that — removes its link with it (AC 6.4, AC 9.5).
export const fillTransferLinks = pgTable(
  'fill_transfer_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    exitFillId: uuid('exit_fill_id')
      .notNull()
      .references(() => fills.id, { onDelete: 'cascade' }),
    entryFillId: uuid('entry_fill_id')
      .notNull()
      .references(() => fills.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('fill_transfer_links_exit_unique').on(table.exitFillId),
    uniqueIndex('fill_transfer_links_entry_unique').on(table.entryFillId),
    check(
      'fill_transfer_links_distinct_fills_chk',
      sql`${table.exitFillId} <> ${table.entryFillId}`,
    ),
  ],
);
