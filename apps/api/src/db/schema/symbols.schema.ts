import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  integer,
  timestamp,
  smallint,
  boolean,
  text,
  index,
  check,
} from 'drizzle-orm/pg-core';

// Global reference table of tradeable symbols (SEC-sourced, NYSE/NASDAQ).
// ticker is the natural key + upsert conflict target (REQ-2.5).
export const symbols = pgTable(
  'symbols',
  {
    ticker: varchar('ticker', { length: 16 }).primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    exchange: varchar('exchange', { length: 16 }).notNull(),
    cik: integer('cik'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // varchar_pattern_ops btree serves LIKE 'AAP%' under any default collation.
    // The PK already gives a default-collation unique btree for the upsert target.
    index('symbols_ticker_prefix_idx').using('btree', t.ticker.op('varchar_pattern_ops')),
  ],
);

// Singleton coordination row (id = 1) backing the multi-container atomic-claim
// guard for symbol population/refresh (REQ-2.4(c)).
export const symbolSyncState = pgTable(
  'symbol_sync_state',
  {
    id: smallint('id').primaryKey(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncing: boolean('syncing').notNull().default(false),
    syncingStartedAt: timestamp('syncing_started_at', { withTimezone: true }),
    symbolCount: integer('symbol_count'),
    lastError: text('last_error'),
  },
  (t) => [check('symbol_sync_state_singleton', sql`${t.id} = 1`)],
);
