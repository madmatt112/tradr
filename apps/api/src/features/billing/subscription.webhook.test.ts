import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import {
  billingCustomers,
  subscriptions,
  users,
  walletTransactions,
  webhookEvents,
} from '@/db/schema';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { captureServerEvent } from '@/lib/posthog';

import { resolveTier } from './tier.query';

// ---------------------------------------------------------------------------
// Subscription webhook integration tests (plan-tiers Task 8 — design D1/D5/D6/
// D7, REQ-3.x). The `billing.webhook.test.ts` harness verbatim: drives
// POST /api/billing/webhook through Hono `app.request` against a real Postgres
// (per-test transaction-rollback isolation from test-setup.ts), with signatures
// generated over the EXACT raw bytes via `generateTestHeaderString` (offline
// crypto). App-side Stripe calls (the D1 re-fetch, D7 reconciliation) are
// stubbed at the ONE `stripe-client.ts` seam; the route's own signature
// verification constructs its client directly and is untouched.
// ---------------------------------------------------------------------------

const TEST_SECRET = 'sk_test_dummy_for_webhook_signing';
const TEST_WEBHOOK_SECRET = 'whsec_test_dummy_webhook_secret';

const stripe = new Stripe(TEST_SECRET);

// The app-side Stripe client stub, swappable per test. `null` = unconfigured
// (effects warn + skip). The route's verification client is NOT this seam.
const stripeStubHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('./stripe-client', () => ({
  getStripeClient: () => stripeStubHolder.current as Stripe | null,
}));

// Post-commit analytics observability: replace only `captureServerEvent`.
vi.mock('@/lib/posthog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/posthog')>();
  return { ...actual, captureServerEvent: vi.fn() };
});

