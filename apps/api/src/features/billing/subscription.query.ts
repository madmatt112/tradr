import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { billingCustomers, subscriptions } from '@/db/schema';

// ---------------------------------------------------------------------------
// Stripe subscription mirror — SQL-shaped primitives (plan-tiers design
// D1/D2/D6; REQ-3.2/3.3). The write discipline lives here: the stale-event
// guard, the monotone watermark, the CAS re-fetch write, and the invoice
// anchor updates. Extraction from Stripe payloads is the service's job
// (subscription.service.ts) — NO Stripe API call lives in this module.
//
// Type rules (structure.md Query Pattern): reads accept
// `Database | Transaction`; the guarded writes take `Transaction` — their
// read-then-write / conditional semantics only hold inside `withTransaction`.
// ---------------------------------------------------------------------------

/** One `subscriptions` mirror row, exactly as selected. */
export type SubscriptionRow = typeof subscriptions.$inferSelect;

/** The DB-shaped state of one Stripe subscription (D6's extraction output). */
export interface SubscriptionMirror {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  /** RAW Stripe status — never validated here; unknown statuses derive `free` in the resolver (REQ-1.3). */
  status: string;
  cancelAtPeriodEnd: boolean;
  /** Max over the subscription items' `current_period_end` (D6). */
  currentPeriodEnd: Date;
  priceId: string | null;
  priceUnitAmount: number | null;
  priceCurrency: string | null;
  /** The subscription's own `created` — the earliest-created-survives ordering key (D3). */
  stripeCreatedAt: Date;
}

/**
 * All mirror rows for a user (REQ-1.5 derives from the full set — the
 * double-subscribe race is observable as two rows). Read: `Database | Transaction`.
 */
