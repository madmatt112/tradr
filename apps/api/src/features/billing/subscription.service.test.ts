import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Transaction } from '@/db';

// Unit tests for the subscription service (plan-tiers design Component 4):
// D2 customer linkage, D8 subscription Checkout, D15 Portal, D6 mirror
// application, D1 re-fetch effect, D17 transition analytics, D7 duplicate
// reconciliation. Stripe is mocked at the `stripe-client.ts` seam; the query
// layer is an in-memory fake replicating Task 5's live-PG-verified semantics
// (guarded upsert, monotone watermark, CAS, invoice anchors) so the service's
// orchestration can be driven through real interleavings DB-free. The
// DB-backed integration pass is Task 8's `subscription.webhook.test.ts`.

/** One in-memory mirror row (the `subscriptions` $inferSelect shape). */
interface FakeRow {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date;
  priceId: string | null;
  priceUnitAmount: number | null;
  priceCurrency: string | null;
  stripeCreatedAt: Date;
  enteredPastDueAt: Date | null;
  lastEventCreated: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** The extraction output + userId (SubscriptionMirror's shape). */
interface FakeMirror {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date;
  priceId: string | null;
  priceUnitAmount: number | null;
  priceCurrency: string | null;
  stripeCreatedAt: Date;
}

const mocks = vi.hoisted(() => {
  const rows = new Map<string, FakeRow>();
  const links = new Map<string, { userId: string; stripeCustomerId: string }>();
  const clone = (row: FakeRow): FakeRow => ({ ...row });

  return {
    rows,
    links,
    getStripeClient: vi.fn(),
    selectBillingCustomerByUser: vi.fn(),
    insertBillingCustomerLink: vi.fn(),
    resolveTier: vi.fn(),
    isProSubscriptionConfigured: vi.fn(),
    isStripeConfigured: vi.fn(() => true),
    isFeatureGatingEnabled: vi.fn(() => true),
    captureServerEvent: vi.fn(),
    recordWebhookOutcome: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (_db: unknown, cb: (tx: unknown) => Promise<unknown>) => cb({})),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {
      STRIPE_PRO_PRICE_ID: 'price_pro_123' as string | undefined,
      // Loaded at module init by the REAL ./pricing chain (tier.query →
      // tier-limits.constants → pricing), pulled in via importOriginal below.
      PRICING_MARKUP: '1',
      FEATURE_GATING_ADVISOR_TURNS_PER_MONTH: 200,
    },

    // --- in-memory fake of Task 5's subscription.query semantics -------------
    selectBillingCustomerByStripeCustomerId: vi.fn(
      async (_db: unknown, cusId: string) => links.get(cusId) ?? null,
    ),
    selectSubscriptionByStripeId: vi.fn(async (_db: unknown, subId: string) => {
      const row = rows.get(subId);
      return row ? clone(row) : null;
    }),
    selectSubscriptionsByUser: vi.fn(async (_db: unknown, userId: string) =>
      [...rows.values()].filter((row) => row.userId === userId).map(clone),
    ),
    upsertSubscriptionMirror: vi.fn(
      async (_tx: unknown, mirror: FakeMirror, eventCreated: Date) => {
        const existing = rows.get(mirror.stripeSubscriptionId);
        if (!existing) {
          rows.set(mirror.stripeSubscriptionId, {
            id: `row_${mirror.stripeSubscriptionId}`,
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
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          return { outcome: 'inserted', tie: false, lastEventCreated: eventCreated };
        }
        if (eventCreated.getTime() < existing.lastEventCreated.getTime()) {
          return { outcome: 'skipped', tie: false, lastEventCreated: existing.lastEventCreated };
        }
        const tie = eventCreated.getTime() === existing.lastEventCreated.getTime();
        existing.enteredPastDueAt =
          mirror.status === 'past_due'
            ? existing.status === 'past_due'
              ? existing.enteredPastDueAt
              : eventCreated
            : null;
        existing.status = mirror.status;
        existing.cancelAtPeriodEnd = mirror.cancelAtPeriodEnd;
        existing.currentPeriodEnd = mirror.currentPeriodEnd;
        existing.priceId = mirror.priceId;
        existing.priceUnitAmount = mirror.priceUnitAmount;
        existing.priceCurrency = mirror.priceCurrency;
        existing.lastEventCreated = new Date(
          Math.max(existing.lastEventCreated.getTime(), eventCreated.getTime()),
        );
        return { outcome: 'applied', tie, lastEventCreated: eventCreated };
      },
    ),
    applyRefetchedSubscriptionMirror: vi.fn(
      async (
        _tx: unknown,
        mirror: FakeMirror,
        args: { expectedLastEventCreated: Date; triggeringEventCreated: Date },
      ) => {
        const existing = rows.get(mirror.stripeSubscriptionId);
        if (
          !existing ||
          existing.lastEventCreated.getTime() !== args.expectedLastEventCreated.getTime()
        ) {
          return 'superseded';
        }
        existing.enteredPastDueAt =
          mirror.status === 'past_due'
            ? existing.status === 'past_due'
              ? existing.enteredPastDueAt
              : args.triggeringEventCreated
            : null;
        existing.status = mirror.status;
        existing.cancelAtPeriodEnd = mirror.cancelAtPeriodEnd;
        existing.currentPeriodEnd = mirror.currentPeriodEnd;
        existing.priceId = mirror.priceId;
        existing.priceUnitAmount = mirror.priceUnitAmount;
        existing.priceCurrency = mirror.priceCurrency;
        existing.lastEventCreated = new Date(
          Math.max(existing.lastEventCreated.getTime(), args.triggeringEventCreated.getTime()),
        );
        return 'applied';
      },
    ),
    applyInvoicePaidAnchor: vi.fn(
      async (_tx: unknown, stripeSubscriptionId: string, eventCreated: Date) => {
        const existing = rows.get(stripeSubscriptionId);
        if (!existing) return false;
        existing.enteredPastDueAt = existing.status === 'past_due' ? eventCreated : null;
        return true;
      },
    ),
    applyInvoicePaymentFailedAnchor: vi.fn(
      async (_tx: unknown, stripeSubscriptionId: string, eventCreated: Date) => {
        const existing = rows.get(stripeSubscriptionId);
        if (!existing || existing.status !== 'past_due' || existing.enteredPastDueAt !== null) {
          return false;
        }
        existing.enteredPastDueAt = eventCreated;
        return true;
      },
    ),
  };
});

vi.mock('./stripe-client', () => ({ getStripeClient: mocks.getStripeClient }));

vi.mock('./subscription.query', () => ({
  selectBillingCustomerByUser: mocks.selectBillingCustomerByUser,
  insertBillingCustomerLink: mocks.insertBillingCustomerLink,
  selectBillingCustomerByStripeCustomerId: mocks.selectBillingCustomerByStripeCustomerId,
  selectSubscriptionByStripeId: mocks.selectSubscriptionByStripeId,
  selectSubscriptionsByUser: mocks.selectSubscriptionsByUser,
  upsertSubscriptionMirror: mocks.upsertSubscriptionMirror,
  applyRefetchedSubscriptionMirror: mocks.applyRefetchedSubscriptionMirror,
  applyInvoicePaidAnchor: mocks.applyInvoicePaidAnchor,
  applyInvoicePaymentFailedAnchor: mocks.applyInvoicePaymentFailedAnchor,
}));

// Real predicates (subscriptionQualifies / compareSubscriptionOrder / deriveTier)
// so reconciliation and entitlement assertions exercise the ONE authoritative
// implementation; only the DB-touching resolveTier is stubbed.
vi.mock('./tier.query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tier.query')>();
  return { ...actual, resolveTier: mocks.resolveTier };
});

// Real billing.query module (billing.service pulls many names from it), with
// only the webhook-outcome write stubbed.
vi.mock('./billing.query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./billing.query')>();
  return { ...actual, recordWebhookOutcome: mocks.recordWebhookOutcome };
});

