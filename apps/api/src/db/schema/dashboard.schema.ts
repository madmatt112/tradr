import { sql } from 'drizzle-orm';
import { jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { WidgetPlacement } from '@tradr/shared';

import { users } from './users.schema';

export const dashboardLayouts = pgTable('dashboard_layouts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  widgets: jsonb('widgets')
    .notNull()
    .$type<WidgetPlacement[]>()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
