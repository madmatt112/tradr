import type Stripe from 'stripe';

import { db, type Transaction } from '@/db';
import { config, isProSubscriptionConfigured } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import { recordWebhookOutcome } from './billing.query';
import { resolveId, type CheckoutSession } from './billing.service';
import { getStripeClient } from './stripe-client';
import {
  applyInvoicePaidAnchor,
  applyInvoicePaymentFailedAnchor,
  applyRefetchedSubscriptionMirror,
  insertBillingCustomerLink,
  selectBillingCustomerByStripeCustomerId,
  selectBillingCustomerByUser,
  selectSubscriptionByStripeId,
  selectSubscriptionsByUser,
  upsertSubscriptionMirror,
  type BillingCustomerLink,
  type SubscriptionMirror,
  type SubscriptionRow,
} from './subscription.query';
import {
  compareSubscriptionOrder,
  resolveTier,
  subscriptionQualifies,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from './tier.query';

// ---------------------------------------------------------------------------
// Subscription commerce service (plan-tiers design Component 4): customer
// linkage (D2), subscription Checkout (D8), Portal session (D15), mirror
// application (D6) with the D1/D5/D17 post-commit effects, and duplicate
// reconciliation (D7). App-side Stripe calls go through the ONE
// `getStripeClient()` seam (`./stripe-client`). Refusals follow the
// `AppError(status, CODE, message)` billing style.
// ---------------------------------------------------------------------------

/** The billing settings tab — Checkout/Portal return here. */
const APP_BASE_PATH = '/settings/billing';

/** The stable graceful-absence refusal (REQ-2.7/10.2). */
function billingNotAvailable(): AppError {
  return new AppError(
    402,
    'BILLING_NOT_AVAILABLE',
    'platform billing is not enabled on this instance',
  );
}

/**
 * Ensure the user has a Stripe Customer linkage (D2, REQ-2.5). The persisted
 * `billing_customers` row is the UNIQUE source of reuse: an existing linkage is
 * returned without any Stripe call. Otherwise create the Stripe Customer, then
 * `INSERT … ON CONFLICT (user_id) DO NOTHING`; if the insert did not win, a
 * concurrent request linked first — reuse the winner's linkage, and ours
 * orphans unlinked in Stripe (explicitly accepted by REQ-2.5). The Customer
 * metadata `userId` is diagnostics only — correlation is the linkage table.
 */
export async function ensureBillingCustomer(userId: string): Promise<BillingCustomerLink> {
  const existing = await selectBillingCustomerByUser(db, userId);
  if (existing) return existing;

  const stripe = getStripeClient();
  if (!stripe) throw billingNotAvailable();

  const customer = await stripe.customers.create({ metadata: { userId } });
  const { link } = await insertBillingCustomerLink(db, userId, customer.id);
  return link;
}

/**
 * Create a Stripe Checkout Session for the Pro subscription (D8, REQ-2.1).
 * Flow: (1) refuse `402 BILLING_NOT_AVAILABLE` unless
 * `isProSubscriptionConfigured()` (D14, REQ-2.7); (2) `resolveTier` — ANY
 * qualifying subscription (including `past_due` and canceled-pending-period-end,
 * which keeps `status: 'active'` until period end) ⇒ `409 SUBSCRIPTION_EXISTS`
 * (REQ-2.4); (3) ensure the Stripe Customer via D2; (4) `mode: 'subscription'`
 * session on the env-selected Price — `subscription_data.metadata.userId` is
 * diagnostics only, correlation is the linkage (D2). No wallet or mirror write
 * happens here — the mirror is the webhook's job (REQ-3.2).
 */
export async function createSubscriptionCheckout(
  userId: string,
  origin: string,
): Promise<CheckoutSession> {
  const priceId = config.STRIPE_PRO_PRICE_ID;
  if (!isProSubscriptionConfigured() || !priceId) throw billingNotAvailable();
  const stripe = getStripeClient();
  if (!stripe) throw billingNotAvailable();

  const { tier } = await resolveTier(db, userId);
  if (tier === 'pro') {
    throw new AppError(409, 'SUBSCRIPTION_EXISTS', 'You already have an active Pro subscription.');
  }

  const link = await ensureBillingCustomer(userId);

  const billingTab = `${origin}${APP_BASE_PATH}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: link.stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // Diagnostics only (D2): webhook→user correlation is the persisted linkage.
    subscription_data: { metadata: { userId } },
    success_url: `${billingTab}?subscription=confirming`,
    cancel_url: billingTab,
  });

  if (!session.url) {
    throw new AppError(502, 'CHECKOUT_FAILED', 'Stripe did not return a checkout URL');
  }
  captureServerEvent('subscription_checkout_created', { distinctId: userId });
  return { url: session.url };
}

/**
 * Create a Stripe Billing Portal session (D15, REQ-4.1/4.2). No linkage row ⇒
 * `404 NO_BILLING_CUSTOMER`; Stripe unconfigured ⇒ `402 BILLING_NOT_AVAILABLE`.
 * Portal capabilities come from the account's operator-set DEFAULT portal
 * configuration (Stripe Dashboard) — deliberately no
 * `billingPortal.configurations` API code in v1.
 */
export async function createPortalSession(
  userId: string,
  origin: string,
): Promise<CheckoutSession> {
  const link = await selectBillingCustomerByUser(db, userId);
  if (!link) {
    throw new AppError(404, 'NO_BILLING_CUSTOMER', 'No billing customer exists for this account.');
  }

  const stripe = getStripeClient();
  if (!stripe) throw billingNotAvailable();

  const session = await stripe.billingPortal.sessions.create({
    customer: link.stripeCustomerId,
    return_url: `${origin}${APP_BASE_PATH}`,
  });
  return { url: session.url };
}

// ---------------------------------------------------------------------------
// Mirror application — the tier state machine's write path (D6), the D1
// re-fetch + D17 analytics + D7 reconciliation trigger as POST-COMMIT effects
// collected inside the claim transaction and executed by the webhook handler
// strictly after commit (D5).
// ---------------------------------------------------------------------------

/**
 * One post-commit side effect. Collected during the claim transaction,
 * executed by the webhook handler AFTER `withTransaction` returns and before
 * the route acks (D5). The executor guards each effect individually
 * (try/catch + structured log) — a throwing effect never converts a committed
 * event into a redelivery loop.
 */
export interface PostCommitEffect {
  /** Effect identity for the executor's structured guard log. */
  kind: 'analytics' | 'refetch' | 'reconcile';
  run(): Promise<void>;
}

/**
 * D6's extraction output — `SubscriptionMirror` minus the linkage-resolved
 * `userId` (webhook→user correlation is the persisted linkage, D2). The
 * customer id is `resolveId`-resolved and stays nullable until the linkage
 * lookup confirms it.
 */
export interface ExtractedSubscriptionMirror extends Omit<
  SubscriptionMirror,
  'userId' | 'stripeCustomerId'
> {
  stripeCustomerId: string | null;
}

/**
 * Extract the DB-shaped mirror state from a Stripe subscription (D6, pinned
 * against stripe@19.3.1 / API `2025-10-29.clover`):
 *
 * - `status` raw — never validated; unknown statuses derive `free` (REQ-1.3);
 * - `current_period_end` = MAX over `sub.items.data[].current_period_end` (on
 *   this API version the field lives on ITEMS — `SubscriptionItems.d.ts:53`;
 *   the Pro subscription has exactly one item, max is defensive). An item-less
 *   subscription yields epoch 0 — it fails CLOSED in the resolver;
 * - price snapshot from `items.data[0].price` (`id`, `unit_amount`,
 *   `currency`) so the plan card renders without a Stripe call (REQ-11.1);
 * - `stripe_created_at` from `sub.created` — D3's ordering key;
 * - customer id via the shared `resolveId` helper.
 */
export function extractSubscriptionMirror(sub: Stripe.Subscription): ExtractedSubscriptionMirror {
  const items = sub.items?.data ?? [];
  const periodEndSeconds = items.reduce((max, item) => Math.max(max, item.current_period_end), 0);
  const price = items[0]?.price;
  return {
    stripeCustomerId: resolveId(sub.customer),
    stripeSubscriptionId: sub.id,
    status: sub.status,
    // Flexible billing mode (Stripe's default for new subscriptions) records a
    // Portal "cancel at period end" as `cancel_at` = period end with the boolean
    // left false, so either signal counts as a scheduled cancellation.
    cancelAtPeriodEnd: sub.cancel_at_period_end || sub.cancel_at != null,
    currentPeriodEnd: new Date(periodEndSeconds * 1000),
    priceId: price?.id ?? null,
    priceUnitAmount: price?.unit_amount ?? null,
    priceCurrency: price?.currency ?? null,
    stripeCreatedAt: new Date(sub.created * 1000),
  };
}

/** Record the claimed event `ignored` and return no effects. */
async function recordIgnored(tx: Transaction, event: Stripe.Event): Promise<PostCommitEffect[]> {
  await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'ignored' });
  return [];
}

/**
 * Apply one subscription-family webhook event to the local mirror (D5's
 * dispatch target; runs INSIDE the claim transaction). Records the event's
 * webhook outcome itself (`processed`, or `ignored` for stale/unlinked/
 * row-less events — the `reverseForEvent` precedent) and returns the
 * post-commit effects for the handler to execute after commit: the D1
 * authoritative re-fetch (on a same-second tie or a skipped-as-stale upsert),
 * the D17 transition analytics, and the D7 reconciliation trigger — fired on
 * applied, tie-applied, AND skipped-as-stale events alike (idempotent;
 * under-triggering is the only hazard).
 */
export async function applySubscriptionEvent(
  tx: Transaction,
  event: Stripe.Event,
): Promise<PostCommitEffect[]> {
  const eventCreated = new Date(event.created * 1000);
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return applySubscriptionLifecycle(tx, event, eventCreated);
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return applyInvoiceEvent(tx, event, eventCreated);
    default:
      // Defensive: the dispatcher routes only the five subscription-family
      // types here; anything else acks `ignored` (default-deny).
      return recordIgnored(tx, event);
  }
}

/** `customer.subscription.created|updated|deleted` → guarded mirror upsert (D1/D6). */
async function applySubscriptionLifecycle(
  tx: Transaction,
  event: Stripe.Event,
  eventCreated: Date,
): Promise<PostCommitEffect[]> {
  const sub = event.data.object as Stripe.Subscription;
  const extracted = extractSubscriptionMirror(sub);

  // Webhook→user correlation is the persisted linkage (D2) — the Checkout
  // metadata userId is diagnostics only. No linkage row (e.g. a subscription
  // created manually in the Dashboard) ⇒ acked `ignored` + structured warn.
  const link = extracted.stripeCustomerId
    ? await selectBillingCustomerByStripeCustomerId(tx, extracted.stripeCustomerId)
    : null;
  if (!link) {
    logger.warn('subscription event for a Stripe customer with no linkage row — ignored', {
      stripeEventId: event.id,
      eventType: event.type,
      stripeCustomerId: extracted.stripeCustomerId,
      stripeSubscriptionId: extracted.stripeSubscriptionId,
    });
    return recordIgnored(tx, event);
  }

  const mirror: SubscriptionMirror = {
    ...extracted,
    stripeCustomerId: link.stripeCustomerId,
    userId: link.userId,
  };

  // Pre-upsert snapshot for D17 transition detection (analytics only — a
  // concurrent claim could interleave, but the upsert itself stays guarded).
  const previous = await selectSubscriptionByStripeId(tx, mirror.stripeSubscriptionId);
  const result = await upsertSubscriptionMirror(tx, mirror, eventCreated);

  const effects: PostCommitEffect[] = [];
  if (result.outcome !== 'skipped') {
    effects.push(...transitionEffects(previous, mirror));
  }
  if (result.outcome === 'skipped' || result.tie) {
    // D1: BOTH the same-second tie and the skipped-as-stale case enqueue the
    // post-commit authoritative re-fetch, compare-and-set on the watermark
    // observed here.
    effects.push(
      refetchEffect({
        userId: mirror.userId,
        stripeCustomerId: mirror.stripeCustomerId,
        stripeSubscriptionId: mirror.stripeSubscriptionId,
        expectedLastEventCreated: result.lastEventCreated,
        triggeringEventCreated: eventCreated,
      }),
    );
  }
  // D5/D7: reconciliation triggers on EVERY subscription-family event for the
  // user — applied, tie-applied, and skipped-as-stale alike.
  effects.push(reconcileEffect(mirror.userId));

  await recordWebhookOutcome(tx, {
    stripeEventId: event.id,
    status: result.outcome === 'skipped' ? 'ignored' : 'processed',
  });
  return effects;
}

/**
 * `invoice.paid` / `invoice.payment_failed` → conditional anchor writes (D6;
 * they deliberately SKIP the D1 stale guard). Clover invoices carry no
 * top-level `subscription`/`payment_intent` — the linkage is
 * `invoice.parent?.subscription_details?.subscription` (`Invoices.d.ts:1030`,
 * leaf at `:1056`). A non-subscription invoice or a row-less subscription id
 * matches nothing and drops safely (default-deny covers it).
 */
async function applyInvoiceEvent(
  tx: Transaction,
  event: Stripe.Event,
  eventCreated: Date,
): Promise<PostCommitEffect[]> {
  const invoice = event.data.object as Stripe.Invoice;
  const stripeSubscriptionId = resolveId(invoice.parent?.subscription_details?.subscription);
  if (!stripeSubscriptionId) return recordIgnored(tx, event);

  const row = await selectSubscriptionByStripeId(tx, stripeSubscriptionId);
  if (!row) return recordIgnored(tx, event);

  if (event.type === 'invoice.paid') {
    // Still `past_due` ⇒ RE-ANCHOR to the event's `created` (a paid renewal
    // advances the entitlement anchor, restarting the horizon and healing a
    // lost recovery `updated(active)`); not `past_due` ⇒ clear. Never nulls a
    // still-`past_due` anchor — D6's recovery-race closure.
    await applyInvoicePaidAnchor(tx, stripeSubscriptionId, eventCreated);
  } else {
    // Set-if-null, NEVER set-to-null — `updated(past_due)` is the primary
    // anchor-setter; this is the defensive backstop (D6).
    await applyInvoicePaymentFailedAnchor(tx, stripeSubscriptionId, eventCreated);
  }

  await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'processed' });
  return [reconcileEffect(row.userId)];
}

/**
 * D17 transition detection over the pre-upsert snapshot vs the applied mirror
 * state. Emitted only on applied (never skipped-as-stale) upserts:
 * `subscription_activated` on transition into qualifying `active`,
 * `subscription_cancel_scheduled` on `cancel_at_period_end` false→true,
 * `subscription_ended` on qualifying→terminal, `subscription_payment_failed`
 * on entering `past_due`.
 */
function transitionEffects(
  previous: SubscriptionRow | null,
  mirror: SubscriptionMirror,
): PostCommitEffect[] {
  const now = new Date();
  const effects: PostCommitEffect[] = [];
  const prevQualifies = previous !== null && subscriptionQualifies(previous, now);

  // `subscriptionQualifies` reads only status/currentPeriodEnd/enteredPastDueAt —
  // shape the not-yet-selected mirror state for the ONE predicate home (D3).
  const newActiveQualifies =
    mirror.status === 'active' &&
    subscriptionQualifies(
      {
        status: mirror.status,
        currentPeriodEnd: mirror.currentPeriodEnd,
        enteredPastDueAt: null,
      } as SubscriptionRow,
      now,
    );

  if (newActiveQualifies && !(prevQualifies && previous?.status === 'active')) {
    effects.push(analyticsEffect('subscription_activated', mirror));
  }
  if (mirror.cancelAtPeriodEnd && !(previous?.cancelAtPeriodEnd ?? false)) {
    effects.push(analyticsEffect('subscription_cancel_scheduled', mirror));
  }
  // D16's terminal set (tier.query.ts) — a mirror row in these statuses is a dead end.
  if (prevQualifies && TERMINAL_SUBSCRIPTION_STATUSES.has(mirror.status)) {
    effects.push(analyticsEffect('subscription_ended', mirror));
  }
  if (mirror.status === 'past_due' && previous?.status !== 'past_due') {
    effects.push(analyticsEffect('subscription_payment_failed', mirror));
  }
  return effects;
}

/** A post-commit `captureServerEvent` — plan identifiers only, no PII (REQ-13.3). */
function analyticsEffect(eventName: string, mirror: SubscriptionMirror): PostCommitEffect {
  return {
    kind: 'analytics',
    run: async () => {
      captureServerEvent(eventName, {
        distinctId: mirror.userId,
        properties: { stripeSubscriptionId: mirror.stripeSubscriptionId },
      });
    },
  };
}

interface RefetchArgs {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  /** The watermark observed when the effect was enqueued — the CAS expectation. */
  expectedLastEventCreated: Date;
  /** The triggering event's `created` — the anchor/watermark input (D1 pin b). */
  triggeringEventCreated: Date;
}

/**
 * The D1 post-commit authoritative re-fetch: `stripe.subscriptions.retrieve`
 * → CAS upsert through the SAME extraction + anchor path (pin b), in its own
 * small plain transaction (pin c), applied only while the watermark still
 * equals the enqueue-observed value (pin a — a superseding newer event makes
 * the heal skip safely). Stripe unconfigured ⇒ warn + skip.
 */
function refetchEffect(args: RefetchArgs): PostCommitEffect {
  return {
    kind: 'refetch',
    run: async () => {
      const stripe = getStripeClient();
      if (!stripe) {
        logger.warn('subscription re-fetch skipped — Stripe not configured', {
          stripeSubscriptionId: args.stripeSubscriptionId,
        });
        return;
      }
      const sub = await stripe.subscriptions.retrieve(args.stripeSubscriptionId);
      const extracted = extractSubscriptionMirror(sub);
      const mirror: SubscriptionMirror = {
        ...extracted,
        // Identity columns are never written by the CAS update — the
        // enqueue-time linkage values satisfy the shape.
        stripeCustomerId: args.stripeCustomerId,
        userId: args.userId,
      };
      const outcome = await withTransaction(db, (tx: Transaction) =>
        applyRefetchedSubscriptionMirror(tx, mirror, {
          expectedLastEventCreated: args.expectedLastEventCreated,
          triggeringEventCreated: args.triggeringEventCreated,
        }),
      );
      if (outcome === 'superseded') {
        logger.info('subscription re-fetch superseded by a newer event — skipped', {
          stripeSubscriptionId: args.stripeSubscriptionId,
        });
      }
    },
  };
}

/** The D7 reconciliation trigger as a post-commit effect. */
function reconcileEffect(userId: string): PostCommitEffect {
  return { kind: 'reconcile', run: () => reconcileDuplicateSubscriptions(userId) };
}

/** Duck-typed Stripe error code (`StripeError.code`) — no instanceof, mock-friendly. */
function stripeErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/** `subscriptions.cancel` on an already-canceled (or vanished) subscription is DONE (D7). */
function isAlreadyCanceledError(err: unknown): boolean {
  if (stripeErrorCode(err) === 'resource_missing') return true;
  return err instanceof Error && /canceled/i.test(err.message);
}

/**
 * Duplicate-subscription reconciliation (D7, REQ-3.7). Runs POST-COMMIT (never
 * inside a claim transaction), triggered after every subscription-family event
 * for the user. Re-reads the mirror; when more than one row currently
 * qualifies (per the D3 predicate), the earliest-created row survives (D3's
 * total order — deterministic even for same-second creations) and each
 * duplicate is REFUNDED FIRST, then canceled:
 *
 * 1. `stripe.invoices.list({ subscription, status: 'paid', expand:
 *    ['data.payments'] })` — clover invoices carry no top-level
 *    `payment_intent`; PaymentIntent ids come from
 *    `payments.data[].payment.payment_intent` where `payment.type ===
 *    'payment_intent'` (`Invoices.d.ts:338`; `InvoicePayments.d.ts:81,95`). A
 *    no-PI invoice ($0 / out-of-band-settled) is skipped.
 * 2. `stripe.refunds.create({ payment_intent })` with NO refunded-state
 *    pre-check — `charge_already_refunded` is SUCCESS (that IS the idempotency
 *    mechanism). Any other refund error aborts this duplicate BEFORE its
 *    cancel step (it stays double-qualifying, so the next lifecycle webhook
 *    re-attempts and no refund is silently dropped); the loop continues with
 *    the remaining duplicates.
 * 3. `stripe.subscriptions.cancel(id)`, treating already-canceled as done.
 *
 * Every duplicate emits the structured operator log (the flagged-reversal
 * precedent). Stripe unconfigured at reconcile time ⇒ log + skip.
 * Subscription-charge refunds/disputes deliberately stay OUT of the wallet
 * reversal path — `reverseForEvent` acks them `ignored` (REQ-3.8).
 */
export async function reconcileDuplicateSubscriptions(userId: string): Promise<void> {
  const stripe = getStripeClient();
  if (!stripe) {
    logger.warn('subscription duplicate reconciliation skipped — Stripe not configured', {
      userId,
    });
    return;
  }

  const rows = await selectSubscriptionsByUser(db, userId);
  const now = new Date();
  const qualifying = rows
    .filter((row) => subscriptionQualifies(row, now))
    .sort(compareSubscriptionOrder);
  if (qualifying.length <= 1) return;

  const [survivor, ...duplicates] = qualifying;
  for (const duplicate of duplicates) {
    let refundedInvoices = 0;

    // (1) REFUND FIRST — a failed refund must leave the mirror double-
    // qualifying so the retry path stays alive; cancel-first would exit that
    // state with the refund still owed.
    try {
      const invoices = await stripe.invoices.list({
        subscription: duplicate.stripeSubscriptionId,
        status: 'paid',
        expand: ['data.payments'],
      });
      for (const invoice of invoices.data) {
        const paymentIntentIds = (invoice.payments?.data ?? [])
          .filter((entry) => entry.payment.type === 'payment_intent')
          .map((entry) => resolveId(entry.payment.payment_intent))
          .filter((id): id is string => id !== null);
        if (paymentIntentIds.length === 0) continue; // $0 / out-of-band invoice
        for (const paymentIntentId of paymentIntentIds) {
          try {
            await stripe.refunds.create({ payment_intent: paymentIntentId });
          } catch (err) {
            if (stripeErrorCode(err) !== 'charge_already_refunded') throw err;
            // Already refunded ⇒ success — the idempotent re-run mechanism.
          }
        }
        refundedInvoices += 1;
      }
    } catch (err) {
      logger.error('subscription duplicate refund failed — cancel skipped, will re-attempt', {
        userId,
        survivorId: survivor.stripeSubscriptionId,
        duplicateId: duplicate.stripeSubscriptionId,
        refundedInvoices,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // (2) Cancel, treating already-canceled as done.
    let canceled = false;
    try {
      await stripe.subscriptions.cancel(duplicate.stripeSubscriptionId);
      canceled = true;
    } catch (err) {
      if (isAlreadyCanceledError(err)) {
        canceled = true;
      } else {
        logger.error('subscription duplicate cancel failed — will re-attempt', {
          userId,
          survivorId: survivor.stripeSubscriptionId,
          duplicateId: duplicate.stripeSubscriptionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The REQ-3.7 operator channel.
    logger.warn('subscription duplicate reconciled', {
      userId,
      survivorId: survivor.stripeSubscriptionId,
      duplicateId: duplicate.stripeSubscriptionId,
      refundedInvoices,
      canceled,
    });
  }
}
