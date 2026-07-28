import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  numeric,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

export const brokerages = pgTable(
  'brokerages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    notes: text('notes'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('brokerages_user_id_idx').on(table.userId),
    uniqueIndex('brokerages_user_id_name_unique')
      .on(table.userId, sql`lower(${table.name})`)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex('brokerages_system_name_unique')
      .on(sql`lower(${table.name})`)
      .where(sql`${table.isSystem} = true`),
  ],
);

export const feeSchedules = pgTable('fee_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  brokerageId: uuid('brokerage_id')
    .notNull()
    .unique()
    .references(() => brokerages.id, { onDelete: 'cascade' }),
  stockPerShareCommission: numeric('stock_per_share_commission', { precision: 18, scale: 8 })
    .notNull()
    .default('0'),
  stockMinPerFill: numeric('stock_min_per_fill', { precision: 18, scale: 8 })
    .notNull()
    .default('0'),
  stockMaxPerFill: numeric('stock_max_per_fill', { precision: 18, scale: 8 })
    .notNull()
    .default('0'),
  optionsPerContractCommission: numeric('options_per_contract_commission', {
    precision: 18,
    scale: 8,
  })
    .notNull()
    .default('0'),
  optionsPerContractExchangeFee: numeric('options_per_contract_exchange_fee', {
    precision: 18,
    scale: 8,
  })
    .notNull()
    .default('0'),
  optionsMinPerFill: numeric('options_min_per_fill', { precision: 18, scale: 8 })
    .notNull()
    .default('0'),
  optionsMaxPerFill: numeric('options_max_per_fill', { precision: 18, scale: 8 })
    .notNull()
    .default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const brokeragesRelations = relations(brokerages, ({ one }) => ({
  feeSchedule: one(feeSchedules, {
    fields: [brokerages.id],
    references: [feeSchedules.brokerageId],
  }),
}));

export const feeSchedulesRelations = relations(feeSchedules, ({ one }) => ({
  brokerage: one(brokerages, {
    fields: [feeSchedules.brokerageId],
    references: [brokerages.id],
  }),
}));