vi.mock('@/lib/config', () => ({
  config: mocks.config,
  isProSubscriptionConfigured: mocks.isProSubscriptionConfigured,
  isStripeConfigured: mocks.isStripeConfigured,
  isFeatureGatingEnabled: mocks.isFeatureGatingEnabled,
}));

vi.mock('@/lib/posthog', () => ({ captureServerEvent: mocks.captureServerEvent }));

vi.mock('@/lib/logger', () => ({ logger: mocks.logger }));

vi.mock('@/lib/transaction', () => ({ withTransaction: mocks.withTransaction }));

vi.mock('@/db', () => ({ db: {} }));

import {
  applySubscriptionEvent,
  createPortalSession,
  createSubscriptionCheckout,
  ensureBillingCustomer,
  extractSubscriptionMirror,
  reconcileDuplicateSubscriptions,
  type PostCommitEffect,
} from './subscription.service';
import { subscriptionQualifies } from './tier.query';

const ORIGIN = 'https://app.example';
const TX = {} as Transaction;

// Event times sit in the recent past; period ends in the future so `active`
// rows qualify under the real predicate.
const NOW_SEC = Math.floor(Date.now() / 1000);
const BASE_SEC = NOW_SEC - 3600;
const FUTURE = new Date((NOW_SEC + 30 * 24 * 3600) * 1000);

interface FakeSubOverrides {
  id?: string;
  customer?: unknown;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  cancelAtSec?: number | null;
  createdSec?: number;
  items?: unknown[];
}

