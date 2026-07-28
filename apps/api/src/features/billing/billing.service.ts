import { sql } from 'drizzle-orm';
import Stripe from 'stripe';

import type { ProviderId, WalletBalance, WalletHistoryItem } from '@tradr/shared';

import { db, type Transaction } from '@/db';
import { config, isStripeConfigured } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  applyBalanceDelta,
  claimWebhookEvent,
  creditWalletForEvent,
  decodeWalletCursor,
  ensureWallet,
  findCreditByPaymentIntent,
  findReversalByEventId,
  getBalanceForUser,
  listWalletHistory,
  recordWebhookOutcome,
  sumReversalsByPaymentIntent,
  type WalletRow,
} from './billing.query';
import { CREDIT_PACKS } from './credit-packs';
import { isModelPriced } from './pricing';
import { getStripeClient } from './stripe-client';
import { selectSubscriptionByStripeId } from './subscription.query';
import { applySubscriptionEvent, type PostCommitEffect } from './subscription.service';

// ---------------------------------------------------------------------------
// Billing service (design Components 2 & 6). User-scoped wallet reads, the
// Stripe Checkout purchase, and the pre-flight gate + balance reservation.
//
// Credits/amounts are bigint micro-USD. `ConflictError` is unusable (hardcodes
// code:'CONFLICT'), so refusals throw `new AppError(status, CODE, message)`.
// ---------------------------------------------------------------------------

const APP_BASE_PATH = '/settings/billing';

/** Default history page size; cursor pagination over `billing.query.ts`. */
const USAGE_PAGE_SIZE = 50;

// --- Reads (Component 2 surface — thin user-scoped reads over Task 7) --------

/**
 * Read the user's wallet balance (REQ-1). A user with no wallet row reads as
 * zero (the query layer never errors on a missing row). Returned as the shared
 * `WalletBalance` wire shape (bigint micro-USD as decimal strings).
 */
export async function getBalance(userId: string): Promise<WalletBalance> {
  const { balance, available } = await getBalanceForUser(db, userId);
  return { balance: balance.toString(), available: available.toString() };
}

export interface UsagePage {
  items: WalletHistoryItem[];
  nextCursor: string | null;
}

/**
 * Paginated wallet/usage history for the billing settings tab (REQ-7). `cursor`
 * is the opaque base64 cursor from a previous page (or null/invalid ⇒ first
 * page). Bigint amounts are serialized to decimal strings for the wire.
 */
export async function listUsage(userId: string, cursor: string | null): Promise<UsagePage> {
  const decoded = cursor ? decodeWalletCursor(cursor) : null;
  const { items, nextCursor } = await listWalletHistory(db, userId, {
    cursor: decoded,
    limit: USAGE_PAGE_SIZE,
  });
  return {
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      amount: item.amount.toString(),
      balanceAfter: item.balanceAfter.toString(),
      createdAt: item.createdAt,
      usage: item.usage
        ? {
            providerId: item.usage.providerId as ProviderId,
            model: item.usage.model,
            inputTokens: item.usage.inputTokens.toString(),
            outputTokens: item.usage.outputTokens.toString(),
            creditCost: item.usage.creditCost.toString(),
            createdAt: item.createdAt,
          }
        : null,
    })),
    nextCursor,
  };
}

// --- Checkout (Component 2) -------------------------------------------------
// `getStripeClient()` lives in `./stripe-client` (plan-tiers Component 4 hoist).

export interface CheckoutSession {
  url: string;
}

/**
 * Create a Stripe Checkout Session for an offered credit pack (REQ-2). Validates
 * `packId` against the server-authoritative `CREDIT_PACKS` — the price and grant
 * come only from config, never client input (REQ-2.2). Captures the
 * creation-time price as a metadata snapshot (REQ-2.3) so the webhook reconciles
 * against the price the user actually saw, not a live table that may change.
 * Performs NO wallet write — crediting is the webhook's job (REQ-2.6).
 */
