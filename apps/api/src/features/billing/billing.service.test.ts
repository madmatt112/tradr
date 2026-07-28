import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the gate + reservation primitives (design Component 6) and the
// honest-messaging F6 branch. The query layer, transaction helper, config, and
// pricing are mocked so these stay pure unit cases (DB-backed integration is
// Task 16). Credits are bigint micro-USD.

const mocks = vi.hoisted(() => ({
  ensureWallet: vi.fn(),
  getBalanceForUser: vi.fn(),
  listWalletHistory: vi.fn(),
  decodeWalletCursor: vi.fn(),
  isModelPriced: vi.fn(),
  isStripeConfigured: vi.fn(),
  execute: vi.fn(),
  // Webhook query layer (Task 7 + Task 9 additions).
  claimWebhookEvent: vi.fn(),
  recordWebhookOutcome: vi.fn(),
  creditWalletForEvent: vi.fn(),
  findReversalByEventId: vi.fn(),
  findCreditByPaymentIntent: vi.fn(),
  sumReversalsByPaymentIntent: vi.fn(),
  applyBalanceDelta: vi.fn(),
  // Subscription dispatch seam (plan-tiers Task 8).
  applySubscriptionEvent: vi.fn(),
  selectSubscriptionByStripeId: vi.fn(),
  config: {
    MIN_RESERVATION_CREDITS: 1,
    RESERVATION_TTL_MS: 600_000,
    STRIPE_SECRET_KEY: undefined as string | undefined,
  },
}));

vi.mock('./billing.query', () => ({
  ensureWallet: mocks.ensureWallet,
  getBalanceForUser: mocks.getBalanceForUser,
  listWalletHistory: mocks.listWalletHistory,
  decodeWalletCursor: mocks.decodeWalletCursor,
  getWalletForUpdate: vi.fn(),
  claimWebhookEvent: mocks.claimWebhookEvent,
  recordWebhookOutcome: mocks.recordWebhookOutcome,
  creditWalletForEvent: mocks.creditWalletForEvent,
  findReversalByEventId: mocks.findReversalByEventId,
  findCreditByPaymentIntent: mocks.findCreditByPaymentIntent,
  sumReversalsByPaymentIntent: mocks.sumReversalsByPaymentIntent,
  applyBalanceDelta: mocks.applyBalanceDelta,
}));

vi.mock('./pricing', () => ({ isModelPriced: mocks.isModelPriced }));

// The subscription-family dispatch target (plan-tiers D5) and the canary's
// mirror lookup are mocked so this file stays a pure unit suite (and so the
// subscription chain's tier-limits module-load assertion never runs against
// the mocked `./pricing`). DB-backed behaviour is subscription.webhook.test.ts.
vi.mock('./subscription.service', () => ({
  applySubscriptionEvent: mocks.applySubscriptionEvent,
}));
vi.mock('./subscription.query', () => ({
  selectSubscriptionByStripeId: mocks.selectSubscriptionByStripeId,
}));

vi.mock('@/lib/config', () => ({
  config: mocks.config,
  isStripeConfigured: mocks.isStripeConfigured,
}));

// withTransaction runs the callback with a fake tx exposing `execute`.
vi.mock('@/lib/transaction', () => ({
  withTransaction: (_db: unknown, cb: (tx: { execute: typeof mocks.execute }) => unknown) =>
    cb({ execute: mocks.execute }),
}));

// `db` is replaced per-test by test-setup; we only need `.execute` for release.
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }));

import { logger } from '@/lib/logger';

import {
  classifyReconciliation,
  gateAndReserve,
  handleStripeEvent,
  proportionalReversal,
  releaseReservation,
  selectCreditTrigger,
} from './billing.service';

interface WalletRow {
  balance: bigint;
  reserved: bigint;
  reservedAt: Date | null;
}

function wallet(balance: bigint, reserved: bigint, reservedAt: Date | null): WalletRow {
  return { balance, reserved, reservedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.MIN_RESERVATION_CREDITS = 1;
  mocks.config.RESERVATION_TTL_MS = 600_000;
  mocks.isModelPriced.mockReturnValue(true);
  mocks.isStripeConfigured.mockReturnValue(true);
  mocks.execute.mockResolvedValue(undefined);
});

