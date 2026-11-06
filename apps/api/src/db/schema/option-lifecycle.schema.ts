import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { positions, fills } from './positions.schema';
import { users } from './users.schema';

// Option-lifecycle records (option-lifecycle-events, Data Models; Req 2.9,
// 11.4). Settlements, their touched rows and fills, rolls and entry Greeks.
// Every table hangs off the user (directly or transitively through the
// position), so deleting the user — or account teardown deleting its positions
// — removes these records through the cascades (Req 11.4).

// One settlement of an option leg: the leg went worthless, was assigned, or was
// exercised. Deleting the leg removes the record (position_id CASCADE); deleting
// the user removes it directly (user_id CASCADE).
export const optionSettlements = pgTable(
  'option_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    outcome: varchar('outcome', { length: 9 }).notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 8 }).notNull(),
    premium: numeric('premium', { precision: 18, scale: 8 }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('option_settlements_position_id_idx').on(table.positionId),
    check(
      'option_settlements_outcome_chk',
      sql`${table.outcome} IN ('worthless', 'assigned', 'exercised')`,
    ),
    check('option_settlements_quantity_positive_chk', sql`${table.quantity} > 0`),
  ],
);

// The positions a settlement touched: the leg itself, a stock exit it closed, or
// a stock lot it opened (touch). `position_id` is SET NULL, not CASCADE,
// deliberately: deleting a touched stock row must leave the record standing so
// unsettle refuses (Req 4.7). The prior flat snapshot lets unsettle restore the
// position's latched figures.
export const optionSettlementRows = pgTable(
  'option_settlement_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => optionSettlements.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id').references(() => positions.id, { onDelete: 'set null' }),
    touch: varchar('touch', { length: 12 }).notNull(),
    closedRow: boolean('closed_row').notNull(),
    priorLastFlatAt: timestamp('prior_last_flat_at', { withTimezone: true }),
    priorLastFlatNetPnl: numeric('prior_last_flat_net_pnl', { precision: 18, scale: 4 }),
  },
  (table) => [
    index('option_settlement_rows_settlement_id_idx').on(table.settlementId),
    index('option_settlement_rows_position_id_idx').on(table.positionId),
    check(
      'option_settlement_rows_touch_chk',
      sql`${table.touch} IN ('leg', 'stock_exit', 'stock_opened')`,
    ),
  ],
);

// The fills a settlement wrote or snapshotted. `fill_id` is SET NULL, not
// CASCADE: deleting a recorded fill must leave the record standing so unsettle
// refuses (Req 4.7). `written` marks a fill this settlement created, versus a
// baseline snapshot of a pre-existing fill.
export const optionSettlementFills = pgTable(
  'option_settlement_fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => optionSettlements.id, { onDelete: 'cascade' }),
    fillId: uuid('fill_id').references(() => fills.id, { onDelete: 'set null' }),
    written: boolean('written').notNull(),
  },
  (table) => [
    index('option_settlement_fills_settlement_id_idx').on(table.settlementId),
    index('option_settlement_fills_fill_id_idx').on(table.fillId),
  ],
);

// A roll: one leg exited and another opened in the same move. `chain_id` groups
// a chain of rolls. A leg is the target of at most one roll (unique
// to_position_id). Both legs and both fills cascade; the user cascade removes
// the roll on account teardown (Req 11.4).
export const positionRolls = pgTable(
  'position_rolls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chainId: uuid('chain_id').notNull(),
    fromPositionId: uuid('from_position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    toPositionId: uuid('to_position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    exitFillId: uuid('exit_fill_id')
      .notNull()
      .references(() => fills.id, { onDelete: 'cascade' }),
    entryFillId: uuid('entry_fill_id')
      .notNull()
      .references(() => fills.id, { onDelete: 'cascade' }),
    rolledAt: timestamp('rolled_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('position_rolls_to_position_id_unique').on(table.toPositionId),
    index('position_rolls_chain_id_idx').on(table.chainId),
    index('position_rolls_from_position_id_idx').on(table.fromPositionId),
  ],
);

// The entry Greeks of a position, captured once at open. `position_id` is both
// the primary key and the foreign key, so one row per position and the row
// cascades when the position goes (Req 11.4 — no user_id, cascades via
// position_id). `source` records whether the Greeks came from Black-Scholes or
// the chain.
export const positionEntryGreeks = pgTable(
  'position_entry_greeks',
  {
    positionId: uuid('position_id')
      .primaryKey()
      .references(() => positions.id, { onDelete: 'cascade' }),
    delta: numeric('delta', { precision: 24, scale: 12 }).notNull(),
    gamma: numeric('gamma', { precision: 24, scale: 12 }).notNull(),
    thetaPerDay: numeric('theta_per_day', { precision: 24, scale: 12 }).notNull(),
    vegaPerPct: numeric('vega_per_pct', { precision: 24, scale: 12 }).notNull(),
    rhoPerPct: numeric('rho_per_pct', { precision: 24, scale: 12 }),
    source: varchar('source', { length: 13 }).notNull(),
    volatility: numeric('volatility', { precision: 18, scale: 8 }),
    spot: numeric('spot', { precision: 18, scale: 8 }),
    rate: numeric('rate', { precision: 18, scale: 8 }),
    dividendYield: numeric('dividend_yield', { precision: 18, scale: 8 }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('position_entry_greeks_source_chk', sql`${table.source} IN ('black_scholes', 'chain')`),
  ],
);