/** A minimal clover-shaped Stripe subscription (period end lives on ITEMS). */
function fakeSub(over: FakeSubOverrides = {}): Stripe.Subscription {
  return {
    id: over.id ?? 'sub_1',
    customer: over.customer ?? 'cus_1',
    status: over.status ?? 'active',
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    cancel_at: over.cancelAtSec ?? null,
    created: over.createdSec ?? BASE_SEC,
    items: {
      data: over.items ?? [
        {
          current_period_end: Math.floor(FUTURE.getTime() / 1000),
          price: { id: 'price_pro_123', unit_amount: 1000, currency: 'usd' },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

let eventSeq = 0;

function subEvent(
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  sub: Stripe.Subscription,
  createdSec: number,
): Stripe.Event {
  return {
    id: `evt_${++eventSeq}`,
    type,
    created: createdSec,
    data: { object: sub },
  } as unknown as Stripe.Event;
}

/** Clover invoice event: the subscription id lives at parent.subscription_details. */
function invoiceEvent(
  type: 'invoice.paid' | 'invoice.payment_failed',
  subscriptionId: string | null,
  createdSec: number,
): Stripe.Event {
  return {
    id: `evt_${++eventSeq}`,
    type,
    created: createdSec,
    data: {
      object: {
        parent: subscriptionId
          ? {
              type: 'subscription_details',
              subscription_details: { subscription: subscriptionId },
            }
          : null,
      },
    },
  } as unknown as Stripe.Event;
}

function seedRow(over: Partial<FakeRow> & { stripeSubscriptionId: string }): FakeRow {
  const base = new Date(BASE_SEC * 1000);
  const row: FakeRow = {
    id: `row_${over.stripeSubscriptionId}`,
    userId: 'u1',
    stripeCustomerId: 'cus_1',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: FUTURE,
    priceId: 'price_pro_123',
    priceUnitAmount: 1000,
    priceCurrency: 'usd',
    stripeCreatedAt: base,
    enteredPastDueAt: null,
    lastEventCreated: base,
    createdAt: base,
    updatedAt: base,
    ...over,
  };
  mocks.rows.set(row.stripeSubscriptionId, row);
  return row;
}

function effectKinds(effects: PostCommitEffect[]): string[] {
  return effects.map((effect) => effect.kind);
}

async function runEffects(effects: PostCommitEffect[], kind?: PostCommitEffect['kind']) {
  for (const effect of effects) {
    if (!kind || effect.kind === kind) await effect.run();
  }
}

function paidInvoice(id: string, payments: unknown[]) {
  return { id, payments: { data: payments } };
}

function piPayment(paymentIntent: unknown) {
  return { payment: { type: 'payment_intent', payment_intent: paymentIntent } };
}

/** A fresh fake Stripe client exposing only the surfaces the service touches. */
function stripeStub() {
  return {
    customers: { create: vi.fn().mockResolvedValue({ id: 'cus_new' }) },
    checkout: {
      sessions: { create: vi.fn().mockResolvedValue({ url: 'https://stripe.test/session' }) },
    },
    billingPortal: {
      sessions: { create: vi.fn().mockResolvedValue({ url: 'https://stripe.test/portal' }) },
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue(fakeSub()),
      cancel: vi.fn().mockResolvedValue({ status: 'canceled' }),
    },
    invoices: { list: vi.fn().mockResolvedValue({ data: [] }) },
    refunds: { create: vi.fn().mockResolvedValue({ id: 're_1' }) },
  };
}

let stripe: ReturnType<typeof stripeStub>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.links.clear();
  mocks.links.set('cus_1', { userId: 'u1', stripeCustomerId: 'cus_1' });
  stripe = stripeStub();
  mocks.getStripeClient.mockReturnValue(stripe);
  mocks.isProSubscriptionConfigured.mockReturnValue(true);
  mocks.config.STRIPE_PRO_PRICE_ID = 'price_pro_123';
  mocks.resolveTier.mockResolvedValue({ tier: 'free', qualifying: null });
  mocks.selectBillingCustomerByUser.mockResolvedValue(null);
  mocks.insertBillingCustomerLink.mockImplementation(
    (_db: unknown, userId: string, stripeCustomerId: string) =>
      Promise.resolve({ link: { userId, stripeCustomerId }, created: true }),
  );
});

// --- ensureBillingCustomer (D2) ----------------------------------------------

describe('ensureBillingCustomer — persisted linkage is the unique source of reuse', () => {
  it('reuses an existing linkage without any Stripe call', async () => {
    mocks.selectBillingCustomerByUser.mockResolvedValue({
      userId: 'u1',
      stripeCustomerId: 'cus_existing',
    });

    const link = await ensureBillingCustomer('u1');

    expect(link).toEqual({ userId: 'u1', stripeCustomerId: 'cus_existing' });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(mocks.insertBillingCustomerLink).not.toHaveBeenCalled();
  });

  it('creates the Stripe Customer then inserts the linkage when none exists', async () => {
    const link = await ensureBillingCustomer('u1');

    expect(stripe.customers.create).toHaveBeenCalledWith({ metadata: { userId: 'u1' } });
    expect(mocks.insertBillingCustomerLink).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'cus_new',
    );
    expect(link).toEqual({ userId: 'u1', stripeCustomerId: 'cus_new' });
  });

  it('reuses the concurrent winner’s linkage when the insert did not win (lost race)', async () => {
    // Ours created `cus_new`, but a concurrent request linked `cus_winner`
    // first — the PK conflict lost, so ours orphans unlinked in Stripe (REQ-2.5).
    mocks.insertBillingCustomerLink.mockResolvedValue({
      link: { userId: 'u1', stripeCustomerId: 'cus_winner' },
      created: false,
    });

    const link = await ensureBillingCustomer('u1');

    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(link).toEqual({ userId: 'u1', stripeCustomerId: 'cus_winner' });
  });

  it('refuses BILLING_NOT_AVAILABLE when Stripe is unconfigured and no linkage exists', async () => {
    mocks.getStripeClient.mockReturnValue(null);

    await expect(ensureBillingCustomer('u1')).rejects.toMatchObject({
      statusCode: 402,
      code: 'BILLING_NOT_AVAILABLE',
    });
    expect(mocks.insertBillingCustomerLink).not.toHaveBeenCalled();
  });
});

// --- createSubscriptionCheckout (D8) -----------------------------------------

describe('createSubscriptionCheckout — refusal branches', () => {
  it('refuses 402 BILLING_NOT_AVAILABLE when the Pro subscription is unconfigured', async () => {
    mocks.isProSubscriptionConfigured.mockReturnValue(false);

    await expect(createSubscriptionCheckout('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 402,
      code: 'BILLING_NOT_AVAILABLE',
    });
    // Refused BEFORE any tier read or Stripe call.
    expect(mocks.resolveTier).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('refuses 409 SUBSCRIPTION_EXISTS for a qualifying active subscription (REQ-2.4)', async () => {
    mocks.resolveTier.mockResolvedValue({
      tier: 'pro',
      qualifying: { status: 'active', cancelAtPeriodEnd: false },
    });

    await expect(createSubscriptionCheckout('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUBSCRIPTION_EXISTS',
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('refuses 409 for a qualifying past_due subscription (dunning keeps Pro, REQ-2.4)', async () => {
    mocks.resolveTier.mockResolvedValue({
      tier: 'pro',
      qualifying: { status: 'past_due', cancelAtPeriodEnd: false },
    });

    await expect(createSubscriptionCheckout('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUBSCRIPTION_EXISTS',
    });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('refuses 409 for canceled-pending-period-end (still active until period end)', async () => {
    // Stripe keeps status 'active' with cancel_at_period_end until the period
    // lapses — the resolver still derives pro, so the pre-check refuses.
    mocks.resolveTier.mockResolvedValue({
      tier: 'pro',
      qualifying: { status: 'active', cancelAtPeriodEnd: true },
    });

    await expect(createSubscriptionCheckout('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUBSCRIPTION_EXISTS',
    });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('fails 502 CHECKOUT_FAILED when Stripe returns no URL (no analytics capture)', async () => {
    stripe.checkout.sessions.create.mockResolvedValue({ url: null });

    await expect(createSubscriptionCheckout('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 502,
      code: 'CHECKOUT_FAILED',
    });
    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });
});

describe('createSubscriptionCheckout — session shape & customer paths', () => {
  it('creates a mode:subscription session on the env price with the pinned URLs', async () => {
    mocks.selectBillingCustomerByUser.mockResolvedValue({
      userId: 'u1',
      stripeCustomerId: 'cus_existing',
    });

    const res = await createSubscriptionCheckout('u1', ORIGIN);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_existing',
      line_items: [{ price: 'price_pro_123', quantity: 1 }],
      subscription_data: { metadata: { userId: 'u1' } }, // diagnostics only (D2)
      success_url: 'https://app.example/settings/billing?subscription=confirming',
      cancel_url: 'https://app.example/settings/billing',
    });
    expect(res).toEqual({ url: 'https://stripe.test/session' });
    expect(mocks.captureServerEvent).toHaveBeenCalledWith('subscription_checkout_created', {
      distinctId: 'u1',
    });
  });

  it('reuses the persisted linkage — no customers.create on the reuse path', async () => {
    mocks.selectBillingCustomerByUser.mockResolvedValue({
      userId: 'u1',
      stripeCustomerId: 'cus_existing',
    });

    await createSubscriptionCheckout('u1', ORIGIN);

    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('creates + links the customer when no linkage exists', async () => {
    await createSubscriptionCheckout('u1', ORIGIN);

    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_new' }),
    );
  });

  it('sells to the concurrent winner’s customer on a lost linkage race', async () => {
    mocks.insertBillingCustomerLink.mockResolvedValue({
      link: { userId: 'u1', stripeCustomerId: 'cus_winner' },
      created: false,
    });

    await createSubscriptionCheckout('u1', ORIGIN);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_winner' }),
    );
  });
});

// --- createPortalSession (D15) -----------------------------------------------

describe('createPortalSession', () => {
  it('refuses 404 NO_BILLING_CUSTOMER when no linkage exists', async () => {
    await expect(createPortalSession('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NO_BILLING_CUSTOMER',
    });
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('refuses 402 BILLING_NOT_AVAILABLE when Stripe is unconfigured', async () => {
    mocks.selectBillingCustomerByUser.mockResolvedValue({
      userId: 'u1',
      stripeCustomerId: 'cus_existing',
    });
    mocks.getStripeClient.mockReturnValue(null);

    await expect(createPortalSession('u1', ORIGIN)).rejects.toMatchObject({
      statusCode: 402,
      code: 'BILLING_NOT_AVAILABLE',
    });
  });

  it('creates a portal session for the linked customer returning to the billing tab', async () => {
    mocks.selectBillingCustomerByUser.mockResolvedValue({
      userId: 'u1',
      stripeCustomerId: 'cus_existing',
    });

    const res = await createPortalSession('u1', ORIGIN);

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_existing',
      return_url: 'https://app.example/settings/billing',
    });
    expect(res).toEqual({ url: 'https://stripe.test/portal' });
  });
});

// --- extractSubscriptionMirror (D6) -------------------------------------------

describe('extractSubscriptionMirror — clover extraction (D6)', () => {
  it('maps raw status, cancel flag, created, string customer id and the price snapshot', () => {
    const sub = fakeSub({
      id: 'sub_x',
      customer: 'cus_9',
      status: 'trialing',
      cancelAtPeriodEnd: true,
      createdSec: 1_700_000_000,
      items: [
        {
          current_period_end: 1_700_100_000,
          price: { id: 'price_grandfathered', unit_amount: 1500, currency: 'usd' },
        },
      ],
    });

    expect(extractSubscriptionMirror(sub)).toEqual({
      stripeCustomerId: 'cus_9',
      stripeSubscriptionId: 'sub_x',
      status: 'trialing',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(1_700_100_000 * 1000),
      priceId: 'price_grandfathered',
      priceUnitAmount: 1500,
      priceCurrency: 'usd',
      stripeCreatedAt: new Date(1_700_000_000 * 1000),
    });
  });

  it('takes current_period_end as the MAX over subscription ITEMS (never a top-level field)', () => {
    const sub = fakeSub({
      items: [
        {
          current_period_end: 1_700_000_100,
          price: { id: 'price_a', unit_amount: 1000, currency: 'usd' },
        },
        {
          current_period_end: 1_700_999_999,
          price: { id: 'price_b', unit_amount: 500, currency: 'usd' },
        },
      ],
    });

    const mirror = extractSubscriptionMirror(sub);

    expect(mirror.currentPeriodEnd).toEqual(new Date(1_700_999_999 * 1000));
    // the price snapshot still comes from items.data[0]
    expect(mirror.priceId).toBe('price_a');
  });

  it('resolves an expanded customer object via resolveId', () => {
    const sub = fakeSub({ customer: { id: 'cus_expanded' } });

    expect(extractSubscriptionMirror(sub).stripeCustomerId).toBe('cus_expanded');
  });

  it('fails closed on an item-less subscription: epoch period end, null price snapshot', () => {
    const mirror = extractSubscriptionMirror(fakeSub({ items: [] }));

    expect(mirror.currentPeriodEnd).toEqual(new Date(0));
    expect(mirror.priceId).toBeNull();
    expect(mirror.priceUnitAmount).toBeNull();
    expect(mirror.priceCurrency).toBeNull();
  });

  it('treats a flexible-mode cancel_at (boolean false) as a scheduled cancellation', () => {
    const sub = fakeSub({ cancelAtPeriodEnd: false, cancelAtSec: 1_700_100_000 });

    expect(extractSubscriptionMirror(sub).cancelAtPeriodEnd).toBe(true);
  });

  it('mirrors cancelAtPeriodEnd false when neither cancel signal is set', () => {
    const sub = fakeSub({ cancelAtPeriodEnd: false, cancelAtSec: null });

    expect(extractSubscriptionMirror(sub).cancelAtPeriodEnd).toBe(false);
  });

  it('mirrors a null unit_amount as null (the card omits the price line)', () => {
    const sub = fakeSub({
      items: [
        {
          current_period_end: BASE_SEC,
          price: { id: 'price_x', unit_amount: null, currency: 'usd' },
        },
      ],
    });

    expect(extractSubscriptionMirror(sub).priceUnitAmount).toBeNull();
  });
});

// --- applySubscriptionEvent: lifecycle upserts (D1/D2) -------------------------

describe('applySubscriptionEvent — lifecycle upserts', () => {
  it('applies a linked created(active): row written, processed, reconcile effect, no re-fetch', async () => {
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );

    const row = mocks.rows.get('sub_1');
    expect(row).toMatchObject({ userId: 'u1', status: 'active', stripeCustomerId: 'cus_1' });
    expect(row?.lastEventCreated).toEqual(new Date(BASE_SEC * 1000));
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ status: 'processed' }),
    );
    expect(effectKinds(effects)).toEqual(['analytics', 'reconcile']); // activated + reconcile
  });

  it('acks `ignored` with a structured warn for a customer with no linkage row (D2)', async () => {
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub({ customer: 'cus_unknown' }), BASE_SEC),
    );

    expect(effects).toEqual([]);
    expect(mocks.rows.size).toBe(0);
    expect(mocks.upsertSubscriptionMirror).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no linkage row'),
      expect.objectContaining({ stripeCustomerId: 'cus_unknown' }),
    );
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ status: 'ignored' }),
    );
  });

  it('skips a strictly-older event: state untouched, ignored, re-fetch + reconcile still fire', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'active' }), BASE_SEC),
    );
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'canceled' }), BASE_SEC - 60),
    );

    const row = mocks.rows.get('sub_1');
    // The stale `canceled` never regresses newer state; the watermark stays monotone.
    expect(row?.status).toBe('active');
    expect(row?.lastEventCreated).toEqual(new Date(BASE_SEC * 1000));
    expect(mocks.recordWebhookOutcome).toHaveBeenLastCalledWith(
      TX,
      expect.objectContaining({ status: 'ignored' }),
    );
    // No transition analytics on a skipped event; reconciliation fires anyway (D5).
    expect(effectKinds(effects)).toEqual(['refetch', 'reconcile']);
  });

  it('applies a same-second tie in arrival order AND enqueues the authoritative re-fetch', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub({ cancelAtPeriodEnd: false }), BASE_SEC),
    );
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ cancelAtPeriodEnd: true }), BASE_SEC),
    );

    expect(mocks.rows.get('sub_1')?.cancelAtPeriodEnd).toBe(true); // last-writer-wins in arrival order
    expect(effectKinds(effects)).toContain('refetch');
    expect(mocks.recordWebhookOutcome).toHaveBeenLastCalledWith(
      TX,
      expect.objectContaining({ status: 'processed' }),
    );
  });
});

