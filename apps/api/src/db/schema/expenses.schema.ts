import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  date,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';

import { CURRENCY_CODES } from '@tradr/shared/constants/currencies';
import { EXPENSE_CATEGORIES } from '@tradr/shared/constants/expense-categories';

import { users } from './users.schema';

// CHECK lists are generated from the runtime tuples so the unit test in
// `packages/shared` that asserts parity (Req 2.1) is meaningful — a drift
// would surface at schema-generation time, not at insert time.
const categoryCheck = EXPENSE_CATEGORIES.map((c) => `'${c}'`).join(', ');
const currencyCheck = CURRENCY_CODES.map((c) => `'${c}'`).join(', ');

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: varchar('category', { length: 32 }).notNull(),
    description: varchar('description', { length: 200 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    occurredAt: date('occurred_at').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('expenses_user_id_idx').on(t.userId),
    // Serves the LIST endpoint (`occurredAt DESC` order) and the year-bucketed
    // tax-summary aggregation (`WHERE occurredAt BETWEEN ? AND ?`). No year-
    // bucketed index in v1 — at ≤ 500 expenses/user/year the range scan is fast.
    index('expenses_user_occurred_idx').on(t.userId, sql`${t.occurredAt} DESC`),
    check('expenses_amount_positive_chk', sql`${t.amount} > 0`),
    check('expenses_category_chk', sql.raw(`category IN (${categoryCheck})`)),
    check('expenses_currency_chk', sql.raw(`currency IN (${currencyCheck})`)),
  ],
);
