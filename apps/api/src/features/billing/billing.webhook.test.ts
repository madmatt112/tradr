import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { users, walletTransactions, webhookEvents } from '@/db/schema';
import { config } from '@/lib/config';

// ---------------------------------------------------------------------------
// Stripe webhook integration tests (Task 16 — design Testing Strategy → money-IN
// half). Drives POST /api/billing/webhook through Hono `app.request` against a
// real Postgres (no DB mocks; per-test transaction-rollback isolation from
// test-setup.ts). Signatures are generated over the EXACT raw bytes the route
// reads with `stripe.webhooks.generateTestHeaderString`, so verification,
// idempotency, reconciliation, and reversal all exercise the real Task 9/10
// code paths end-to-end.
//
// Stripe config is set on the (mutable) parsed `config` object for the suite so
// `isStripeConfigured()` is true and the route constructs a real Stripe client;
// `constructEvent`/`generateTestHeaderString` are offline crypto (no network).
// ---------------------------------------------------------------------------

const TEST_SECRET = 'sk_test_dummy_for_webhook_signing';
const TEST_WEBHOOK_SECRET = 'whsec_test_dummy_webhook_secret';

const stripe = new Stripe(TEST_SECRET);

let prevSecret: string | undefined;
let prevWebhookSecret: string | undefined;

beforeAll(() => {
  prevSecret = config.STRIPE_SECRET_KEY;
  prevWebhookSecret = config.STRIPE_WEBHOOK_SECRET;
  config.STRIPE_SECRET_KEY = TEST_SECRET;
  config.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});

afterAll(() => {
  config.STRIPE_SECRET_KEY = prevSecret;
  config.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
});

let ipCounter = 0;
function uniqueIp() {
  return `10.55.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

let emailCounter = 0;
function uniqueEmail() {
  return `webhook-test-${Date.now()}-${++emailCounter}@example.com`;
}

/** Insert a user row directly (the webhook never authenticates a session). */
async function createUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return row!.id;
}

/**
 * POST a raw JSON payload to the webhook with a valid signature generated over
 * the EXACT bytes posted. Mirrors how Stripe signs: the header covers the raw
 * body, and the route verifies the same bytes (REQ-3.1).
 */
async function postWebhook(
  payload: string,
  opts: { signature?: string; ip?: string } = {},
): Promise<Response> {
  const signature =
    opts.signature ??
    stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });
  return app.request('/api/billing/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': opts.ip ?? uniqueIp(),
      'Stripe-Signature': signature,
    },
    body: payload,
  });
}

let eventCounter = 0;
function uniqueEventId(prefix = 'evt') {
  return `${prefix}_test_${Date.now()}_${++eventCounter}`;
}

/**
 * Build a `checkout.session.*` event with the SAME metadata shape
 * `createCheckoutSession` writes (userId/packId/creditGrant/expectedAmountMinor/
 * expectedCurrency). The webhook reconciles `amount_total`/`currency` against
 * this snapshot, so amount/currency default to the expected values (overridable
 * to force a mismatch). Returned as a raw JSON string so the signed bytes are
 * exactly what the route verifies.
 */
function checkoutSessionEvent(args: {
  id?: string;
  type: 'checkout.session.completed' | 'checkout.session.async_payment_succeeded';
  userId: string;
  creditGrant: string;
  expectedAmountMinor: string;
  expectedCurrency: string;
  paymentStatus?: string;
  amountTotal?: number | null;
  currency?: string | null;
  paymentIntent?: string | null;
}): { id: string; payload: string } {
  const id = args.id ?? uniqueEventId();
  const event = {
    id,
    object: 'event',
    type: args.type,
    data: {
      object: {
        id: `cs_test_${id}`,
        object: 'checkout.session',
        // Credit packs are payment-mode sessions (real Stripe payloads always
        // carry `mode`; plan-tiers D5 discriminates on it before the trigger).
        mode: 'payment',
        payment_status: args.paymentStatus ?? 'paid',
        amount_total:
          args.amountTotal === undefined ? Number(args.expectedAmountMinor) : args.amountTotal,
        currency: args.currency === undefined ? args.expectedCurrency : args.currency,
        payment_intent: args.paymentIntent === undefined ? `pi_test_${id}` : args.paymentIntent,
        metadata: {
          userId: args.userId,
          packId: 'pack_test',
          creditGrant: args.creditGrant,
          expectedAmountMinor: args.expectedAmountMinor,
          expectedCurrency: args.expectedCurrency,
        },
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

function chargeRefundedEvent(args: {
  id?: string;
  paymentIntent: string;
  amount: number;
  amountRefunded: number;
}): { id: string; payload: string } {
  const id = args.id ?? uniqueEventId('refund');
  const event = {
    id,
    object: 'event',
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_test_${id}`,
        object: 'charge',
        payment_intent: args.paymentIntent,
        amount: args.amount,
        amount_refunded: args.amountRefunded,
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

function disputeCreatedEvent(args: { id?: string; paymentIntent: string }): {
  id: string;
  payload: string;
} {
  const id = args.id ?? uniqueEventId('dispute');
  const event = {
    id,
    object: 'event',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: `dp_test_${id}`,
        object: 'dispute',
        payment_intent: args.paymentIntent,
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

/** Count `credit` wallet_transactions rows for a user (exactly-once assertions). */
async function countCredits(userId: string): Promise<number> {
  const rows = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.kind, 'credit')));
  return rows.length;
}

