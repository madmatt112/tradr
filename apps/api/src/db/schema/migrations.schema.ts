import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const postMigrationsJournal = pgTable('_post_migrations_journal', {
  filename: text('filename').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