// --- applySubscriptionEvent: D17 transition analytics ---------------------------

describe('applySubscriptionEvent — D17 transition analytics effects', () => {
  it('fires subscription_activated on transition into qualifying active', async () => {
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );

    await runEffects(effects, 'analytics');

    expect(mocks.captureServerEvent).toHaveBeenCalledWith('subscription_activated', {
      distinctId: 'u1',
      properties: { stripeSubscriptionId: 'sub_1' },
    });
  });

  it('does not re-fire subscription_activated on a continuing active subscription', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub(), BASE_SEC + 60),
    );

    await runEffects(effects, 'analytics');

    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });

  it('fires subscription_cancel_scheduled only on the false→true flip', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    const flip = await applySubscriptionEvent(
      TX,
      subEvent(
        'customer.subscription.updated',
        fakeSub({ cancelAtPeriodEnd: true }),
        BASE_SEC + 60,
      ),
    );
    await runEffects(flip, 'analytics');
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      'subscription_cancel_scheduled',
      expect.objectContaining({ distinctId: 'u1' }),
    );

    mocks.captureServerEvent.mockClear();
    const repeat = await applySubscriptionEvent(
      TX,
      subEvent(
        'customer.subscription.updated',
        fakeSub({ cancelAtPeriodEnd: true }),
        BASE_SEC + 120,
      ),
    );
    await runEffects(repeat, 'analytics');
    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });

  it('fires subscription_ended on qualifying→terminal (deleted arrives as canceled)', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.deleted', fakeSub({ status: 'canceled' }), BASE_SEC + 60),
    );

    await runEffects(effects, 'analytics');

    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      'subscription_ended',
      expect.objectContaining({ distinctId: 'u1' }),
    );
  });

  it('fires subscription_payment_failed on entering past_due, not on continuing past_due', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    const entering = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'past_due' }), BASE_SEC + 60),
    );
    await runEffects(entering, 'analytics');
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      'subscription_payment_failed',
      expect.objectContaining({ distinctId: 'u1' }),
    );

    mocks.captureServerEvent.mockClear();
    const continuing = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'past_due' }), BASE_SEC + 120),
    );
    await runEffects(continuing, 'analytics');
    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });
});

