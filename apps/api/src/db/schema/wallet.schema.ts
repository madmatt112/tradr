import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  integer,
  boolean,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';

import { advisorConversations, advisorMessages } from './advisor.schema';
import { users } from './users.schema';

// One row per user (lazy). Credit minor units are micro-USD bigints. `balance` MAY go
// negative (refund/dispute after spend — REQ-3.9), so it carries NO non-negative check;
// `reserved` (the outstanding gate hold — REQ-6.3) is CHECK (reserved >= 0).
export const wallets = pgTable(
  'wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: bigint('balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    reserved: bigint('reserved', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('wallets_reserved_nonneg_chk', sql`${t.reserved} >= 0`)],
);

// Per platform turn; immutable as-charged (REQ-5.2). FK target of wallet_transactions, so
// it must be created BEFORE wallet_transactions (F4 migration order).
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => advisorConversations.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => advisorMessages.id, { onDelete: 'set null' }),
    providerId: varchar('provider_id', { length: 16 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    inputTokens: bigint('input_tokens', { mode: 'bigint' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }).notNull(),
    creditCost: bigint('credit_cost', { mode: 'bigint' }).notNull(),
    // Rate-table pre-markup cost AS CHARGED at turn time (admin-platform REQ-4.2
    // option (i)) — persisted, never derived from current config. Itself ceil-rounded
    // per-token to whole micro-USD (slight over-statement for sub-micro-USD models).
    // Nullable: pre-0013 rows are NULL and are excluded from provider-cost sums with
    // explicit coverage counts.
    rawCost: bigint('raw_cost', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_records_user_created_idx').on(t.userId, t.createdAt),
    // Platform-wide time-bounded scans (admin-platform REQ-4.3) — the user_id-leading
    // index above does not serve queries with no user_id predicate.
    index('usage_records_created_idx').on(t.createdAt),
  ],
);

// Append-only audit + history source (REQ-1.2, REQ-7.3). `stripe_payment_intent_id` is the
// F3 refund/dispute reversal join key — indexed. Reservations are NOT logged here.
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    stripeEventId: text('stripe_event_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    usageRecordId: uuid('usage_record_id').references(() => usageRecords.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('wallet_transactions_kind_chk', sql`${t.kind} IN ('credit', 'debit', 'reversal')`),
    index('wallet_transactions_user_created_idx').on(t.userId, t.createdAt),
    index('wallet_transactions_payment_intent_idx').on(t.stripePaymentIntentId),
  ],
);

// Local mirror of Stripe subscriptions — one row per Stripe subscription (plan-tiers
// D1, REQ-1.2). `status` stores the RAW Stripe status with deliberately NO CHECK: an
// unknown future status must map to `free` in the resolver, never fail the webhook.
// `stripe_created_at` is the earliest-created-survives ordering key; `last_event_created`
// is the out-of-order webhook guard; `entered_past_due_at` anchors the REQ-1.4 dunning
// horizon.
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
    status: text('status').notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    // Max over subscription items (D6).
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    // Price snapshot mirrored for display (nullable).
    priceId: text('price_id'),
    priceUnitAmount: integer('price_unit_amount'),
    priceCurrency: text('price_currency'),
    stripeCreatedAt: timestamp('stripe_created_at', { withTimezone: true }).notNull(),
    enteredPastDueAt: timestamp('entered_past_due_at', { withTimezone: true }),
    lastEventCreated: timestamp('last_event_created', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subscriptions_user_id_idx').on(t.userId)],
);

// user <-> Stripe Customer linkage (plan-tiers D2, REQ-2.5). One Customer per user,
// created lazily at first checkout and reused; UNIQUE stripe_customer_id supports
// webhook reverse lookup.
export const billingCustomers = pgTable('billing_customers', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Webhook idempotency + observability (REQ-3.2, REQ-3.8). `stripe_event_id` UNIQUE is the
// idempotency key (REQ-9.1).
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeEventId: text('stripe_event_id').notNull().unique(),
    eventType: text('event_type').notNull(),
    status: text('status').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    check(
      'webhook_events_status_chk',
      sql`${t.status} IN ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
);
