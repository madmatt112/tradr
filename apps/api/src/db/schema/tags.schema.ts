import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';

import { positions } from './positions.schema';
import { users } from './users.schema';

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 40 }).notNull(),
    category: varchar('category', { length: 8 }).notNull(),
    color: varchar('color', { length: 16 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tags_user_id_idx').on(t.userId),
    uniqueIndex('tags_user_id_lower_name_unique').on(t.userId, sql`lower(${t.name})`),
    check('tags_category_chk', sql`${t.category} IN ('setup','emotion','mistake','general')`),
  ],
);

export const positionTags = pgTable(
  'position_tags',
  {
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.positionId, t.tagId] }),
    index('position_tags_tag_id_idx').on(t.tagId),
  ],
);