// --- applySubscriptionEvent: anchor maintenance (D6) ----------------------------

describe('applySubscriptionEvent — entered_past_due_at maintenance', () => {
  it('entering past_due anchors from event.created; continuing keeps; non-past_due clears', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toBeNull();

    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'past_due' }), BASE_SEC + 60),
    );
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toEqual(new Date((BASE_SEC + 60) * 1000));

    // A continuing past_due (here: the cancel flag flips) KEEPS the anchor.
    await applySubscriptionEvent(
      TX,
      subEvent(
        'customer.subscription.updated',
        fakeSub({ status: 'past_due', cancelAtPeriodEnd: true }),
        BASE_SEC + 120,
      ),
    );
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toEqual(new Date((BASE_SEC + 60) * 1000));

    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'active' }), BASE_SEC + 180),
    );
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toBeNull();
  });
});

// --- applySubscriptionEvent: invoice events (D6) --------------------------------

describe('applySubscriptionEvent — invoice anchor events', () => {
  it('invoice.paid RE-ANCHORS a still-past_due row to event.created (never clears it)', async () => {
    seedRow({
      stripeSubscriptionId: 'sub_1',
      status: 'past_due',
      enteredPastDueAt: new Date((BASE_SEC - 500) * 1000),
    });

    const effects = await applySubscriptionEvent(
      TX,
      invoiceEvent('invoice.paid', 'sub_1', BASE_SEC),
    );

    expect(mocks.applyInvoicePaidAnchor).toHaveBeenCalledWith(
      TX,
      'sub_1',
      new Date(BASE_SEC * 1000),
    );
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toEqual(new Date(BASE_SEC * 1000));
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ status: 'processed' }),
    );
    expect(effectKinds(effects)).toEqual(['reconcile']);
  });

  it('invoice.paid clears the anchor when the row is no longer past_due', async () => {
    seedRow({
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      enteredPastDueAt: new Date(BASE_SEC * 1000),
    });

    await applySubscriptionEvent(TX, invoiceEvent('invoice.paid', 'sub_1', BASE_SEC + 60));

    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toBeNull();
  });

  it('invoice.payment_failed fills ONLY a null anchor (set-if-null, never set-to-null)', async () => {
    seedRow({ stripeSubscriptionId: 'sub_1', status: 'past_due', enteredPastDueAt: null });

    await applySubscriptionEvent(TX, invoiceEvent('invoice.payment_failed', 'sub_1', BASE_SEC));
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toEqual(new Date(BASE_SEC * 1000));

    // A later payment_failed never moves (nor nulls) the existing anchor.
    await applySubscriptionEvent(
      TX,
      invoiceEvent('invoice.payment_failed', 'sub_1', BASE_SEC + 600),
    );
    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toEqual(new Date(BASE_SEC * 1000));
  });

  it('invoice.payment_failed leaves a non-past_due row untouched but still processes', async () => {
    seedRow({ stripeSubscriptionId: 'sub_1', status: 'active', enteredPastDueAt: null });

    const effects = await applySubscriptionEvent(
      TX,
      invoiceEvent('invoice.payment_failed', 'sub_1', BASE_SEC),
    );

    expect(mocks.rows.get('sub_1')?.enteredPastDueAt).toBeNull();
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ status: 'processed' }),
    );
    expect(effectKinds(effects)).toEqual(['reconcile']);
  });

  it('drops a row-less invoice event safely (ignored, no effects)', async () => {
    const effects = await applySubscriptionEvent(
      TX,
      invoiceEvent('invoice.paid', 'sub_ghost', BASE_SEC),
    );

    expect(effects).toEqual([]);
    expect(mocks.applyInvoicePaidAnchor).not.toHaveBeenCalled();
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ status: 'ignored' }),
    );
  });

  it('drops a non-subscription invoice (no parent subscription_details) as ignored', async () => {
    const effects = await applySubscriptionEvent(TX, invoiceEvent('invoice.paid', null, BASE_SEC));

    expect(effects).toEqual([]);
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ status: 'ignored' }),
    );
  });
});

