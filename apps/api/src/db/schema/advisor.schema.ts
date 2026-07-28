// Drizzle 0.38 has no "extend existing pgTable" idiom; the users.advisor_default_persona_id
// column is declared directly on the users table (see users.schema.ts) as a plain text column
// (its FK to advisor_personas is enforced in the migration only, to avoid a circular import).
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  integer,
  smallint,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

export const advisorPersonas = pgTable(
  'advisor_personas',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    description: varchar('description', { length: 500 }),
    systemPrompt: text('system_prompt').notNull(),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('advisor_personas_one_default_per_user')
      .on(t.userId)
      .where(sql`is_default = true AND user_id IS NOT NULL`),
  ],
);

export const advisorConversations = pgTable(
  'advisor_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull(),
    personaId: text('persona_id').references(() => advisorPersonas.id, { onDelete: 'set null' }),
    providerId: varchar('provider_id', { length: 16 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('advisor_conversations_user_updated_idx').on(t.userId, t.updatedAt.desc())],
);

export const advisorMessages = pgTable(
  'advisor_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => advisorConversations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(), // 'user' | 'assistant' enforced via CHECK
    contentParts: jsonb('content_parts').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    // Both user AND assistant rows carry client_message_id (assistant inherits from its
    // paired user row at commit time). The partial-unique index below remains scoped to
    // role = 'user' so REQ-3.12 idempotency semantics are unchanged.
    clientMessageId: uuid('client_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('advisor_messages_role_chk', sql`${t.role} IN ('user', 'assistant')`),
    index('advisor_messages_conv_created_idx').on(t.conversationId, t.createdAt, t.id),
    // Partial unique index whose WHERE clause matches the ON CONFLICT predicate exactly
    // (v2-5 / v2-11): `role = 'user' AND client_message_id IS NOT NULL`.
    uniqueIndex('advisor_messages_idem')
      .on(t.conversationId, t.clientMessageId)
      .where(sql`role = 'user' AND client_message_id IS NOT NULL`),
    // Pair-lookup index for the Layer-1 dedupe path (v2-3; v3-8 — UNIQUE). Enforces 1:1
    // user-assistant pairing so recovery/admin tools cannot insert a second assistant row
    // for the same client_message_id.
    uniqueIndex('advisor_messages_assistant_pair_uniq')
      .on(t.conversationId, t.clientMessageId)
      .where(sql`role = 'assistant' AND client_message_id IS NOT NULL`),
  ],
);

export const advisorProviderKeys = pgTable(
  'advisor_provider_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: varchar('provider_id', { length: 16 }).notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    keyVersion: smallint('key_version').notNull(),
    defaultModel: varchar('default_model', { length: 64 }).notNull(),
    keyHintTail: varchar('key_hint_tail', { length: 8 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('advisor_provider_keys_user_provider_uniq').on(t.userId, t.providerId)],
);

export const externalApiKeys = pgTable(
  'external_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    keyVersion: smallint('key_version').notNull(),
    keyHintTail: varchar('key_hint_tail', { length: 8 }).notNull(),
    verified: boolean('verified').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('external_api_keys_user_provider_uniq').on(t.userId, t.provider)],
);

export const advisorSummaries = pgTable(
  'advisor_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => advisorConversations.id, { onDelete: 'cascade' }),
    prose: text('prose').notNull(),
    tradeDataFigures: text('trade_data_figures'),
    // Advisory pointer only — intentionally NO FK (the covered message may be
    // pruned/summarized away while the summary row persists).
    coveredThroughMessageId: uuid('covered_through_message_id'),
    coveredThroughCreatedAt: timestamp('covered_through_created_at', {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('advisor_summaries_conversation_uniq').on(t.conversationId)],
);