interface StripeStub {
  subscriptions: { retrieve: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  invoices: { list: ReturnType<typeof vi.fn> };
  refunds: { create: ReturnType<typeof vi.fn> };
}

function makeStripeStub(): StripeStub {
  return {
    subscriptions: {
      retrieve: vi.fn().mockRejectedValue(new Error('retrieve not stubbed')),
      cancel: vi.fn().mockResolvedValue({}),
    },
    invoices: { list: vi.fn().mockResolvedValue({ data: [] }) },
    refunds: { create: vi.fn().mockResolvedValue({}) },
  };
}

/** Duck-typed Stripe error (the service classifies via `err.code`). */
function stripeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

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

beforeEach(() => {
  stripeStubHolder.current = null;
  vi.mocked(captureServerEvent).mockClear();
});

// --- harness helpers (billing.webhook.test.ts pattern) -----------------------

let ipCounter = 0;
function uniqueIp() {
  return `10.66.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

let emailCounter = 0;
function uniqueEmail() {
  return `sub-webhook-test-${Date.now()}-${++emailCounter}@example.com`;
}

let idCounter = 0;
function uniqueEventId(prefix = 'evt') {
  return `${prefix}_subtest_${Date.now()}_${++idCounter}`;
}

function uniqueSubId(prefix = 'sub') {
  return `${prefix}_test_${Date.now()}_${++idCounter}`;
}

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return row!.id;
}

/** A user with a persisted Stripe Customer linkage (D2 — webhook correlation). */
async function createLinkedUser(): Promise<{ userId: string; customerId: string }> {
  const userId = await createUser();
  const customerId = `cus_subtest_${Date.now()}_${++idCounter}`;
  await db.insert(billingCustomers).values({ userId, stripeCustomerId: customerId });
  return { userId, customerId };
}

async function postWebhook(payload: string): Promise<Response> {
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: TEST_WEBHOOK_SECRET,
  });
  return app.request('/api/billing/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
      'Stripe-Signature': signature,
    },
    body: payload,
  });
}

// --- payload builders ---------------------------------------------------------

const NOW_SEC = Math.floor(Date.now() / 1000);
const DAY_SEC = 24 * 3600;
const FUTURE_PERIOD_END_SEC = NOW_SEC + 30 * DAY_SEC;

interface SubEventArgs {
  id?: string;
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted';
  subId: string;
  customerId: string;
  status: string;
  cancelAtPeriodEnd?: boolean;
  /** `event.created` — the D1 watermark key (epoch seconds). */
  createdSec: number;
  /** `subscription.created` — the D3 ordering key; defaults to `createdSec`. */
  subCreatedSec?: number;
  periodEndSec?: number;
  unitAmount?: number;
}

/** A clover-shaped `customer.subscription.*` event (period end lives on ITEMS). */
function subscriptionEvent(args: SubEventArgs): { id: string; payload: string } {
  const id = args.id ?? uniqueEventId();
  const event = {
    id,
    object: 'event',
    type: args.type,
    created: args.createdSec,
    data: {
      object: {
        id: args.subId,
        object: 'subscription',
        customer: args.customerId,
        status: args.status,
        cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
        created: args.subCreatedSec ?? args.createdSec,
        items: {
          data: [
            {
              current_period_end: args.periodEndSec ?? FUTURE_PERIOD_END_SEC,
              price: {
                id: 'price_pro_test',
                unit_amount: args.unitAmount ?? 1000,
                currency: 'usd',
              },
            },
          ],
        },
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

/** A clover invoice event — the subscription id lives at `parent.subscription_details`. */
function invoiceEvent(args: {
  id?: string;
  type: 'invoice.paid' | 'invoice.payment_failed';
  subId: string;
  createdSec: number;
}): { id: string; payload: string } {
  const id = args.id ?? uniqueEventId('inv');
  const event = {
    id,
    object: 'event',
    type: args.type,
    created: args.createdSec,
    data: {
      object: {
        id: `in_${id}`,
        object: 'invoice',
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: args.subId },
        },
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

/** A subscription-mode Checkout session event (a real Pro purchase carries NO credit metadata). */
function subscriptionCheckoutEvent(args: {
  id?: string;
  type?: 'checkout.session.completed' | 'checkout.session.async_payment_succeeded';
  subscription?: string | null;
}): { id: string; payload: string } {
  const id = args.id ?? uniqueEventId('cs');
  const event = {
    id,
    object: 'event',
    type: args.type ?? 'checkout.session.completed',
    created: NOW_SEC,
    data: {
      object: {
        id: `cs_${id}`,
        object: 'checkout.session',
        mode: 'subscription',
        payment_status: 'paid',
        amount_total: 1000,
        currency: 'usd',
        subscription: args.subscription ?? null,
        metadata: {},
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

/** A payment-mode credit-pack event — the SAME shape `createCheckoutSession` produces. */
function creditCheckoutEvent(args: {
  id?: string;
  userId: string;
  creditGrant: string;
  expectedAmountMinor: string;
  amountTotal?: number | null;
}): { id: string; payload: string } {
  const id = args.id ?? uniqueEventId('cp');
  const event = {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    created: NOW_SEC,
    data: {
      object: {
        id: `cs_${id}`,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        amount_total:
          args.amountTotal === undefined ? Number(args.expectedAmountMinor) : args.amountTotal,
        currency: 'usd',
        payment_intent: `pi_${id}`,
        metadata: {
          userId: args.userId,
          packId: 'pack_test',
          creditGrant: args.creditGrant,
          expectedAmountMinor: args.expectedAmountMinor,
          expectedCurrency: 'usd',
        },
      },
    },
  };
  return { id, payload: JSON.stringify(event) };
}

// --- DB assertion helpers -------------------------------------------------------

async function webhookRow(eventId: string) {
  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, eventId));
  return row;
}

async function subRow(subId: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subId));
  return row;
}

async function tierOf(userId: string): Promise<'free' | 'pro'> {
  const { tier } = await resolveTier(db, userId);
  return tier;
}

/** Count ALL wallet_transactions rows for a user (credit-path-untouched assertions). */
async function countCredits(userId: string): Promise<number> {
  const rows = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId));
  return rows.length;
}

function capturedEvents(): string[] {
  return vi.mocked(captureServerEvent).mock.calls.map(([name]) => String(name));
}

// ===========================================================================
// Lifecycle → tier state machine (REQ-3.2, REQ-3.3)
// ===========================================================================

describe('POST /api/billing/webhook — subscription lifecycle & tier state machine', () => {
  it('customer.subscription.created(active) flips the resolved tier free→pro (recorded processed)', async () => {
    const { userId, customerId } = await createLinkedUser();
    expect(await tierOf(userId)).toBe('free');

    const subId = uniqueSubId();
    const evt = subscriptionEvent({
      type: 'customer.subscription.created',
      subId,
      customerId,
      status: 'active',
      createdSec: NOW_SEC - 60,
    });

    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('acked');

    expect(await tierOf(userId)).toBe('pro');
    expect((await webhookRow(evt.id))!.status).toBe('processed');

    const row = await subRow(subId);
    expect(row!.status).toBe('active');
    expect(row!.priceUnitAmount).toBe(1000);

    // D17 analytics ran post-commit through the guarded effects executor.
    expect(capturedEvents()).toContain('subscription_activated');
  });

  it('replaying the same event id changes nothing (duplicate ack, no re-processing)', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    const evt = subscriptionEvent({
      type: 'customer.subscription.created',
      subId,
      customerId,
      status: 'active',
      createdSec: NOW_SEC - 60,
    });

    const first = await postWebhook(evt.payload);
    expect((await first.json()).outcome).toBe('acked');
    const before = await subRow(subId);

    const second = await postWebhook(evt.payload);
    expect(second.status).toBe(200);
    expect((await second.json()).outcome).toBe('duplicate');

    const after = await subRow(subId);
    expect(after!.status).toBe(before!.status);
    expect(after!.lastEventCreated.getTime()).toBe(before!.lastEventCreated.getTime());
    expect(await tierOf(userId)).toBe('pro');

    // Analytics fired once — the duplicate claim never re-runs effects.
    expect(capturedEvents().filter((n) => n === 'subscription_activated')).toHaveLength(1);
  });

  it('out-of-order ≠ replay: a strictly-older event is skipped (`ignored`), never resurrects, and the skip-case re-fetch cannot lower the watermark (regression)', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    const T0 = NOW_SEC - 200;
    const T2 = NOW_SEC - 100;

    // e1: created(active) at T0 → pro.
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        createdSec: T0,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('pro');

    // e2: deleted(canceled) at T2 → free; watermark = T2.
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.deleted',
        subId,
        customerId,
        status: 'canceled',
        createdSec: T2,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('free');

    // Authoritative re-fetch for the skip case: Stripe says canceled, with a
    // distinguishable price snapshot so the CAS heal is observable.
    const stub = makeStripeStub();
    stub.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      customer: customerId,
      status: 'canceled',
      cancel_at_period_end: false,
      created: T0,
      items: {
        data: [
          {
            current_period_end: FUTURE_PERIOD_END_SEC,
            price: { id: 'price_pro_test', unit_amount: 1500, currency: 'usd' },
          },
        ],
      },
    });
    stripeStubHolder.current = stub;

    // e3: a LATE stale updated(active) at T1 < T2 — distinct event id, so it is
    // NOT a duplicate; the D1 guard must skip it (recorded `ignored`).
    const e3 = subscriptionEvent({
      type: 'customer.subscription.updated',
      subId,
      customerId,
      status: 'active',
      createdSec: T2 - 50,
    });
    const res3 = await postWebhook(e3.payload);
    expect(res3.status).toBe(200);
    expect((await webhookRow(e3.id))!.status).toBe('ignored');

    let row = await subRow(subId);
    expect(row!.status).toBe('canceled'); // never resurrected
    expect(row!.priceUnitAmount).toBe(1500); // the re-fetch heal APPLIED (CAS)
    expect(row!.lastEventCreated.getTime()).toBe(T2 * 1000); // watermark NOT lowered
    expect(stub.subscriptions.retrieve).toHaveBeenCalledWith(subId);
    expect(await tierOf(userId)).toBe('free');

    // Regression: a SUBSEQUENT stale event (T1 < T1.5 < T2) must still be
    // skipped — if the skip-case re-fetch had regressed the watermark, this
    // event would apply and resurrect the canceled subscription.
    const e4 = subscriptionEvent({
      type: 'customer.subscription.updated',
      subId,
      customerId,
      status: 'active',
      createdSec: T2 - 20,
    });
    await postWebhook(e4.payload);
    expect((await webhookRow(e4.id))!.status).toBe('ignored');

    row = await subRow(subId);
    expect(row!.status).toBe('canceled');
    expect(row!.lastEventCreated.getTime()).toBe(T2 * 1000);
    expect(await tierOf(userId)).toBe('free');
  });

  it('a same-second tie applies in arrival order (Stripe unconfigured — heal skipped)', async () => {
    const { customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    const T = NOW_SEC - 60;

    // stripeStubHolder.current stays null: the tie re-fetch warns + skips, so
    // the row shows the pure arrival-order semantics.
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        cancelAtPeriodEnd: false,
        createdSec: T,
      }).payload,
    );
    const tie = subscriptionEvent({
      type: 'customer.subscription.updated',
      subId,
      customerId,
      status: 'active',
      cancelAtPeriodEnd: true,
      createdSec: T, // same epoch second — the D1 tie
    });
    await postWebhook(tie.payload);

    const row = await subRow(subId);
    expect((await webhookRow(tie.id))!.status).toBe('processed'); // applied, NOT ignored
    expect(row!.cancelAtPeriodEnd).toBe(true); // last-writer-wins in arrival order
    expect(row!.lastEventCreated.getTime()).toBe(T * 1000);
  });

  it('a same-second tie enqueues the authoritative re-fetch, which upserts via CAS with a monotone watermark', async () => {
    const { customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    const T = NOW_SEC - 60;

    const stub = makeStripeStub();
    stub.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      customer: customerId,
      status: 'active',
      cancel_at_period_end: true,
      created: T,
      items: {
        data: [
          {
            current_period_end: FUTURE_PERIOD_END_SEC,
            price: { id: 'price_pro_test', unit_amount: 1234, currency: 'usd' },
          },
        ],
      },
    });
    stripeStubHolder.current = stub;

    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        createdSec: T,
      }).payload,
    );
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'active',
        cancelAtPeriodEnd: true,
        createdSec: T,
      }).payload,
    );

    expect(stub.subscriptions.retrieve).toHaveBeenCalledWith(subId);
    const row = await subRow(subId);
    expect(row!.priceUnitAmount).toBe(1234); // the authoritative snapshot landed
    expect(row!.cancelAtPeriodEnd).toBe(true);
    expect(row!.lastEventCreated.getTime()).toBe(T * 1000); // GREATEST kept it monotone
  });

  it('updated(cancel_at_period_end=true) → canceled-pending; Portal renew flips it back (REQ-4.3)', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();

    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 300,
      }).payload,
    );

    // Portal cancel arrives as updated(cancel_at_period_end=true) — Pro persists
    // until period end (the resolver ignores the flag).
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'active',
        cancelAtPeriodEnd: true,
        createdSec: NOW_SEC - 200,
      }).payload,
    );
    let row = await subRow(subId);
    expect(row!.cancelAtPeriodEnd).toBe(true);
    expect(row!.status).toBe('active');
    expect(await tierOf(userId)).toBe('pro');
    expect(capturedEvents()).toContain('subscription_cancel_scheduled');

    // Portal renew reverses it before period end — Pro continues uninterrupted.
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'active',
        cancelAtPeriodEnd: false,
        createdSec: NOW_SEC - 100,
      }).payload,
    );
    row = await subRow(subId);
    expect(row!.cancelAtPeriodEnd).toBe(false);
    expect(await tierOf(userId)).toBe('pro');
  });

  it('deleted → free with data intact (soft downgrade, REQ-3.4)', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();

    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 120,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('pro');

    const del = subscriptionEvent({
      type: 'customer.subscription.deleted',
      subId,
      customerId,
      status: 'canceled',
      createdSec: NOW_SEC - 60,
    });
    await postWebhook(del.payload);

    expect(await tierOf(userId)).toBe('free');
    expect((await webhookRow(del.id))!.status).toBe('processed');

    // Data intact: the mirror row persists (nothing deleted), the user row and
    // linkage survive — re-subscribing needs no restoration step.
    const row = await subRow(subId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('canceled');
    const [userRow] = await db.select().from(users).where(eq(users.id, userId));
    expect(userRow).toBeDefined();
    expect(capturedEvents()).toContain('subscription_ended');
  });
});

// ===========================================================================
// Dunning — past-due grace, anchors, and both recovery orders (REQ-3.3, REQ-3.5)
// ===========================================================================

describe('POST /api/billing/webhook — dunning & recovery', () => {
  /** Seed an `active` row whose period end has lapsed beyond the 72 h slack. */
  async function seedLapsedActive(customerId: string, subId: string, createdSec: number) {
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        createdSec,
        periodEndSec: NOW_SEC - 4 * DAY_SEC,
      }).payload,
    );
  }

  it('updated(past_due) → past-due grace: Pro retained from the dunning anchor, not the lapsed period end', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    await seedLapsedActive(customerId, subId, NOW_SEC - 5 * DAY_SEC);
    expect(await tierOf(userId)).toBe('free'); // lapsed active confers nothing

    const evt = subscriptionEvent({
      type: 'customer.subscription.updated',
      subId,
      customerId,
      status: 'past_due',
      createdSec: NOW_SEC - 60,
      periodEndSec: NOW_SEC - 4 * DAY_SEC,
    });
    await postWebhook(evt.payload);

    const row = await subRow(subId);
    expect(row!.status).toBe('past_due');
    expect(row!.enteredPastDueAt!.getTime()).toBe((NOW_SEC - 60) * 1000);
    expect(await tierOf(userId)).toBe('pro'); // grace under the 28-day horizon
    expect(capturedEvents()).toContain('subscription_payment_failed');
  });

  it('invoice.payment_failed re-anchors a null-anchor past_due row (set-if-null backstop)', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    await seedLapsedActive(customerId, subId, NOW_SEC - 5 * DAY_SEC);
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'past_due',
        createdSec: NOW_SEC - 120,
        periodEndSec: NOW_SEC - 4 * DAY_SEC,
      }).payload,
    );

    // Simulate the corrupt row the backstop exists for: null the anchor.
    await db
      .update(subscriptions)
      .set({ enteredPastDueAt: null })
      .where(eq(subscriptions.stripeSubscriptionId, subId));
    expect(await tierOf(userId)).toBe('free'); // null anchor fails CLOSED

    const evt = invoiceEvent({ type: 'invoice.payment_failed', subId, createdSec: NOW_SEC - 30 });
    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(200);
    expect((await webhookRow(evt.id))!.status).toBe('processed');

    const row = await subRow(subId);
    expect(row!.enteredPastDueAt!.getTime()).toBe((NOW_SEC - 30) * 1000);
    expect(await tierOf(userId)).toBe('pro');
  });

  it('invoice.paid on a still-past_due row RE-ANCHORS — the horizon restarts and Pro is retained', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    await seedLapsedActive(customerId, subId, NOW_SEC - 30 * DAY_SEC);

    // Entered past_due 29 days ago — beyond the 28-day horizon ⇒ free.
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'past_due',
        createdSec: NOW_SEC - 29 * DAY_SEC,
        periodEndSec: NOW_SEC - 25 * DAY_SEC,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('free');

    // A paid renewal lands while the recovery `updated(active)` is lost/late:
    // the anchor ADVANCES to the invoice event's created — horizon restarts.
    const paid = invoiceEvent({ type: 'invoice.paid', subId, createdSec: NOW_SEC - 10 });
    await postWebhook(paid.payload);
    expect((await webhookRow(paid.id))!.status).toBe('processed');

    const row = await subRow(subId);
    expect(row!.status).toBe('past_due'); // raw mirror untouched by the anchor write
    expect(row!.enteredPastDueAt!.getTime()).toBe((NOW_SEC - 10) * 1000);
    expect(await tierOf(userId)).toBe('pro'); // Pro retained to the re-anchored horizon
  });

  it('recovery order A — invoice.paid THEN updated(active): entitled at every step', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    await seedLapsedActive(customerId, subId, NOW_SEC - 5 * DAY_SEC);
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'past_due',
        createdSec: NOW_SEC - 90,
        periodEndSec: NOW_SEC - 4 * DAY_SEC,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('pro');

    await postWebhook(
      invoiceEvent({ type: 'invoice.paid', subId, createdSec: NOW_SEC - 60 }).payload,
    );
    expect((await subRow(subId))!.enteredPastDueAt!.getTime()).toBe((NOW_SEC - 60) * 1000);
    expect(await tierOf(userId)).toBe('pro'); // re-anchored, still past_due

    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 30,
        periodEndSec: FUTURE_PERIOD_END_SEC,
      }).payload,
    );
    const row = await subRow(subId);
    expect(row!.status).toBe('active');
    expect(row!.enteredPastDueAt).toBeNull(); // leaving past_due clears the anchor
    expect(await tierOf(userId)).toBe('pro');
  });

  it('recovery order B — updated(active) THEN invoice.paid: entitled at every step', async () => {
    const { userId, customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    await seedLapsedActive(customerId, subId, NOW_SEC - 5 * DAY_SEC);
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'past_due',
        createdSec: NOW_SEC - 90,
        periodEndSec: NOW_SEC - 4 * DAY_SEC,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('pro');

    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.updated',
        subId,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 60,
        periodEndSec: FUTURE_PERIOD_END_SEC,
      }).payload,
    );
    expect(await tierOf(userId)).toBe('pro');

    await postWebhook(
      invoiceEvent({ type: 'invoice.paid', subId, createdSec: NOW_SEC - 30 }).payload,
    );
    const row = await subRow(subId);
    expect(row!.status).toBe('active');
    expect(row!.enteredPastDueAt).toBeNull(); // clear-when-not-past_due (no-op here)
    expect(await tierOf(userId)).toBe('pro');
  });
});

// ===========================================================================
// Subscription-mode Checkout discrimination + canary (REQ-3.1, D5)
// ===========================================================================

describe('POST /api/billing/webhook — subscription-mode checkout discrimination (REQ-3.1)', () => {
  it('a subscription-mode completed session is recorded `processed` (never failed), touches no wallet, and emits the canary when unmirrored', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const { userId } = await createLinkedUser();
    const subId = uniqueSubId();
    const evt = subscriptionCheckoutEvent({ subscription: subId });

    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('acked');

    // A legitimate Pro purchase: `processed`, NEVER `failed` — the credit
    // trigger/metadata path was never reached despite the absent metadata.
    const row = await webhookRow(evt.id);
    expect(row!.status).toBe('processed');
    expect(row!.error).toBeNull();
    expect(await countCredits(userId)).toBe(0);
    expect(capturedEvents()).not.toContain('credits_purchased');

    // The misconfiguration canary: subscription present, no mirror row yet.
    const canary = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("verify the webhook endpoint's event registration"),
    );
    expect(canary).toHaveLength(1);
    expect(canary[0]![1]).toMatchObject({ stripeSubscriptionId: subId });
    warnSpy.mockRestore();
  });

  it('no canary when the subscription is already mirrored', async () => {
    const { customerId } = await createLinkedUser();
    const subId = uniqueSubId();
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 60,
      }).payload,
    );

    const warnSpy = vi.spyOn(logger, 'warn');
    const evt = subscriptionCheckoutEvent({ subscription: subId });
    await postWebhook(evt.payload);

    expect((await webhookRow(evt.id))!.status).toBe('processed');
    const canary = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("verify the webhook endpoint's event registration"),
    );
    expect(canary).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('a subscription-mode async_payment_succeeded is discriminated too', async () => {
    const evt = subscriptionCheckoutEvent({
      type: 'checkout.session.async_payment_succeeded',
      subscription: null,
    });
    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(200);
    expect((await webhookRow(evt.id))!.status).toBe('processed');
  });
});

// ===========================================================================
// Duplicate reconciliation (REQ-3.7, D7)
// ===========================================================================

describe('POST /api/billing/webhook — duplicate-subscription reconciliation (REQ-3.7)', () => {
  it('a second qualifying subscription is refunded FIRST, then canceled; the earliest-created survives', async () => {
    const { customerId } = await createLinkedUser();
    const subA = uniqueSubId('sub_a');
    const subB = uniqueSubId('sub_b');

    const stub = makeStripeStub();
    stub.invoices.list.mockResolvedValue({
      data: [
        {
          id: 'in_dup_1',
          payments: {
            data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_dup_1' } }],
          },
        },
      ],
    });
    stripeStubHolder.current = stub;

    // A first (earlier created), then the double-complete race lands B.
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId: subA,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 120,
        subCreatedSec: NOW_SEC - 120,
      }).payload,
    );
    expect(stub.subscriptions.cancel).not.toHaveBeenCalled(); // one row ⇒ no-op

    const res = await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId: subB,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 60,
        subCreatedSec: NOW_SEC - 60,
      }).payload,
    );
    expect(res.status).toBe(200);

    // Refund-before-cancel, against the DUPLICATE (B) only.
    expect(stub.invoices.list).toHaveBeenCalledWith({
      subscription: subB,
      status: 'paid',
      expand: ['data.payments'],
    });
    expect(stub.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_dup_1' });
    expect(stub.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stub.subscriptions.cancel).toHaveBeenCalledWith(subB);
    expect(stub.refunds.create.mock.invocationCallOrder[0]!).toBeLessThan(
      stub.subscriptions.cancel.mock.invocationCallOrder[0]!,
    );

    // The mirror is NOT locally rewritten — convergence arrives via the
    // duplicate's own cancellation webhooks (D7).
    expect((await subRow(subB))!.status).toBe('active');
  });

  it('charge_already_refunded is SUCCESS, and the re-run is idempotent — reconciliation fires even on a SKIPPED event', async () => {
    const { customerId } = await createLinkedUser();
    const subA = uniqueSubId('sub_a');
    const subB = uniqueSubId('sub_b');

    const stub = makeStripeStub();
    stub.invoices.list.mockResolvedValue({
      data: [
        {
          id: 'in_dup_2',
          payments: {
            data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_dup_2' } }],
          },
        },
      ],
    });
    // Already refunded on every attempt — the idempotency mechanism, not an error.
    stub.refunds.create.mockRejectedValue(stripeError('charge_already_refunded'));
    // First cancel succeeds; the re-run's cancel finds it gone — also done.
    stub.subscriptions.cancel
      .mockResolvedValueOnce({})
      .mockRejectedValue(stripeError('resource_missing'));
    // The skip-case re-fetch needs an authoritative snapshot.
    stub.subscriptions.retrieve.mockResolvedValue({
      id: subB,
      customer: customerId,
      status: 'active',
      cancel_at_period_end: false,
      created: NOW_SEC - 60,
      items: {
        data: [
          {
            current_period_end: FUTURE_PERIOD_END_SEC,
            price: { id: 'price_pro_test', unit_amount: 1000, currency: 'usd' },
          },
        ],
      },
    });
    stripeStubHolder.current = stub;

    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId: subA,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 120,
      }).payload,
    );
    await postWebhook(
      subscriptionEvent({
        type: 'customer.subscription.created',
        subId: subB,
        customerId,
        status: 'active',
        createdSec: NOW_SEC - 60,
      }).payload,
    );
    expect(stub.subscriptions.cancel).toHaveBeenCalledTimes(1); // refund "failure" was success

    // A STALE updated(B) — skipped by the D1 guard (`ignored`) — must STILL
    // fire the reconcile trigger (applied/tie/skipped alike).
    const stale = subscriptionEvent({
      type: 'customer.subscription.updated',
      subId: subB,
      customerId,
      status: 'active',
      createdSec: NOW_SEC - 90, // older than B's watermark (NOW-60)
    });
    const res = await postWebhook(stale.payload);
    expect(res.status).toBe(200);
    expect((await webhookRow(stale.id))!.status).toBe('ignored');

    expect(stub.refunds.create).toHaveBeenCalledTimes(2); // re-attempted, idempotent
    expect(stub.subscriptions.cancel).toHaveBeenCalledTimes(2); // resource_missing = done
    expect(stub.subscriptions.cancel).toHaveBeenNthCalledWith(2, subB);
  });

  it('same-second creations pick a DETERMINISTIC survivor via the stripe_subscription_id tiebreak — both arrival orders', async () => {
    const T = NOW_SEC - 60;

    // Arrival order 1: the higher id lands first.
    {
      const { customerId } = await createLinkedUser();
      const stub = makeStripeStub();
      stripeStubHolder.current = stub;
      const zFirst = `sub_z_${Date.now()}_${++idCounter}`;
      const aSecond = `sub_a_${Date.now()}_${++idCounter}`;

      await postWebhook(
        subscriptionEvent({
          type: 'customer.subscription.created',
          subId: zFirst,
          customerId,
          status: 'active',
          createdSec: T,
          subCreatedSec: T, // same epoch second as the sibling
        }).payload,
      );
      await postWebhook(
        subscriptionEvent({
          type: 'customer.subscription.created',
          subId: aSecond,
          customerId,
          status: 'active',
          createdSec: T + 1,
          subCreatedSec: T,
        }).payload,
      );

      // Survivor = ascending (stripe_created_at, stripe_subscription_id):
      // 'sub_a…' < 'sub_z…' ⇒ the z subscription is the duplicate.
      expect(stub.subscriptions.cancel).toHaveBeenCalledTimes(1);
      expect(stub.subscriptions.cancel).toHaveBeenCalledWith(zFirst);
    }

    // Arrival order 2: the lower id lands first — the survivor is UNCHANGED.
    {
      const { customerId } = await createLinkedUser();
      const stub = makeStripeStub();
      stripeStubHolder.current = stub;
      const aFirst = `sub_a_${Date.now()}_${++idCounter}`;
      const zSecond = `sub_z_${Date.now()}_${++idCounter}`;

      await postWebhook(
        subscriptionEvent({
          type: 'customer.subscription.created',
          subId: aFirst,
          customerId,
          status: 'active',
          createdSec: T,
          subCreatedSec: T,
        }).payload,
      );
      await postWebhook(
        subscriptionEvent({
          type: 'customer.subscription.created',
          subId: zSecond,
          customerId,
          status: 'active',
          createdSec: T + 1,
          subCreatedSec: T,
        }).payload,
      );

      expect(stub.subscriptions.cancel).toHaveBeenCalledTimes(1);
      expect(stub.subscriptions.cancel).toHaveBeenCalledWith(zSecond);
    }
  });
});

// ===========================================================================
// Credit-pack regression — byte-identical behaviour + post-commit capture
// (REQ-13.2)
// ===========================================================================

describe('POST /api/billing/webhook — credit-pack regression & post-commit capture', () => {
  it('a payment-mode completed+paid session credits exactly once; credits_purchased is captured post-commit', async () => {
    const userId = await createUser();
    const evt = creditCheckoutEvent({
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
    });

    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('credited');

    expect(await countCredits(userId)).toBe(1);
    expect((await webhookRow(evt.id))!.status).toBe('processed');

    // REQ-13.2: emitted through the post-commit effects list (once, committed).
    expect(vi.mocked(captureServerEvent)).toHaveBeenCalledWith(
      'credits_purchased',
      expect.objectContaining({ distinctId: userId }),
    );
    expect(capturedEvents().filter((n) => n === 'credits_purchased')).toHaveLength(1);
  });

  it('duplicate delivery still credits exactly once and captures exactly once', async () => {
    const userId = await createUser();
    const evt = creditCheckoutEvent({
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
    });

    await postWebhook(evt.payload);
    const replay = await postWebhook(evt.payload);
    expect((await replay.json()).outcome).toBe('duplicate');

    expect(await countCredits(userId)).toBe(1);
    expect(capturedEvents().filter((n) => n === 'credits_purchased')).toHaveLength(1);
  });

  it('a definitive mismatch is still refused-and-recorded `failed` — and NOTHING is captured', async () => {
    const userId = await createUser();
    const evt = creditCheckoutEvent({
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      amountTotal: 499,
    });

    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('refused');

    expect(await countCredits(userId)).toBe(0);
    expect((await webhookRow(evt.id))!.status).toBe('failed');
    expect(capturedEvents()).not.toContain('credits_purchased');
  });

  it('a transient verify-failure still returns a retryable 5xx with NO row and NO capture', async () => {
    const userId = await createUser();
    const evt = creditCheckoutEvent({
      userId,
      creditGrant: '1000000',
      expectedAmountMinor: '500',
      amountTotal: null,
    });

    const res = await postWebhook(evt.payload);
    expect(res.status).toBe(500);
    expect((await res.json()).outcome).toBe('retry');

    expect(await countCredits(userId)).toBe(0);
    expect(await webhookRow(evt.id)).toBeUndefined();
    expect(capturedEvents()).not.toContain('credits_purchased');
  });
});