async function balanceOf(userId: string): Promise<bigint> {
  const rows = await db
    .select({ amount: walletTransactions.amount, kind: walletTransactions.kind })
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId));
  return rows.reduce((acc, r) => acc + r.amount, 0n);
}

async function webhookRow(eventId: string) {
  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, eventId));
  return row;
}

// ===========================================================================
// Webhook idempotency + settled-only crediting (REQ-3.2, REQ-3.3, REQ-3.7, REQ-9.1)
// ===========================================================================

describe('POST /api/billing/webhook — idempotency & settled-only crediting', () => {
  it('credits exactly once for a settled completed+paid session', async () => {
    const userId = await createUser();
    const { id, payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('credited');

    expect(await countCredits(userId)).toBe(1);
    expect(await balanceOf(userId)).toBe(1_000_000n);
    expect((await webhookRow(id))!.status).toBe('processed');
  });

  it('same event id delivered twice → exactly ONE credit (duplicate ack)', async () => {
    const userId = await createUser();
    const { payload } = checkoutSessionEvent({
      id: uniqueEventId(),
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
    });

    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    expect((await first.json()).outcome).toBe('credited');

    const second = await postWebhook(payload);
    expect(second.status).toBe(200);
    expect((await second.json()).outcome).toBe('duplicate');

    expect(await countCredits(userId)).toBe(1);
    expect(await balanceOf(userId)).toBe(1_000_000n);
  });

  it("completed with payment_status!=='paid' → acked, NO credit", async () => {
    const userId = await createUser();
    const { id, payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
      paymentStatus: 'unpaid',
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('acked');

    expect(await countCredits(userId)).toBe(0);
    expect((await webhookRow(id))!.status).toBe('ignored');
  });

  it('async_payment_succeeded → credit', async () => {
    const userId = await createUser();
    const { id, payload } = checkoutSessionEvent({
      type: 'checkout.session.async_payment_succeeded',
      userId,
      creditGrant: '2000000',
      expectedAmountMinor: '999',
      expectedCurrency: 'usd',
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('credited');

    expect(await countCredits(userId)).toBe(1);
    expect(await balanceOf(userId)).toBe(2_000_000n);
    expect((await webhookRow(id))!.status).toBe('processed');
  });

  it('three-event fan-out (completed + payment_intent.succeeded + charge.succeeded) → exactly ONE credit', async () => {
    const userId = await createUser();
    const paymentIntent = `pi_fanout_${Date.now()}`;

    // 1) checkout.session.completed + paid → the single settled trigger.
    const completed = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1500000',
      expectedAmountMinor: '750',
      expectedCurrency: 'usd',
      paymentIntent,
    });
    // 2) payment_intent.succeeded — a sibling event of the same purchase. NOT a
    //    credit trigger (selectCreditTrigger returns null).
    const piSucceeded = {
      id: uniqueEventId('pi'),
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: paymentIntent, object: 'payment_intent', amount: 750 } },
    };
    // 3) charge.succeeded — also a sibling, also NOT a credit trigger.
    const chargeSucceeded = {
      id: uniqueEventId('ch'),
      object: 'event',
      type: 'charge.succeeded',
      data: {
        object: { id: `ch_${paymentIntent}`, object: 'charge', payment_intent: paymentIntent },
      },
    };

    const r1 = await postWebhook(completed.payload);
    const r2 = await postWebhook(JSON.stringify(piSucceeded));
    const r3 = await postWebhook(JSON.stringify(chargeSucceeded));

    expect(r1.status).toBe(200);
    expect((await r1.json()).outcome).toBe('credited');
    expect(r2.status).toBe(200);
    expect((await r2.json()).outcome).toBe('acked');
    expect(r3.status).toBe(200);
    expect((await r3.json()).outcome).toBe('acked');

    expect(await countCredits(userId)).toBe(1);
    expect(await balanceOf(userId)).toBe(1_500_000n);
  });
});

// ===========================================================================
// Raw-body signature — the mandated acceptance test + the raw-body regression
// guard (REQ-3.1)
// ===========================================================================