// --- applySubscriptionEvent: dunning recovery races (D6 closure) ----------------

describe('applySubscriptionEvent — dunning recovery races', () => {
  const row = () => mocks.rows.get('sub_1') as FakeRow;

  it('order updated(past_due) → invoice.paid → updated(active): entitled at every step', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'past_due' }), BASE_SEC + 10),
    );
    expect(subscriptionQualifies(row(), new Date())).toBe(true); // dunning grace

    await applySubscriptionEvent(TX, invoiceEvent('invoice.paid', 'sub_1', BASE_SEC + 20));
    // Re-anchored: the horizon restarts from the paid renewal, so even a LOST
    // recovery updated(active) leaves the subscriber entitled to the new horizon.
    expect(row().enteredPastDueAt).toEqual(new Date((BASE_SEC + 20) * 1000));
    expect(subscriptionQualifies(row(), new Date())).toBe(true);

    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub(), BASE_SEC + 30),
    );
    expect(row().status).toBe('active');
    expect(row().enteredPastDueAt).toBeNull();
    expect(subscriptionQualifies(row(), new Date())).toBe(true);
  });

  it('order updated(past_due) → updated(active) → invoice.paid: entitled at every step', async () => {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'past_due' }), BASE_SEC + 10),
    );
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub(), BASE_SEC + 20),
    );
    expect(row().status).toBe('active');
    expect(subscriptionQualifies(row(), new Date())).toBe(true);

    await applySubscriptionEvent(TX, invoiceEvent('invoice.paid', 'sub_1', BASE_SEC + 30));
    // Not past_due ⇒ the paid invoice clears (already-null) — never resurrects an anchor.
    expect(row().enteredPastDueAt).toBeNull();
    expect(subscriptionQualifies(row(), new Date())).toBe(true);
  });
});