export async function createCheckoutSession(
  userId: string,
  packId: string,
  appBaseUrl: string,
): Promise<CheckoutSession> {
  const stripe = getStripeClient();
  if (!stripe) {
    throw new AppError(
      402,
      'BILLING_NOT_AVAILABLE',
      'platform billing is not enabled on this instance',
    );
  }

  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) {
    throw new AppError(400, 'UNKNOWN_PACK', `Unknown credit pack: ${packId}`);
  }

  const returnUrl = `${appBaseUrl}${APP_BASE_PATH}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: returnUrl,
    cancel_url: returnUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: pack.currency,
          unit_amount: pack.priceMinor,
          product_data: { name: `${pack.label} credit pack` },
        },
      },
    ],
    // Snapshot the price the user saw (REQ-2.3). The webhook reconciles the
    // settled amount against expectedAmountMinor/expectedCurrency captured here,
    // NOT a live CREDIT_PACKS value that may change by deploy.
    metadata: {
      userId,
      packId: pack.id,
      creditGrant: pack.credits,
      expectedAmountMinor: String(pack.priceMinor),
      expectedCurrency: pack.currency,
    },
  });

  if (!session.url) {
    throw new AppError(502, 'CHECKOUT_FAILED', 'Stripe did not return a checkout URL');
  }
  captureServerEvent('checkout_session_created', {
    distinctId: userId,
    properties: { packId: pack.id },
  });
  return { url: session.url };
}

// --- Pre-flight gate & reservation (Component 6) ----------------------------

export interface Reservation {
  /** The held amount (micro-USD) added to `wallets.reserved` at admission. */
  held: bigint;
}

/**
 * Pre-flight gate + atomic balance reservation (REQ-6). Inside ONE
 * `getWalletForUpdate` transaction:
 *
 *  1. Expire a stale reservation (fail-safe): if `reserved_at` is older than
 *     `RESERVATION_TTL_MS`, treat `reserved` as 0. A stranded hold only ever
 *     lowers the available read, so it can cause a spurious refusal but never an
 *     overdraw.
 *  2. Verify the model is priced (else `MODEL_NOT_AVAILABLE`).
 *  3. Verify `available = balance − reserved ≥ MIN_RESERVATION_CREDITS` (else the
 *     honest-messaging branch — `INSUFFICIENT_CREDITS` when Stripe is configured,
 *     `BILLING_NOT_AVAILABLE` when it is not, since with no purchase UI "add
 *     credits" is a dead-end).
 *  4. Decrement-or-reject: `reserved += threshold`, `reserved_at = now()`.
 *
 * Returns the reservation handle (the held amount).
 */
export async function gateAndReserve(
  userId: string,
  provider: ProviderId,
  model: string,
): Promise<Reservation> {
  const threshold = BigInt(config.MIN_RESERVATION_CREDITS);

  return withTransaction(db, async (tx: Transaction) => {
    const wallet = await ensureWallet(tx, userId);

    // (1) Expire a stale hold before evaluating availability (fail-safe).
    const effectiveReserved = isReservationStale(wallet)
      ? await expireStaleReservation(tx, userId)
      : wallet.reserved;

    // (2) Model must be priced to be billable in platform mode.
    if (!isModelPriced(provider, model)) {
      throw new AppError(
        402,
        'MODEL_NOT_AVAILABLE',
        `${provider}/${model} is not available for billing`,
      );
    }

    // (3) Sufficient available balance?
    const available = wallet.balance - effectiveReserved;
    if (available < threshold) {
      throw insufficientBalanceError();
    }

    // (4) Decrement-or-reject: hold the threshold.
    await tx.execute(
      sql`UPDATE wallets SET reserved = reserved + ${threshold}, reserved_at = now(), updated_at = now() WHERE user_id = ${userId}`,
    );
    return { held: threshold };
  });
}

/**
 * Release a previously held reservation for a non-debit exit (Component 6). A
 * bounded standalone `wallets` update: `reserved −= held`, clamped at ≥ 0. Used
 * by streaming exit paths that do not debit (provider error, abort, dedupe).
 */
export async function releaseReservation(userId: string, held: bigint): Promise<void> {
  if (held <= 0n) return;
  // Clamp at 0 so a double-release or a TTL-expired hold can never drive
  // `reserved` negative.
  await db.execute(
    sql`UPDATE wallets SET reserved = GREATEST(reserved - ${held}, 0), updated_at = now() WHERE user_id = ${userId}`,
  );
}

// --- internals --------------------------------------------------------------

/** A non-zero hold whose `reserved_at` is older than the TTL is stale. */
function isReservationStale(wallet: WalletRow): boolean {
  if (wallet.reserved <= 0n || !wallet.reservedAt) return false;
  return Date.now() - wallet.reservedAt.getTime() > config.RESERVATION_TTL_MS;
}

/** Zero out a stale hold under the row lock; returns the now-zero reserved. */
async function expireStaleReservation(tx: Transaction, userId: string): Promise<bigint> {
  await tx.execute(
    sql`UPDATE wallets SET reserved = 0, reserved_at = NULL, updated_at = now() WHERE user_id = ${userId}`,
  );
  return 0n;
}

/**
 * Honest-messaging refusal (F6 / REQ-10.4). When Stripe is configured the user
 * can buy credits, so tell them to. When it is not, there is no purchase UI, so
 * "add credits" is a misleading dead-end — refuse with `BILLING_NOT_AVAILABLE`.
 */
function insufficientBalanceError(): AppError {
  if (isStripeConfigured()) {
    return new AppError(
      402,
      'INSUFFICIENT_CREDITS',
      "You're out of credits — add credits to keep using the advisor.",
    );
  }
  return new AppError(
    402,
    'BILLING_NOT_AVAILABLE',
    'platform billing is not enabled on this instance',
  );
}

// ---------------------------------------------------------------------------
// Stripe webhook — idempotent, settled-only crediting (design Component 4).
//
// This function receives an ALREADY-VERIFIED `Stripe.Event` (signature/raw-body
// verification is the route's job, Task 10). Idempotency is the
// `webhook_events.stripe_event_id` UNIQUE constraint, NOT an in-memory guard.
// Credits/amounts are bigint micro-USD; grant + expected amount come from the
// session/event METADATA snapshot, never client input or the live CREDIT_PACKS.
// ---------------------------------------------------------------------------

/**
 * Structured outcome the route (Task 10) maps to an HTTP status:
 *  - `credited` / `acked` / `duplicate` / `refused` ⇒ ack `200` (Stripe stops
 *    retrying — the event reached a terminal state and was recorded).
 *  - `retry` ⇒ a retryable `5xx`: a transient verify-failure that wrote NO row,
 *    so Stripe redelivers and a legitimate purchase is not lost (REQ-3.6).
 */
export type WebhookResult =
  | { kind: 'credited'; balance: bigint }
  | { kind: 'acked' } // claimed + outcome recorded, no credit (non-trigger `ignored`, subscription-family, subscription-mode checkout `processed`)
  | { kind: 'duplicate' } // unique-constraint no-op — already processed
  | { kind: 'refused' } // definitive mismatch — recorded `failed`, no grant
  | { kind: 'reversed'; balance: bigint } // chargeback/refund proportional reversal
  | { kind: 'retry' }; // transient verify-failure — NOT recorded, retryable 5xx

/** A definitive reconciliation mismatch — refuse-and-record, no retry. */
class ReconcileMismatchError extends Error {}
/** A transient verify-failure — cannot determine the match; do NOT record. */
class TransientVerifyError extends Error {}

interface CreditMetadata {
  userId: string;
  creditGrant: bigint;
  expectedAmountMinor: bigint;
  expectedCurrency: string;
}

/** The two mutually-exclusive settled-credit trigger event types (REQ-3.3). */
type CreditTrigger = 'sync' | 'async';

/**
 * Pure trigger selection (REQ-3.3, REQ-3.7). Returns the single settled-credit
 * trigger for a checkout.session event, or `null` for every other event —
 * including `completed` with a non-`paid` status and `async_payment_failed` —
 * so the multi-event fan-out cannot double-credit. Defensive mode guard (D5,
 * REQ-3.1): only a payment-mode (credit-pack) session can ever be a credit
 * trigger — the dispatcher discriminates subscription-mode sessions before
 * this point, but the pure function stays safe in isolation.
 */
export function selectCreditTrigger(event: Stripe.Event): CreditTrigger | null {
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return null;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== 'payment') return null;
  if (event.type === 'checkout.session.completed') {
    return session.payment_status === 'paid' ? 'sync' : null;
  }
  return 'async';
}

/**
 * Pure reconciliation classifier (REQ-3a, REQ-3.6). Compares the event's
 * confirmed paid `amount_total`/`currency` against the metadata-snapshotted
 * `expectedAmountMinor`/`expectedCurrency`:
 *  - exact match ⇒ `'ok'` (credit).
 *  - `amount_total` not yet readable (null) ⇒ `'transient'`: cannot DETERMINE
 *    the match, so do not record — Stripe redelivers.
 *  - a resolved amount/currency that differs ⇒ `'mismatch'`: definitive
 *    refuse-and-record (partial/zero capture, wrong currency, tampered session).
 */
export function classifyReconciliation(
  paid: { amountTotal: number | null; currency: string | null },
  expected: { amountMinor: bigint; currency: string },
): 'ok' | 'mismatch' | 'transient' {
  if (paid.amountTotal == null) return 'transient';
  if (BigInt(paid.amountTotal) !== expected.amountMinor) return 'mismatch';
  if ((paid.currency ?? '').toLowerCase() !== expected.currency.toLowerCase()) return 'mismatch';
  return 'ok';
}

/**
 * Pure proportional-reversal math (REQ-3.9). A full dispute/refund reverses the
 * whole grant; a partial `charge.refunded` reverses the refunded FRACTION of the
 * grant (`grant * refunded / chargeAmount`), floor-rounded so Tradr never
 * over-reverses on rounding. Returns the magnitude to claw back (a positive
 * bigint); the caller applies it as a negative `reversal` delta.
 */
export function proportionalReversal(
  grant: bigint,
  refundedMinor: number,
  chargeAmountMinor: number,
): bigint {
  if (chargeAmountMinor <= 0 || refundedMinor >= chargeAmountMinor) return grant;
  if (refundedMinor <= 0) return 0n;
  return (grant * BigInt(refundedMinor)) / BigInt(chargeAmountMinor);
}

/** Resolve a Stripe `string | {id} | null` expandable field to its id. */
export function resolveId(value: string | { id: string } | null | undefined): string | null {
  if (value == null) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Read + validate the credit metadata snapshot off a checkout.session
 * (REQ-2.3). A settled trigger with no/garbled metadata is a misconfigured or
 * tampered session ⇒ a DEFINITIVE mismatch (refuse-and-record), never a credit
 * from client-controllable input.
 */
function readCreditMetadata(session: Stripe.Checkout.Session): CreditMetadata {
  const m = session.metadata ?? {};
  const userId = m.userId;
  const grant = m.creditGrant;
  const amount = m.expectedAmountMinor;
  const currency = m.expectedCurrency;
  if (!userId || !grant || !amount || !currency) {
    throw new ReconcileMismatchError('checkout session is missing credit metadata');
  }
  try {
    return {
      userId,
      creditGrant: BigInt(grant),
      expectedAmountMinor: BigInt(amount),
      expectedCurrency: currency,
    };
  } catch {
    throw new ReconcileMismatchError('checkout session metadata is malformed');
  }
}

/** The five subscription-family event types dispatched to the mirror (D5). */
const SUBSCRIPTION_EVENT_TYPES = new Set<string>([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** The claim transaction's combined outcome: the result + post-commit effects. */
interface ClaimOutcome {
  result: WebhookResult;
  effects: PostCommitEffect[];
}

/** A terminal claim outcome with no post-commit effects. */
function noEffects(result: WebhookResult): ClaimOutcome {
  return { result, effects: [] };
}

/**
 * Execute the post-commit effects (D5): sequential, each INDIVIDUALLY guarded.
 * Runs strictly after `withTransaction` commits and before the route acks — a
 * throwing effect is logged and swallowed so it can never convert a committed
 * `processed` event into a retryable 5xx (a redelivery loop).
 */
async function runPostCommitEffects(effects: PostCommitEffect[]): Promise<void> {
  for (const effect of effects) {
    try {
      await effect.run();
    } catch (err) {
      logger.error('post-commit webhook effect failed', {
        kind: effect.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * D5's misconfiguration canary: a subscription-mode Checkout completion whose
 * `session.subscription` has no mirror row yet. Expected transiently under
 * normal ordering (`customer.subscription.*` may land after the session
 * event); a PERSISTENT stream of these is the operator signal that the webhook
 * endpoint's event registration is missing the subscription family.
 */
async function warnIfSubscriptionUnmirrored(
  tx: Transaction,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const stripeSubscriptionId = resolveId(session.subscription);
  if (!stripeSubscriptionId) return;
  if (await selectSubscriptionByStripeId(tx, stripeSubscriptionId)) return;
  logger.warn(
    "subscription-mode checkout processed; awaiting customer.subscription.* events — if this persists, verify the webhook endpoint's event registration",
    {
      stripeEventId: event.id,
      eventType: event.type,
      sessionMode: session.mode,
      stripeSubscriptionId,
    },
  );
}

/**
 * Idempotent Stripe webhook handler (design Component 4 + plan-tiers D5,
 * REQ-3, REQ-9.1/9.4). Takes an already-verified event. Within ONE
 * `withTransaction`: claim → (reversal | subscription-family dispatch |
 * subscription-mode discrimination | settled-credit | ack) → record, so
 * record and state commit together (REQ-9.4). Post-commit side effects
 * (analytics, the D1 re-fetch, the D7 reconciliation trigger) are collected
 * during the transaction and executed strictly AFTER commit and BEFORE the
 * route acks, each individually guarded (REQ-3.4, REQ-13.2). Transient
 * failures still roll back the claim and return `retry` — Stripe redelivers;
 * a Stripe-timeout redelivery during the effects window hits the duplicate
 * claim and acks instantly (accepted D5 posture). Returns a structured
 * outcome.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<WebhookResult> {
  try {
    const { result, effects } = await withTransaction(
      db,
      async (tx: Transaction): Promise<ClaimOutcome> => {
        // (claim) Via the UNIQUE constraint (REQ-3.2, REQ-9.1). A no-op insert
        // means a prior delivery already processed this event ⇒ ack, no re-credit.
        const claimed = await claimWebhookEvent(tx, {
          stripeEventId: event.id,
          eventType: event.type,
          status: 'received',
        });
        if (!claimed) return noEffects({ kind: 'duplicate' });

        // Chargeback/refund reversal (REQ-3.9).
        if (event.type === 'charge.dispute.created' || event.type === 'charge.refunded') {
          return noEffects(await reverseForEvent(tx, event));
        }

        // (a) Subscription-family dispatch (D5, REQ-3.2): the mirror upsert
        // runs INSIDE the claim transaction. `applySubscriptionEvent` records
        // the event's webhook outcome ITSELF (processed/ignored — never
        // double-recorded here) and returns the post-commit effects: the D17
        // analytics, the D1 re-fetch, and the D7 reconciliation trigger.
        if (SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
          return { result: { kind: 'acked' }, effects: await applySubscriptionEvent(tx, event) };
        }

        // (b) Subscription-mode Checkout discrimination (D5, REQ-3.1): a
        // non-payment-mode session is a Pro purchase, not a credit pack — it is
        // recorded `processed` and never reaches `selectCreditTrigger`/
        // `readCreditMetadata` (no `failed` row, no error log for a legitimate
        // subscription purchase). The mirror itself is driven by the
        // `customer.subscription.*` events; this branch only carries the
        // misconfiguration canary.
        if (
          event.type === 'checkout.session.completed' ||
          event.type === 'checkout.session.async_payment_succeeded'
        ) {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode !== 'payment') {
            await warnIfSubscriptionUnmirrored(tx, event, session);
            await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'processed' });
            return noEffects({ kind: 'acked' });
          }
        }

        // (c) Settled-only single-trigger selection (REQ-3.3, REQ-3.7).
        const trigger = selectCreditTrigger(event);
        if (!trigger) {
          // Non-trigger / non-paid-completed / async-failed ⇒ acked-without-credit.
          await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'ignored' });
          return noEffects({ kind: 'acked' });
        }

        const session = event.data.object as Stripe.Checkout.Session;
        const meta = readCreditMetadata(session);

        // Reconcile the confirmed paid amount/currency against the metadata
        // snapshot (REQ-3a) — NOT the live CREDIT_PACKS.
        const verdict = classifyReconciliation(
          { amountTotal: session.amount_total, currency: session.currency },
          { amountMinor: meta.expectedAmountMinor, currency: meta.expectedCurrency },
        );
        if (verdict === 'transient') {
          // Cannot determine the match ⇒ do NOT record; throw to roll back the
          // claim so Stripe redelivers (REQ-3.6).
          throw new TransientVerifyError('paid amount not yet readable');
        }
        if (verdict === 'mismatch') {
          throw new ReconcileMismatchError(
            `paid ${session.amount_total} ${session.currency} != expected ${meta.expectedAmountMinor} ${meta.expectedCurrency}`,
          );
        }

        // (d) Settled + reconciled ⇒ credit from server-side metadata, capturing
        // the payment intent for the F3 reversal join (REQ-3.3).
        const paymentIntentId = resolveId(session.payment_intent);
        const applied = await creditWalletForEvent(tx, {
          userId: meta.userId,
          creditGrant: meta.creditGrant,
          stripeEventId: event.id,
          stripePaymentIntentId: paymentIntentId,
        });
        await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'processed' });
        return {
          result: { kind: 'credited', balance: applied.balance },
          // REQ-13.2: the `credits_purchased` capture is a post-commit effect —
          // emitted only after the claim transaction commits, never inside it.
          effects: [
            {
              kind: 'analytics',
              run: async () => {
                captureServerEvent('credits_purchased', {
                  distinctId: meta.userId,
                  properties: { packId: session.metadata?.packId ?? '' },
                });
              },
            },
          ],
        };
      },
    );

    // (D5) Post-commit effects: after the claim transaction commits, before
    // the route acks — each individually guarded inside the executor.
    await runPostCommitEffects(effects);
    return result;
  } catch (err) {
    if (err instanceof ReconcileMismatchError) {
      // Definitive mismatch — refuse-and-record in its OWN transaction (the
      // first tx rolled back the claim) + an operator-observable log (REQ-3.8).
      logger.error('stripe webhook reconciliation mismatch — refusing credit', {
        stripeEventId: event.id,
        eventType: event.type,
        error: err.message,
      });
      await withTransaction(db, async (tx: Transaction) => {
        await claimWebhookEvent(tx, {
          stripeEventId: event.id,
          eventType: event.type,
          status: 'received',
        });
        await recordWebhookOutcome(tx, {
          stripeEventId: event.id,
          status: 'failed',
          error: err.message,
        });
      });
      return { kind: 'refused' };
    }
    if (err instanceof TransientVerifyError) {
      // Transient — wrote NO row (claim rolled back). Return retryable so Stripe
      // redelivers (REQ-3.6).
      logger.warn('stripe webhook transient verify-failure — will retry', {
        stripeEventId: event.id,
        eventType: event.type,
        error: err.message,
      });
      return { kind: 'retry' };
    }
    // Unexpected error (e.g. DB blip) — retryable so the event is not lost.
    logger.error('stripe webhook processing error — will retry', {
      stripeEventId: event.id,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'retry' };
  }
}

/**
 * Chargeback/refund proportional reversal (REQ-3.9). Locates the original grant
 * via the F3 `payment_intent` join and reverses INCREMENTALLY: Stripe's
 * `charge.refunded` carries the CUMULATIVE `amount_refunded` and each sequential
 * partial refund fires a distinct event id, so reversing the per-event proportion
 * directly over-claws (30% then 50% cumulative would reverse 30%+50%=80%). The
 * fix computes the cumulative TARGET reversal for the new `amount_refunded`,
 * subtracts the reversals already applied for this payment intent, and applies
 * only the positive remainder — so the total reversed never exceeds (and at the
 * final state equals) the proportional cumulative refund. A full dispute/refund
 * still reverses the whole remaining grant. Idempotent by event id (a redelivered
 * SAME event is a no-op) AND correct across distinct cumulative-refund events.
 * Allows the balance to go NEGATIVE and flags the account (`flagged` marker on the
 * reversal row + a structured log). Runs inside the caller's claimed tx.
 */
async function reverseForEvent(tx: Transaction, event: Stripe.Event): Promise<WebhookResult> {
  // Idempotency by event id — a redelivered dispute/refund must not double-reverse.
  if (await findReversalByEventId(tx, event.id)) {
    await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'ignored' });
    return { kind: 'acked' };
  }

  let paymentIntentId: string | null;
  let refundedMinor: number;
  let chargeAmountMinor: number;
  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge;
    paymentIntentId = resolveId(charge.payment_intent);
    refundedMinor = charge.amount_refunded; // CUMULATIVE total refunded on the charge
    chargeAmountMinor = charge.amount;
  } else {
    const dispute = event.data.object as Stripe.Dispute;
    paymentIntentId = resolveId(dispute.payment_intent);
    // A dispute reverses the whole grant (full).
    refundedMinor = 1;
    chargeAmountMinor = 1;
  }

  if (!paymentIntentId) {
    // No join key ⇒ nothing to reverse here; ack so Stripe stops retrying.
    await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'ignored' });
    return { kind: 'acked' };
  }

  const grants = await findCreditByPaymentIntent(tx, paymentIntentId);
  if (grants.length === 0) {
    // Reversal for a payment we never credited (or already fully reversed) ⇒ ack.
    await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'ignored' });
    return { kind: 'acked' };
  }

  // Cumulative TARGET reversal for this event's `amount_refunded`, across all grants
  // sharing the payment intent.
  const targetReversal = grants.reduce(
    (acc, grant) => acc + proportionalReversal(grant.amount, refundedMinor, chargeAmountMinor),
    0n,
  );
  // Subtract what we've already reversed for this PI on prior (distinct) refund
  // events; apply only the positive remainder (nothing if already fully reversed).
  const alreadyReversed = await sumReversalsByPaymentIntent(tx, paymentIntentId);
  let remaining = targetReversal - alreadyReversed;
  if (remaining <= 0n) {
    await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'ignored' });
    return { kind: 'acked' };
  }

  let lastBalance = 0n;
  for (const grant of grants) {
    if (remaining <= 0n) break;
    // Distribute the remainder across grants, capped per grant at its own grant
    // amount so a single reversal can't exceed the credit it claws back.
    const magnitude = remaining < grant.amount ? remaining : grant.amount;
    if (magnitude <= 0n) continue;
    remaining -= magnitude;
    await ensureWallet(tx, grant.userId);
    const applied = await applyBalanceDelta(tx, grant.userId, {
      deltaBalance: -magnitude, // balance MAY go negative (REQ-3.9)
      deltaReserved: 0n,
      kind: 'reversal',
      amount: -magnitude,
      reference: {
        stripeEventId: event.id,
        stripePaymentIntentId: paymentIntentId,
      },
    });
    lastBalance = applied.balance;
    // Flag the account: structured log + the reversal row is the `flagged` marker.
    logger.warn('stripe chargeback/refund reversal — account flagged', {
      stripeEventId: event.id,
      eventType: event.type,
      userId: grant.userId,
      flagged: true,
      reversedAmount: magnitude.toString(),
      balanceAfter: applied.balance.toString(),
    });
  }

  await recordWebhookOutcome(tx, { stripeEventId: event.id, status: 'processed' });
  return { kind: 'reversed', balance: lastBalance };
}