describe('gateAndReserve — decrement-or-reject', () => {
  it('admits when available >= threshold and reserves the threshold', async () => {
    mocks.ensureWallet.mockResolvedValue(wallet(100n, 0n, null));

    const res = await gateAndReserve('u1', 'claude', 'claude-sonnet-4-5');

    expect(res).toEqual({ held: 1n });
    // The reserve UPDATE ran (reserved += threshold, reserved_at = now()).
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects with INSUFFICIENT_CREDITS when available < threshold (Stripe configured)', async () => {
    mocks.config.MIN_RESERVATION_CREDITS = 5;
    mocks.ensureWallet.mockResolvedValue(wallet(4n, 0n, null));

    await expect(gateAndReserve('u1', 'claude', 'claude-sonnet-4-5')).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_CREDITS',
    });
    // No reservation written on refusal.
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('gateAndReserve — available = balance - reserved', () => {
  it('subtracts an outstanding (fresh) reservation from the available balance', async () => {
    mocks.config.MIN_RESERVATION_CREDITS = 10;
    // balance 15, reserved 10 (fresh) ⇒ available 5 < 10 ⇒ refuse.
    mocks.ensureWallet.mockResolvedValue(wallet(15n, 10n, new Date()));

    await expect(gateAndReserve('u1', 'claude', 'claude-sonnet-4-5')).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });
    // A fresh hold is NOT expired, so only the (refused) path ran — no UPDATE.
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('gateAndReserve — TTL expiry (fail-safe)', () => {
  it('expires a stale hold then admits (never overdraws — only spurious refusal risk)', async () => {
    mocks.config.MIN_RESERVATION_CREDITS = 10;
    const stale = new Date(Date.now() - 600_001);
    // balance 15, reserved 10 but STALE ⇒ effective reserved 0 ⇒ available 15 ≥ 10 ⇒ admit.
    mocks.ensureWallet.mockResolvedValue(wallet(15n, 10n, stale));

    const res = await gateAndReserve('u1', 'claude', 'claude-sonnet-4-5');

    expect(res).toEqual({ held: 10n });
    // Two writes: (1) expire stale hold to 0, (2) reserve the threshold.
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('does NOT expire a hold within the TTL', async () => {
    mocks.config.MIN_RESERVATION_CREDITS = 10;
    const recent = new Date(Date.now() - 1_000);
    mocks.ensureWallet.mockResolvedValue(wallet(15n, 10n, recent));

    await expect(gateAndReserve('u1', 'claude', 'claude-sonnet-4-5')).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('gateAndReserve — model gate', () => {
  it('refuses MODEL_NOT_AVAILABLE for an unpriced model', async () => {
    mocks.isModelPriced.mockReturnValue(false);
    mocks.ensureWallet.mockResolvedValue(wallet(100n, 0n, null));

    await expect(gateAndReserve('u1', 'claude', 'unpriced-model')).rejects.toMatchObject({
      statusCode: 402,
      code: 'MODEL_NOT_AVAILABLE',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('gateAndReserve — F6 honest-messaging branch', () => {
  it('Stripe configured + insufficient ⇒ INSUFFICIENT_CREDITS', async () => {
    mocks.isStripeConfigured.mockReturnValue(true);
    mocks.config.MIN_RESERVATION_CREDITS = 5;
    mocks.ensureWallet.mockResolvedValue(wallet(0n, 0n, null));

    await expect(gateAndReserve('u1', 'claude', 'claude-sonnet-4-5')).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_CREDITS',
    });
  });

  it('Stripe absent + insufficient ⇒ BILLING_NOT_AVAILABLE (no add-credits dead-end)', async () => {
    mocks.isStripeConfigured.mockReturnValue(false);
    mocks.config.MIN_RESERVATION_CREDITS = 5;
    mocks.ensureWallet.mockResolvedValue(wallet(0n, 0n, null));

    await expect(gateAndReserve('u1', 'claude', 'claude-sonnet-4-5')).rejects.toMatchObject({
      statusCode: 402,
      code: 'BILLING_NOT_AVAILABLE',
    });
  });
});

describe('gateAndReserve — lazy/absent wallet', () => {
  it('reads an absent (zero) wallet as zero and refuses', async () => {
    // ensureWallet lazily creates ⇒ zero balance row.
    mocks.config.MIN_RESERVATION_CREDITS = 1;
    mocks.ensureWallet.mockResolvedValue(wallet(0n, 0n, null));

    await expect(gateAndReserve('u1', 'claude', 'claude-sonnet-4-5')).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('releaseReservation', () => {
  it('issues a clamped reserved decrement', async () => {
    await releaseReservation('u1', 5n);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a non-positive held amount', async () => {
    await releaseReservation('u1', 0n);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

// --- Webhook: pure helpers (design Component 4) ------------------------------

function checkoutEvent(
  type: 'checkout.session.completed' | 'checkout.session.async_payment_succeeded',
  session: Partial<Stripe.Checkout.Session>,
): Stripe.Event {
  return {
    id: 'evt_1',
    type,
    // Real checkout sessions always carry `mode`; credit packs are payment-mode.
    data: { object: { mode: 'payment', ...session } as Stripe.Checkout.Session },
  } as unknown as Stripe.Event;
}

describe('selectCreditTrigger — settled-only single trigger (REQ-3.3/3.7)', () => {
  it('credits on completed with payment_status=paid (sync)', () => {
    const evt = checkoutEvent('checkout.session.completed', { payment_status: 'paid' });
    expect(selectCreditTrigger(evt)).toBe('sync');
  });

  it('does NOT credit on completed when not paid', () => {
    const evt = checkoutEvent('checkout.session.completed', { payment_status: 'unpaid' });
    expect(selectCreditTrigger(evt)).toBeNull();
  });

  it('credits on async_payment_succeeded (async)', () => {
    const evt = checkoutEvent('checkout.session.async_payment_succeeded', {});
    expect(selectCreditTrigger(evt)).toBe('async');
  });

  it('does NOT credit on other event types (fan-out cannot double-credit)', () => {
    for (const type of [
      'payment_intent.succeeded',
      'charge.succeeded',
      'checkout.session.async_payment_failed',
    ]) {
      const evt = { id: 'e', type, data: { object: {} } } as unknown as Stripe.Event;
      expect(selectCreditTrigger(evt)).toBeNull();
    }
  });

  it('does NOT credit a non-payment-mode session (defensive D5 mode guard)', () => {
    const completed = checkoutEvent('checkout.session.completed', {
      mode: 'subscription',
      payment_status: 'paid',
    });
    expect(selectCreditTrigger(completed)).toBeNull();

    const async = checkoutEvent('checkout.session.async_payment_succeeded', {
      mode: 'subscription',
    });
    expect(selectCreditTrigger(async)).toBeNull();
  });
});

describe('classifyReconciliation — definitive vs transient (REQ-3a/3.6)', () => {
  const expected = { amountMinor: 1000n, currency: 'usd' };

  it('exact amount + currency ⇒ ok', () => {
    expect(classifyReconciliation({ amountTotal: 1000, currency: 'usd' }, expected)).toBe('ok');
  });

  it('amount_total null ⇒ transient (cannot determine the match)', () => {
    expect(classifyReconciliation({ amountTotal: null, currency: 'usd' }, expected)).toBe(
      'transient',
    );
  });

  it('resolved amount differs ⇒ mismatch (definitive)', () => {
    expect(classifyReconciliation({ amountTotal: 500, currency: 'usd' }, expected)).toBe(
      'mismatch',
    );
  });

  it('wrong currency ⇒ mismatch (definitive)', () => {
    expect(classifyReconciliation({ amountTotal: 1000, currency: 'eur' }, expected)).toBe(
      'mismatch',
    );
  });
});

describe('proportionalReversal — full vs partial (REQ-3.9)', () => {
  it('full refund (refunded == charge) reverses the whole grant', () => {
    expect(proportionalReversal(10_000_000n, 1000, 1000)).toBe(10_000_000n);
  });

  it('partial refund reverses the refunded fraction (floor-rounded)', () => {
    // 40% of a 10,000,000 grant = 4,000,000.
    expect(proportionalReversal(10_000_000n, 400, 1000)).toBe(4_000_000n);
  });

  it('over-refund (refunded >= charge) clamps to the whole grant', () => {
    expect(proportionalReversal(10_000_000n, 1500, 1000)).toBe(10_000_000n);
  });

  it('zero/negative charge amount reverses the whole grant (dispute sentinel)', () => {
    expect(proportionalReversal(7n, 1, 1)).toBe(7n);
  });
});

// --- Webhook: handler paths (design Component 4) -----------------------------

const META = {
  userId: 'u1',
  packId: 'pack_10',
  creditGrant: '10000000',
  expectedAmountMinor: '1000',
  expectedCurrency: 'usd',
};

function paidSession(over: Partial<Stripe.Checkout.Session> = {}): Stripe.Event {
  return {
    id: 'evt_paid',
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 1000,
        currency: 'usd',
        payment_intent: 'pi_123',
        metadata: META,
        ...over,
      } as Stripe.Checkout.Session,
    },
  } as unknown as Stripe.Event;
}

describe('handleStripeEvent — claim/credit/ack/duplicate', () => {
  beforeEach(() => {
    mocks.claimWebhookEvent.mockResolvedValue(true);
    mocks.recordWebhookOutcome.mockResolvedValue(undefined);
    mocks.creditWalletForEvent.mockResolvedValue({ balance: 10_000_000n, reserved: 0n });
  });

  it('credits a settled, reconciled paid session and records processed', async () => {
    const res = await handleStripeEvent(paidSession());
    expect(res).toEqual({ kind: 'credited', balance: 10_000_000n });
    expect(mocks.creditWalletForEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'u1',
        creditGrant: 10_000_000n,
        stripeEventId: 'evt_paid',
        stripePaymentIntentId: 'pi_123',
      }),
    );
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'processed' }),
    );
  });

  it('acks a duplicate (claim no-op) without re-crediting', async () => {
    mocks.claimWebhookEvent.mockResolvedValue(false);
    const res = await handleStripeEvent(paidSession());
    expect(res).toEqual({ kind: 'duplicate' });
    expect(mocks.creditWalletForEvent).not.toHaveBeenCalled();
  });

  it('acks-without-credit a non-trigger event (recorded ignored)', async () => {
    const evt = {
      id: 'evt_pi',
      type: 'payment_intent.succeeded',
      data: { object: {} },
    } as unknown as Stripe.Event;
    const res = await handleStripeEvent(evt);
    expect(res).toEqual({ kind: 'acked' });
    expect(mocks.creditWalletForEvent).not.toHaveBeenCalled();
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'ignored' }),
    );
  });

  it('refuses-and-records (failed) a definitive amount mismatch — no credit', async () => {
    const res = await handleStripeEvent(paidSession({ amount_total: 500 }));
    expect(res).toEqual({ kind: 'refused' });
    expect(mocks.creditWalletForEvent).not.toHaveBeenCalled();
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('returns retryable (no record) on a transient verify-failure', async () => {
    const res = await handleStripeEvent(paidSession({ amount_total: null }));
    expect(res).toEqual({ kind: 'retry' });
    expect(mocks.creditWalletForEvent).not.toHaveBeenCalled();
    // Transient must NOT be recorded as processed/ignored/failed.
    expect(mocks.recordWebhookOutcome).not.toHaveBeenCalled();
  });
});

// --- Webhook: plan-tiers D5 dispatch extension (Task 8) -----------------------

function subscriptionFamilyEvent(type: string): Stripe.Event {
  return {
    id: 'evt_sub',
    type,
    created: 1_700_000_000,
    data: { object: { id: 'sub_1', object: 'subscription' } },
  } as unknown as Stripe.Event;
}

describe('handleStripeEvent — subscription-family dispatch (D5)', () => {
  beforeEach(() => {
    mocks.claimWebhookEvent.mockResolvedValue(true);
    mocks.recordWebhookOutcome.mockResolvedValue(undefined);
  });

  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
  ])(
    'dispatches %s to applySubscriptionEvent inside the claim tx — no double-record',
    async (type) => {
      mocks.applySubscriptionEvent.mockResolvedValue([]);
      const evt = subscriptionFamilyEvent(type);

      const res = await handleStripeEvent(evt);

      expect(res).toEqual({ kind: 'acked' });
      expect(mocks.applySubscriptionEvent).toHaveBeenCalledWith(expect.anything(), evt);
      // applySubscriptionEvent records its own outcome — the dispatcher must NOT.
      expect(mocks.recordWebhookOutcome).not.toHaveBeenCalled();
      expect(mocks.creditWalletForEvent).not.toHaveBeenCalled();
    },
  );

  it('executes the returned post-commit effects after the transaction', async () => {
    const order: string[] = [];
    mocks.applySubscriptionEvent.mockImplementation(async () => {
      order.push('apply');
      return [
        { kind: 'analytics', run: async () => void order.push('effect-1') },
        { kind: 'reconcile', run: async () => void order.push('effect-2') },
      ];
    });

    const res = await handleStripeEvent(subscriptionFamilyEvent('customer.subscription.updated'));

    expect(res).toEqual({ kind: 'acked' });
    expect(order).toEqual(['apply', 'effect-1', 'effect-2']);
  });

  it('a throwing effect is guarded — the committed event still acks (no retry loop)', async () => {
    const ran: string[] = [];
    mocks.applySubscriptionEvent.mockResolvedValue([
      {
        kind: 'refetch',
        run: async () => {
          throw new Error('stripe blew up post-commit');
        },
      },
      { kind: 'reconcile', run: async () => void ran.push('after-throw') },
    ]);

    const res = await handleStripeEvent(subscriptionFamilyEvent('customer.subscription.deleted'));

    // Individually guarded: the failure is logged, later effects still run,
    // and the result stays a terminal ack — never a 500-driven redelivery.
    expect(res).toEqual({ kind: 'acked' });
    expect(ran).toEqual(['after-throw']);
  });

  it('a transient failure inside the dispatch rolls back the claim and returns retry', async () => {
    mocks.applySubscriptionEvent.mockRejectedValue(new Error('db blip'));

    const res = await handleStripeEvent(subscriptionFamilyEvent('customer.subscription.updated'));

    expect(res).toEqual({ kind: 'retry' });
    expect(mocks.recordWebhookOutcome).not.toHaveBeenCalled();
  });
});

describe('handleStripeEvent — subscription-mode checkout discrimination (D5, REQ-3.1)', () => {
  beforeEach(() => {
    mocks.claimWebhookEvent.mockResolvedValue(true);
    mocks.recordWebhookOutcome.mockResolvedValue(undefined);
    mocks.selectSubscriptionByStripeId.mockResolvedValue(null);
  });

  function subscriptionModeSession(over: Partial<Stripe.Checkout.Session> = {}): Stripe.Event {
    return paidSession({ mode: 'subscription', metadata: {}, subscription: 'sub_pro_1', ...over });
  }

  it('records a subscription-mode completed session `processed` — never failed, no credit path', async () => {
    const res = await handleStripeEvent(subscriptionModeSession());

    expect(res).toEqual({ kind: 'acked' });
    expect(mocks.creditWalletForEvent).not.toHaveBeenCalled();
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledTimes(1);
    expect(mocks.recordWebhookOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'processed' }),
    );
  });

  it('emits the misconfiguration canary when session.subscription has no mirror row', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    mocks.selectSubscriptionByStripeId.mockResolvedValue(null);

    await handleStripeEvent(subscriptionModeSession());

    expect(mocks.selectSubscriptionByStripeId).toHaveBeenCalledWith(expect.anything(), 'sub_pro_1');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("verify the webhook endpoint's event registration"),
      expect.objectContaining({ stripeSubscriptionId: 'sub_pro_1' }),
    );
    warnSpy.mockRestore();
  });

  it('no canary when the subscription is already mirrored, or when the session carries none', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    mocks.selectSubscriptionByStripeId.mockResolvedValue({ id: 'row_1' });

    await handleStripeEvent(subscriptionModeSession());
    await handleStripeEvent(subscriptionModeSession({ subscription: null }));

    const canaryCalls = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('subscription-mode checkout processed'),
    );
    expect(canaryCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

describe('handleStripeEvent — chargeback/refund reversal (REQ-3.9)', () => {
  function refundEvent(amount: number, amountRefunded: number, id = 'evt_refund'): Stripe.Event {
    return {
      id,
      type: 'charge.refunded',
      data: {
        object: {
          payment_intent: 'pi_123',
          amount,
          amount_refunded: amountRefunded,
        } as Stripe.Charge,
      },
    } as unknown as Stripe.Event;
  }

  beforeEach(() => {
    mocks.claimWebhookEvent.mockResolvedValue(true);
    mocks.recordWebhookOutcome.mockResolvedValue(undefined);
    mocks.findReversalByEventId.mockResolvedValue(false);
    mocks.ensureWallet.mockResolvedValue({ balance: 0n, reserved: 0n, reservedAt: null });
    // No prior reversals applied for the PI by default (incremental-reversal guard).
    mocks.sumReversalsByPaymentIntent.mockResolvedValue(0n);
    mocks.applyBalanceDelta.mockResolvedValue({ balance: -2_000_000n, reserved: 0n });
  });

  it('partially reverses by the refunded fraction', async () => {
    mocks.findCreditByPaymentIntent.mockResolvedValue([
      { id: 't1', userId: 'u1', amount: 10_000_000n, stripeEventId: 'evt_paid' },
    ]);
    const res = await handleStripeEvent(refundEvent(1000, 200)); // 20% ⇒ 2,000,000
    expect(res).toMatchObject({ kind: 'reversed' });
    expect(mocks.applyBalanceDelta).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ kind: 'reversal', deltaBalance: -2_000_000n, amount: -2_000_000n }),
    );
  });

  it('reverses INCREMENTALLY across sequential cumulative partial refunds (no over-claw)', async () => {
    // Stripe sends `amount_refunded` as the CUMULATIVE total, each refund a
    // distinct event id. 30% then 50% cumulative must reverse 30% then a further
    // 20% — total exactly 50% of the grant, NOT 30%+50%=80%.
    mocks.findCreditByPaymentIntent.mockResolvedValue([
      { id: 't1', userId: 'u1', amount: 10_000_000n, stripeEventId: 'evt_paid' },
    ]);

    // First refund: cumulative 30% ⇒ reverse 3,000,000. Nothing reversed yet.
    mocks.sumReversalsByPaymentIntent.mockResolvedValueOnce(0n);
    await handleStripeEvent(refundEvent(1000, 300, 'evt_refund_1'));
    expect(mocks.applyBalanceDelta).toHaveBeenLastCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ kind: 'reversal', amount: -3_000_000n }),
    );

    // Second refund: cumulative 50% target = 5,000,000; already reversed 3,000,000
    // ⇒ apply only the 2,000,000 remainder (NOT another 5,000,000).
    mocks.sumReversalsByPaymentIntent.mockResolvedValueOnce(3_000_000n);
    await handleStripeEvent(refundEvent(1000, 500, 'evt_refund_2'));
    expect(mocks.applyBalanceDelta).toHaveBeenLastCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ kind: 'reversal', amount: -2_000_000n }),
    );

    // Total reversed = 3,000,000 + 2,000,000 = 5,000,000 = 50% of the grant.
  });

  it('a full refund reverses 100% of the grant', async () => {
    mocks.findCreditByPaymentIntent.mockResolvedValue([
      { id: 't1', userId: 'u1', amount: 10_000_000n, stripeEventId: 'evt_paid' },
    ]);
    await handleStripeEvent(refundEvent(1000, 1000)); // cumulative 100%
    expect(mocks.applyBalanceDelta).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ kind: 'reversal', amount: -10_000_000n }),
    );
  });

  it('acks (no further reversal) when the PI is already fully reversed', async () => {
    mocks.findCreditByPaymentIntent.mockResolvedValue([
      { id: 't1', userId: 'u1', amount: 10_000_000n, stripeEventId: 'evt_paid' },
    ]);
    // A new distinct refund event whose cumulative target is already covered.
    mocks.sumReversalsByPaymentIntent.mockResolvedValue(10_000_000n);
    const res = await handleStripeEvent(refundEvent(1000, 1000, 'evt_refund_late'));
    expect(res).toEqual({ kind: 'acked' });
    expect(mocks.applyBalanceDelta).not.toHaveBeenCalled();
  });

  it('redelivery of the SAME event id is a no-op (idempotent)', async () => {
    mocks.findReversalByEventId.mockResolvedValue(true);
    const res = await handleStripeEvent(refundEvent(1000, 300, 'evt_refund_1'));
    expect(res).toEqual({ kind: 'acked' });
    expect(mocks.applyBalanceDelta).not.toHaveBeenCalled();
  });

  it('is idempotent by event id (already reversed ⇒ ack, no second reversal)', async () => {
    mocks.findReversalByEventId.mockResolvedValue(true);
    const res = await handleStripeEvent(refundEvent(1000, 1000));
    expect(res).toEqual({ kind: 'acked' });
    expect(mocks.applyBalanceDelta).not.toHaveBeenCalled();
  });

  it('acks when no original grant is found for the payment intent', async () => {
    mocks.findCreditByPaymentIntent.mockResolvedValue([]);
    const res = await handleStripeEvent(refundEvent(1000, 1000));
    expect(res).toEqual({ kind: 'acked' });
    expect(mocks.applyBalanceDelta).not.toHaveBeenCalled();
  });
});