// --- the D1 authoritative re-fetch effect ---------------------------------------

describe('the D1 authoritative re-fetch effect', () => {
  /** Apply a fresh event, then a stale one — returns the skip-case re-fetch effect. */
  async function skipStaleAndGetRefetch(): Promise<PostCommitEffect> {
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub(), BASE_SEC),
    );
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'canceled' }), BASE_SEC - 60),
    );
    return effects.find((effect) => effect.kind === 'refetch') as PostCommitEffect;
  }

  it('retrieves the subscription and CAS-applies through the same extraction + anchor path', async () => {
    const refetch = await skipStaleAndGetRefetch();
    stripe.subscriptions.retrieve.mockResolvedValue(fakeSub({ status: 'past_due' }));

    await refetch.run();

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    // Pin (c): its own small plain transaction.
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefetchedSubscriptionMirror).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'past_due', userId: 'u1', stripeSubscriptionId: 'sub_1' }),
      {
        expectedLastEventCreated: new Date(BASE_SEC * 1000),
        triggeringEventCreated: new Date((BASE_SEC - 60) * 1000),
      },
    );
    const row = mocks.rows.get('sub_1');
    expect(row?.status).toBe('past_due');
    // Pin (b): entering past_due through the heal anchors from the TRIGGERING event's created.
    expect(row?.enteredPastDueAt).toEqual(new Date((BASE_SEC - 60) * 1000));
    // Pin (a): the watermark stays monotone — GREATEST(existing, triggering).
    expect(row?.lastEventCreated).toEqual(new Date(BASE_SEC * 1000));
  });

  it('skips as superseded when a newer event advanced the watermark before the heal ran', async () => {
    const refetch = await skipStaleAndGetRefetch();
    await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.updated', fakeSub({ status: 'unpaid' }), BASE_SEC + 60),
    );

    stripe.subscriptions.retrieve.mockResolvedValue(fakeSub({ status: 'active' }));
    await refetch.run();

    const row = mocks.rows.get('sub_1');
    // The newer event's state wins — the heal never last-writes a stale snapshot over it.
    expect(row?.status).toBe('unpaid');
    expect(row?.lastEventCreated).toEqual(new Date((BASE_SEC + 60) * 1000));
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('superseded'),
      expect.anything(),
    );
  });

  it('warns and skips when Stripe is unconfigured at effect time', async () => {
    const refetch = await skipStaleAndGetRefetch();
    mocks.getStripeClient.mockReturnValue(null);

    await refetch.run();

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(mocks.applyRefetchedSubscriptionMirror).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('re-fetch skipped'),
      expect.anything(),
    );
  });

  it('the reconcile effect re-reads the mirror for the event user', async () => {
    const effects = await applySubscriptionEvent(
      TX,
      subEvent('customer.subscription.created', fakeSub(), BASE_SEC),
    );

    await runEffects(effects, 'reconcile');

    expect(mocks.selectSubscriptionsByUser).toHaveBeenCalledWith(expect.anything(), 'u1');
    // One qualifying row ⇒ nothing to reconcile.
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });
});

// --- reconcileDuplicateSubscriptions (D7) ---------------------------------------