describe('POST /api/billing/webhook — raw-body signature (REQ-3.1)', () => {
  it('a valid signature over the EXACT raw bytes verifies and processes', async () => {
    const userId = await createUser();
    const { payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('credited');
    expect(await countCredits(userId)).toBe(1);
  });

  it('an invalid/forged signature → 400, NO wallet touched', async () => {
    const userId = await createUser();
    const { payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
    });

    const res = await postWebhook(payload, { signature: 't=1,v1=deadbeef' });
    expect(res.status).toBe(400);
    expect(await countCredits(userId)).toBe(0);
  });

  it('missing Stripe-Signature header → 400, NO wallet touched', async () => {
    const userId = await createUser();
    const { payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
    });

    const res = await app.request('/api/billing/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(await countCredits(userId)).toBe(0);
  });

  it('REGRESSION GUARD: a body that would change under JSON re-serialization still verifies (route reads raw, not re-parsed, body)', async () => {
    const userId = await createUser();
    // Hand-craft a payload whose byte form does NOT match what JSON.stringify of
    // the parsed object would produce: extra whitespace + key ordering that a
    // re-serialize would normalize. If the route re-serialized (parsed then
    // re-stringified) the body before verifying, the signature over THESE bytes
    // would no longer match and verification would fail. It must verify because
    // the route signs/verifies the exact raw bytes (REQ-3.1).
    const id = uniqueEventId('raw');
    const rawPayload =
      `{\n  "id": "${id}",\n` +
      `  "object":   "event",\n` +
      `  "type": "checkout.session.completed",\n` +
      `  "data": { "object": {\n` +
      `      "mode": "payment",\n` +
      `      "payment_status": "paid",\n` +
      `      "amount_total": 500,\n` +
      `      "currency": "usd",\n` +
      `      "payment_intent": "pi_raw_${id}",\n` +
      `      "metadata": {\n` +
      `        "expectedCurrency": "usd",\n` +
      `        "expectedAmountMinor": "500",\n` +
      `        "creditGrant": "1000000",\n` +
      `        "userId": "${userId}",\n` +
      `        "packId": "pack_test"\n` +
      `      }\n` +
      `  } }\n}`;

    // Sanity: re-serializing the parsed object yields DIFFERENT bytes, so a
    // re-serialize-then-verify route would break.
    const reSerialized = JSON.stringify(JSON.parse(rawPayload));
    expect(reSerialized).not.toBe(rawPayload);

    const res = await postWebhook(rawPayload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('credited');
    expect(await countCredits(userId)).toBe(1);
    expect(await balanceOf(userId)).toBe(1_000_000n);
  });
});

// ===========================================================================
// Reconciliation — definitive mismatch vs transient (REQ-3.6, REQ-3.8)
// ===========================================================================

describe('POST /api/billing/webhook — reconciliation (REQ-3.6, REQ-3.8)', () => {
  it('definitive amount mismatch → refuse-and-record `failed`, NO grant', async () => {
    const userId = await createUser();
    const { id, payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
      amountTotal: 499, // paid less than the snapshot — definitive mismatch
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200); // terminal ack — Stripe stops retrying
    expect((await res.json()).outcome).toBe('refused');

    expect(await countCredits(userId)).toBe(0);
    const row = await webhookRow(id);
    expect(row!.status).toBe('failed'); // operator-visible
    expect(row!.error).toBeTruthy();
  });

  it('definitive currency mismatch → refuse-and-record `failed`, NO grant', async () => {
    const userId = await createUser();
    const { id, payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
      currency: 'eur', // wrong currency
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('refused');

    expect(await countCredits(userId)).toBe(0);
    expect((await webhookRow(id))!.status).toBe('failed');
  });

  it('transient verify-failure (amount_total not yet readable) → retryable 5xx, NOT recorded', async () => {
    const userId = await createUser();
    const { id, payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      expectedCurrency: 'usd',
      amountTotal: null, // not yet readable ⇒ cannot determine match ⇒ transient
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(500); // retryable — Stripe redelivers
    expect((await res.json()).outcome).toBe('retry');

    expect(await countCredits(userId)).toBe(0);
    // NO row written — the claim rolled back so a redelivery is reprocessable.
    expect(await webhookRow(id)).toBeUndefined();
  });
});

// ===========================================================================
// Chargeback / refund — whole-grant + proportional reversal (REQ-3.9)
// ===========================================================================

describe('POST /api/billing/webhook — chargeback/refund reversal (REQ-3.9)', () => {
  /** Credit a wallet via a settled webhook and return the payment intent used. */
  async function creditUser(userId: string, grant: string, amountMinor: number): Promise<string> {
    const paymentIntent = `pi_grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { payload } = checkoutSessionEvent({
      type: 'checkout.session.completed',
      userId,
      creditGrant: grant,
      expectedAmountMinor: String(amountMinor),
      expectedCurrency: 'usd',
      paymentIntent,
    });
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('credited');
    return paymentIntent;
  }

  it('charge.dispute.created → whole-grant reversal end-to-end (balance negative, flagged, idempotent)', async () => {
    const userId = await createUser();
    const pi = await creditUser(userId, '1000000', 500);
    expect(await balanceOf(userId)).toBe(1_000_000n);

    const dispute = disputeCreatedEvent({ paymentIntent: pi });
    const res = await postWebhook(dispute.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('reversed');

    // Whole grant clawed back → balance back to 0 here (grant exactly equals credit).
    expect(await balanceOf(userId)).toBe(0n);
    expect((await webhookRow(dispute.id))!.status).toBe('processed');

    // A reversal row exists (the `flagged` marker / account flag).
    const reversals = await db
      .select({ amount: walletTransactions.amount })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.kind, 'reversal')));
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.amount).toBe(-1_000_000n);

    // Idempotent by event id — redelivery is a no-op (acked, no second reversal).
    const replay = await postWebhook(dispute.payload);
    expect(replay.status).toBe(200);
    expect((await replay.json()).outcome).toBe('duplicate');
    expect(await balanceOf(userId)).toBe(0n);
  });

  it('full charge.refunded → whole-grant reversal, balance goes NEGATIVE after spend', async () => {
    const userId = await createUser();
    const pi = await creditUser(userId, '1000000', 500);

    // Spend some of the credit so a full reversal drives the balance negative.
    await db.insert(walletTransactions).values({
      userId,
      kind: 'debit',
      amount: -400_000n,
      balanceAfter: 600_000n,
    });
    expect(await balanceOf(userId)).toBe(600_000n);

    const refund = chargeRefundedEvent({ paymentIntent: pi, amount: 500, amountRefunded: 500 });
    const res = await postWebhook(refund.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('reversed');

    // 600_000 − 1_000_000 = −400_000 (balance MAY go negative, REQ-3.9).
    expect(await balanceOf(userId)).toBe(-400_000n);
  });

  it('partial charge.refunded → proportional reversal (floor-rounded)', async () => {
    const userId = await createUser();
    const pi = await creditUser(userId, '1000000', 1000);
    expect(await balanceOf(userId)).toBe(1_000_000n);

    // 30% of a 1000-minor charge refunded → 30% of the 1_000_000 grant clawed back.
    const refund = chargeRefundedEvent({ paymentIntent: pi, amount: 1000, amountRefunded: 300 });
    const res = await postWebhook(refund.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('reversed');

    expect(await balanceOf(userId)).toBe(700_000n); // 1_000_000 − 300_000
  });

  it('sequential cumulative partial refunds reverse only the INCREMENTAL delta (no additive over-reversal)', async () => {
    const userId = await createUser();
    const pi = await creditUser(userId, '1000000', 1000);
    expect(await balanceOf(userId)).toBe(1_000_000n);

    // First partial refund: cumulative amount_refunded = 300 (30%) → reverse 300_000.
    const refund1 = chargeRefundedEvent({ paymentIntent: pi, amount: 1000, amountRefunded: 300 });
    const r1 = await postWebhook(refund1.payload);
    expect(r1.status).toBe(200);
    expect((await r1.json()).outcome).toBe('reversed');
    expect(await balanceOf(userId)).toBe(700_000n);

    // Second partial refund: CUMULATIVE amount_refunded = 800 (80%, a DISTINCT
    // event). The target cumulative reversal is 800_000; 300_000 already applied,
    // so only the 500_000 DELTA is reversed — NOT 800_000 additive (which would
    // leave −100_000). Total reversed = 800_000, matching the 80% cumulative.
    const refund2 = chargeRefundedEvent({ paymentIntent: pi, amount: 1000, amountRefunded: 800 });
    const r2 = await postWebhook(refund2.payload);
    expect(r2.status).toBe(200);
    expect((await r2.json()).outcome).toBe('reversed');

    expect(await balanceOf(userId)).toBe(200_000n); // 1_000_000 − 800_000 cumulative

    // Sum of reversal magnitudes equals the cumulative fraction, not 30%+80%.
    const reversals = await db
      .select({ amount: walletTransactions.amount })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.kind, 'reversal')));
    const totalReversed = reversals.reduce((acc, r) => acc - r.amount, 0n);
    expect(totalReversed).toBe(800_000n);
  });

  it('reversal for a payment we never credited → acked, no reversal row', async () => {
    const userId = await createUser();
    const refund = chargeRefundedEvent({
      paymentIntent: `pi_unknown_${Date.now()}`,
      amount: 500,
      amountRefunded: 500,
    });
    const res = await postWebhook(refund.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('acked');
    expect(await balanceOf(userId)).toBe(0n);
  });
});