export async function selectSubscriptionsByUser(
  db: Database | Transaction,
  userId: string,
): Promise<SubscriptionRow[]> {
  return db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Webhook-side lookup
 * of a mirror row by its Stripe subscription id.
 */
export async function selectSubscriptionByStripeId(
  db: Database | Transaction,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row ?? null;
}

/** Row-lock a mirror row by Stripe subscription id for the guarded upsert. */
async function lockSubscriptionByStripeId(
  tx: Transaction,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .for('update');
  return row ?? null;
}

export interface GuardedUpsertResult {
  /**
   * `inserted` — no row existed; `applied` — state written (newer event, or a
   * same-second tie applied in arrival order); `skipped` — strictly-older
   * event, state untouched (the caller records it `ignored`).
   */
  outcome: 'inserted' | 'applied' | 'skipped';
  /** True when `event.created` exactly equals the prior watermark (same-second tie). */
  tie: boolean;
  /**
   * The row's watermark AFTER this call — for a tie or a skip this is the
   * enqueue-observed value the D1 re-fetch effect must compare-and-set on.
   */
  lastEventCreated: Date;
}

/**
 * The guarded mirror upsert (D1's stale-event semantics). Given the extracted
 * state and the triggering event's `created`:
 *
 * - no row ⇒ insert (race-safe via `ON CONFLICT (stripe_subscription_id) DO
 *   NOTHING` + re-lock, the `ensureWallet` idiom);
 * - `event.created < last_event_created` ⇒ SKIP the state write — strictly
 *   older only; `GREATEST(existing, event.created)` = existing, so the
 *   watermark needs no write;
 * - otherwise APPLY (same-second ties apply last-writer-wins in arrival
 *   order), with the watermark written monotone in SQL:
 *   `last_event_created := GREATEST(existing, event.created)`.
 *
 * Anchor maintenance (D6) rides the applied path: entering `past_due`
 * (previous row absent or non-`past_due`) sets `entered_past_due_at` to the
 * event's `created`; a continuing `past_due` keeps the existing anchor; any
 * non-`past_due` status clears it. Identity columns (`user_id`,
 * `stripe_customer_id`, `stripe_created_at`) are written on insert only.
 *
 * Ties and skips both require the caller to enqueue the post-commit
 * authoritative re-fetch effect with the returned `lastEventCreated`.
 */
export async function upsertSubscriptionMirror(
  tx: Transaction,
  mirror: SubscriptionMirror,
  eventCreated: Date,
): Promise<GuardedUpsertResult> {
  let row = await lockSubscriptionByStripeId(tx, mirror.stripeSubscriptionId);

  if (!row) {
    const inserted = await tx
      .insert(subscriptions)
      .values({
        userId: mirror.userId,
        stripeCustomerId: mirror.stripeCustomerId,
        stripeSubscriptionId: mirror.stripeSubscriptionId,
        status: mirror.status,
        cancelAtPeriodEnd: mirror.cancelAtPeriodEnd,
        currentPeriodEnd: mirror.currentPeriodEnd,
        priceId: mirror.priceId,
        priceUnitAmount: mirror.priceUnitAmount,
        priceCurrency: mirror.priceCurrency,
        stripeCreatedAt: mirror.stripeCreatedAt,
        enteredPastDueAt: mirror.status === 'past_due' ? eventCreated : null,
        lastEventCreated: eventCreated,
      })
      .onConflictDoNothing({ target: subscriptions.stripeSubscriptionId })
      .returning({ id: subscriptions.id });
    if (inserted.length > 0) {
      return { outcome: 'inserted', tie: false, lastEventCreated: eventCreated };
    }
    // Lost a concurrent-insert race: the winner's row is committed now — lock
    // it and run the guard path against it. Mirror rows are never deleted.
    row = (await lockSubscriptionByStripeId(tx, mirror.stripeSubscriptionId)) as SubscriptionRow;
  }

  if (eventCreated.getTime() < row.lastEventCreated.getTime()) {
    // Strictly-older event: never resurrects newer state (D1).
    return { outcome: 'skipped', tie: false, lastEventCreated: row.lastEventCreated };
  }

  const tie = eventCreated.getTime() === row.lastEventCreated.getTime();
  await tx
    .update(subscriptions)
    .set({
      status: mirror.status,
      cancelAtPeriodEnd: mirror.cancelAtPeriodEnd,
      currentPeriodEnd: mirror.currentPeriodEnd,
      priceId: mirror.priceId,
      priceUnitAmount: mirror.priceUnitAmount,
      priceCurrency: mirror.priceCurrency,
      enteredPastDueAt:
        mirror.status === 'past_due'
          ? row.status === 'past_due'
            ? row.enteredPastDueAt
            : eventCreated
          : null,
      // Monotone watermark, written as SQL GREATEST per the D1 pin — the write
      // itself can never regress the watermark. (Raw sql params bypass the
      // column's Date mapping, so bind the ISO string and cast.)
      lastEventCreated: sql`GREATEST(${subscriptions.lastEventCreated}, ${eventCreated.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, row.id));

  return { outcome: 'applied', tie, lastEventCreated: eventCreated };
}

/**
 * D1 pin (a) — the post-commit authoritative re-fetch write. Applies the
 * freshly fetched subscription state ONLY IF `last_event_created` still equals
 * the value observed when the effect was enqueued (compare-and-set in the
 * UPDATE's WHERE). If the watermark advanced, a newer event was applied in the
 * fetch-to-commit window — its state supersedes this snapshot (and if that
 * newer event was itself a tie, it enqueued its own re-fetch) — so the heal
 * skips safely (`superseded`).
 *
 * Pin (b): the write flows through the same anchor-maintenance rules as the
 * guarded upsert — entering `past_due` anchors from the TRIGGERING event's
 * `created`, a continuing `past_due` keeps the existing anchor, non-`past_due`
 * clears it — so the healing path can never fabricate a null-anchor
 * `past_due` row. The watermark stays monotone
 * (`GREATEST(existing, triggering event's created)`).
 *
 * Pin (c) — running post-commit in its own small plain transaction — is the
 * caller's duty; this function is a single conditional UPDATE and is
 * idempotent under concurrent re-fetches.
 */
export async function applyRefetchedSubscriptionMirror(
  tx: Transaction,
  mirror: SubscriptionMirror,
  args: { expectedLastEventCreated: Date; triggeringEventCreated: Date },
): Promise<'applied' | 'superseded'> {
  const updated = await tx
    .update(subscriptions)
    .set({
      status: mirror.status,
      cancelAtPeriodEnd: mirror.cancelAtPeriodEnd,
      currentPeriodEnd: mirror.currentPeriodEnd,
      priceId: mirror.priceId,
      priceUnitAmount: mirror.priceUnitAmount,
      priceCurrency: mirror.priceCurrency,
      enteredPastDueAt:
        mirror.status === 'past_due'
          ? sql`CASE WHEN ${subscriptions.status} = 'past_due' THEN ${subscriptions.enteredPastDueAt} ELSE ${args.triggeringEventCreated.toISOString()}::timestamptz END`
          : null,
      lastEventCreated: sql`GREATEST(${subscriptions.lastEventCreated}, ${args.triggeringEventCreated.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscriptions.stripeSubscriptionId, mirror.stripeSubscriptionId),
        eq(subscriptions.lastEventCreated, args.expectedLastEventCreated),
      ),
    )
    .returning({ id: subscriptions.id });
  return updated.length > 0 ? 'applied' : 'superseded';
}

/**
 * `invoice.payment_failed` anchor backstop (D6): on an existing `past_due` row
 * whose anchor is NULL, set `entered_past_due_at` to the event's `created`.
 * Set-if-null, NEVER set-to-null — the `updated(past_due)` transition is the
 * primary anchor-setter; this is the defensive backstop. A conditional
 * single-column write that deliberately SKIPS the stale guard; a row-less
 * invoice event matches nothing and is safely dropped (default-deny covers
 * it). Returns whether a row was anchored.
 */
export async function applyInvoicePaymentFailedAnchor(
  tx: Transaction,
  stripeSubscriptionId: string,
  eventCreated: Date,
): Promise<boolean> {
  const updated = await tx
    .update(subscriptions)
    .set({ enteredPastDueAt: eventCreated, updatedAt: new Date() })
    .where(
      and(
        eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId),
        eq(subscriptions.status, 'past_due'),
        isNull(subscriptions.enteredPastDueAt),
      ),
    )
    .returning({ id: subscriptions.id });
  return updated.length > 0;
}

/**
 * `invoice.paid` anchor maintenance (D6): while the linked row is still
 * `past_due`, RE-ANCHOR (`entered_past_due_at = event.created`) — a paid
 * renewal advances the entitlement anchor, restarting the 28-day horizon
 * (REQ-3.3/3.5) and healing a lost recovery `updated(active)` event; when the
 * row is NOT `past_due`, clear the anchor (normally already null — a no-op).
 * NEVER nulls the anchor on a still-`past_due` row. A conditional
 * single-column write that deliberately SKIPS the stale guard; a row-less
 * event matches nothing. Returns whether a mirror row matched.
 */
export async function applyInvoicePaidAnchor(
  tx: Transaction,
  stripeSubscriptionId: string,
  eventCreated: Date,
): Promise<boolean> {
  const updated = await tx
    .update(subscriptions)
    .set({
      enteredPastDueAt: sql`CASE WHEN ${subscriptions.status} = 'past_due' THEN ${eventCreated.toISOString()}::timestamptz ELSE NULL END`,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .returning({ id: subscriptions.id });
  return updated.length > 0;
}

/** The persisted user ↔ Stripe Customer linkage (D2, REQ-2.5). */
export interface BillingCustomerLink {
  userId: string;
  stripeCustomerId: string;
}

/** The user's persisted Stripe Customer linkage, or null (read). */
export async function selectBillingCustomerByUser(
  db: Database | Transaction,
  userId: string,
): Promise<BillingCustomerLink | null> {
  const [row] = await db
    .select({
      userId: billingCustomers.userId,
      stripeCustomerId: billingCustomers.stripeCustomerId,
    })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Webhook→user
 * correlation (D2): the linkage row for a Stripe customer id, or null. A
 * subscription event whose customer has no linkage row (e.g. created manually
 * in the Dashboard) is acked `ignored` with a structured warn — the service's
 * job; this is just the indexed reverse lookup (`stripe_customer_id` UNIQUE).
 */
export async function selectBillingCustomerByStripeCustomerId(
  db: Database | Transaction,
  stripeCustomerId: string,
): Promise<BillingCustomerLink | null> {
  const [row] = await db
    .select({
      userId: billingCustomers.userId,
      stripeCustomerId: billingCustomers.stripeCustomerId,
    })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row ?? null;
}

/**
 * D2's idempotent linkage: `INSERT … ON CONFLICT (user_id) DO NOTHING` +
 * select. If the insert did not win, a concurrent request linked first — the
 * returned linkage is THEIRS (`created: false`) and the caller's Stripe
 * Customer orphans unlinked in Stripe (explicitly accepted by REQ-2.5).
 */
export async function insertBillingCustomerLink(
  db: Database | Transaction,
  userId: string,
  stripeCustomerId: string,
): Promise<{ link: BillingCustomerLink; created: boolean }> {
  const inserted = await db
    .insert(billingCustomers)
    .values({ userId, stripeCustomerId })
    .onConflictDoNothing({ target: billingCustomers.userId })
    .returning({
      userId: billingCustomers.userId,
      stripeCustomerId: billingCustomers.stripeCustomerId,
    });
  if (inserted.length > 0) return { link: inserted[0], created: true };
  const existing = await selectBillingCustomerByUser(db, userId);
  // The linkage row exists after a lost conflict; rows are removed only by
  // user-deletion CASCADE.
  return { link: existing as BillingCustomerLink, created: false };
}
