import { pgTable, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

import { positions } from './positions.schema';

// One row per screenshot on a position. `part` holds the StoredContentPart
// (inline, pointer or unrecoverable) so REQ-6 can treat this home like the
// advisor's. No user_id column: ownership is read through the positions join
// (D16), and the cascade from positions is the position_tags precedent.
export const positionImages = pgTable(
  'position_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    part: jsonb('part').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('position_images_position_id_created_at_idx').on(t.positionId, t.createdAt)],
);