describe('reconcileDuplicateSubscriptions — refund-first, then cancel', () => {
  function seedDuplicates() {
    seedRow({
      stripeSubscriptionId: 'sub_keep',
      stripeCreatedAt: new Date((BASE_SEC - 100) * 1000),
    });
    seedRow({ stripeSubscriptionId: 'sub_dup', stripeCreatedAt: new Date(BASE_SEC * 1000) });
  }

  it('refunds every paid invoice of the duplicate BEFORE canceling; earliest-created survives', async () => {
    seedDuplicates();
    stripe.invoices.list.mockResolvedValue({
      data: [
        paidInvoice('in_1', [piPayment('pi_1')]),
        paidInvoice('in_2', [piPayment({ id: 'pi_2' })]), // expanded PI resolves via resolveId
      ],
    });

    await reconcileDuplicateSubscriptions('u1');

    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_dup',
      status: 'paid',
      expand: ['data.payments'],
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1' });
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_2' });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_dup');
    // Refund-BEFORE-cancel ordering is mandatory.
    expect(Math.max(...stripe.refunds.create.mock.invocationCallOrder)).toBeLessThan(
      stripe.subscriptions.cancel.mock.invocationCallOrder[0],
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith('subscription duplicate reconciled', {
      userId: 'u1',
      survivorId: 'sub_keep',
      duplicateId: 'sub_dup',
      refundedInvoices: 2,
      canceled: true,
    });
  });

  it('treats charge_already_refunded as SUCCESS — the idempotent re-run mechanism', async () => {
    seedDuplicates();
    stripe.invoices.list.mockResolvedValue({ data: [paidInvoice('in_1', [piPayment('pi_1')])] });
    stripe.refunds.create.mockRejectedValue(
      Object.assign(new Error('Charge has already been refunded.'), {
        code: 'charge_already_refunded',
      }),
    );
    // Second-run shape: the duplicate was already canceled too.
    stripe.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error('No such subscription: sub_dup'), { code: 'resource_missing' }),
    );

    await reconcileDuplicateSubscriptions('u1');

    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'subscription duplicate reconciled',
      expect.objectContaining({ refundedInvoices: 1, canceled: true }),
    );
  });

  it('any other refund error aborts that duplicate BEFORE its cancel step; the loop continues', async () => {
    seedRow({
      stripeSubscriptionId: 'sub_keep',
      stripeCreatedAt: new Date((BASE_SEC - 100) * 1000),
    });
    seedRow({ stripeSubscriptionId: 'sub_bad', stripeCreatedAt: new Date(BASE_SEC * 1000) });
    seedRow({ stripeSubscriptionId: 'sub_ok', stripeCreatedAt: new Date((BASE_SEC + 100) * 1000) });
    stripe.invoices.list.mockImplementation(({ subscription }: { subscription: string }) =>
      Promise.resolve({
        data: [paidInvoice(`in_${subscription}`, [piPayment(`pi_${subscription}`)])],
      }),
    );
    stripe.refunds.create.mockImplementation(({ payment_intent }: { payment_intent: string }) =>
      payment_intent === 'pi_sub_bad'
        ? Promise.reject(Object.assign(new Error('refund declined'), { code: 'processing_error' }))
        : Promise.resolve({ id: 're_ok' }),
    );

    await reconcileDuplicateSubscriptions('u1');

    // Aborted before cancel — sub_bad stays double-qualifying so the next event retries.
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalledWith('sub_bad');
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_ok');
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('refund failed'),
      expect.objectContaining({ duplicateId: 'sub_bad', survivorId: 'sub_keep' }),
    );
  });

  it('skips invoices with no PaymentIntent ($0 / out-of-band) and still cancels', async () => {
    seedDuplicates();
    stripe.invoices.list.mockResolvedValue({
      data: [
        paidInvoice('in_zero', [{ payment: { type: 'charge', charge: 'ch_1' } }]),
        paidInvoice('in_none', []),
      ],
    });

    await reconcileDuplicateSubscriptions('u1');

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_dup');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'subscription duplicate reconciled',
      expect.objectContaining({ refundedInvoices: 0, canceled: true }),
    );
  });

  it('same-second creations resolve deterministically by the id tiebreak — both orders', async () => {
    const t = new Date(BASE_SEC * 1000);
    seedRow({ stripeSubscriptionId: 'sub_b', stripeCreatedAt: t });
    seedRow({ stripeSubscriptionId: 'sub_a', stripeCreatedAt: t });
    await reconcileDuplicateSubscriptions('u1');
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_b');

    // The opposite insertion order picks the SAME survivor (sub_a).
    stripe.subscriptions.cancel.mockClear();
    mocks.rows.clear();
    seedRow({ stripeSubscriptionId: 'sub_a', stripeCreatedAt: t });
    seedRow({ stripeSubscriptionId: 'sub_b', stripeCreatedAt: t });
    await reconcileDuplicateSubscriptions('u1');
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_b');
  });

  it('does nothing when at most one row qualifies (a canceled duplicate no longer qualifies)', async () => {
    seedRow({ stripeSubscriptionId: 'sub_keep' });
    seedRow({ stripeSubscriptionId: 'sub_dead', status: 'canceled' });

    await reconcileDuplicateSubscriptions('u1');

    expect(stripe.invoices.list).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('treats an already-canceled cancel error as done', async () => {
    seedDuplicates();
    stripe.invoices.list.mockResolvedValue({ data: [] });
    stripe.subscriptions.cancel.mockRejectedValue(
      new Error('This subscription has been canceled and cannot be modified.'),
    );

    await reconcileDuplicateSubscriptions('u1');

    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'subscription duplicate reconciled',
      expect.objectContaining({ canceled: true }),
    );
  });

  it('logs and skips when Stripe is unconfigured at reconcile time', async () => {
    mocks.getStripeClient.mockReturnValue(null);
    seedDuplicates();

    await reconcileDuplicateSubscriptions('u1');

    expect(mocks.selectSubscriptionsByUser).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('reconciliation skipped'),
      {
        userId: 'u1',
      },
    );
  });
});
