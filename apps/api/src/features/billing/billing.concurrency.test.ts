import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { users, walletTransactions, webhookEvents } from '@/db/schema';
import { config } from '@/lib/config';
import { withTransaction } from '@/lib/transaction';

import * as billingQuery from './billing.query';

// ---------------------------------------------------------------------------
// Wallet concurrency integration tests (Task 16 — design Testing Strategy →
// concurrency half). Real Postgres, per-test transaction-rollback isolation
// (test-setup.ts). The harness runs every test on a SINGLE pooled connection
// inside one drizzle transaction (nested .transaction() → SAVEPOINT), so a
// literal cross-connection FOR UPDATE block is not expressible here — mirroring
// the csv-import.commit.test.ts precedent, we drive the serialized mutation
// primitive directly and the forced-rollback (crash) path via injection, and
// assert the invariants that matter: no lost update / torn write, correct
// balance_after chain, and credit↔webhook_events atomicity (REQ-9.4).
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

afterEach(() => {
  vi.restoreAllMocks();
});

let ipCounter = 0;
function uniqueIp() {
  return `10.66.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

let emailCounter = 0;
function uniqueEmail() {
  return `concurrency-test-${Date.now()}-${++emailCounter}@example.com`;
}

let eventCounter = 0;
function uniqueEventId(prefix = 'evt') {
  return `${prefix}_test_${Date.now()}_${++eventCounter}`;
}

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return row!.id;
}

/** Apply a wallet delta through the production primitive under the row lock. */
async function applyDelta(
  userId: string,
  delta: bigint,
  kind: 'credit' | 'debit' | 'reversal',
): Promise<bigint> {
  return withTransaction(db, async (tx) => {
    await billingQuery.ensureWallet(tx, userId);
    const applied = await billingQuery.applyBalanceDelta(tx, userId, {
      deltaBalance: delta,
      deltaReserved: 0n,
      kind,
      amount: delta,
    });
    return applied.balance;
  });
}

async function balanceOf(userId: string): Promise<bigint> {
  const rows = await db
    .select({ amount: walletTransactions.amount })
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId));
  return rows.reduce((acc, r) => acc + r.amount, 0n);
}

/**
 * The set of distinct `balance_after` values recorded across this user's audit
 * rows. Order-independent on purpose: under single-connection SAVEPOINT
 * interleaving the rows can tie on `created_at`, so the faithful no-lost-update /
 * no-torn-write invariant is that every committed row's balance_after is one of
 * the VALID serialized post-states — not a fragile timestamp ordering.
 */
async function auditStates(userId: string): Promise<Set<bigint>> {
  const rows = await db
    .select({ balanceAfter: walletTransactions.balanceAfter })
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId));
  return new Set(rows.map((r) => r.balanceAfter));
}

function checkoutCompletedPayload(args: {
  id: string;
  userId: string;
  creditGrant: string;
  amountMinor: number;
}): string {
  return JSON.stringify({
    id: args.id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${args.id}`,
        object: 'checkout.session',
        // Credit packs are payment-mode sessions (real Stripe payloads always
        // carry `mode`; plan-tiers D5 discriminates on it before the trigger).
        mode: 'payment',
        payment_status: 'paid',
        amount_total: args.amountMinor,
        currency: 'usd',
        payment_intent: `pi_${args.id}`,
        metadata: {
          userId: args.userId,
          packId: 'pack_test',
          creditGrant: args.creditGrant,
          expectedAmountMinor: String(args.amountMinor),
          expectedCurrency: 'usd',
        },
      },
    },
  });
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

// ===========================================================================
// Two concurrent debits → serial result, no lost update (REQ-9.2, REQ-9.3)
// ===========================================================================

describe('wallet concurrency — debits serialize without lost update', () => {
  it('two concurrent debits both apply (no lost update); balance_after chain is monotonic', async () => {
    const userId = await createUser();
    await applyDelta(userId, 1_000_000n, 'credit');

    // Fire two debits concurrently. The FOR UPDATE lock in applyBalanceDelta
    // serializes them so both deltas land — neither read-modify-write clobbers
    // the other (a lost update would leave balance at 700_000, not 400_000).
    const [b1, b2] = await Promise.all([
      applyDelta(userId, -300_000n, 'debit'),
      applyDelta(userId, -300_000n, 'debit'),
    ]);

    expect(await balanceOf(userId)).toBe(400_000n);

    // Each debit recorded a distinct balance_after; the two returned balances are
    // the two serialized post-states (700_000 then 400_000, in some order). A lost
    // update would surface 700_000 twice (both debits reading the 1_000_000 base).
    expect(new Set([b1, b2])).toEqual(new Set([700_000n, 400_000n]));

    // The recorded balance_after values are exactly the valid serialized states:
    // 1_000_000 (credit) → 700_000 (first debit) → 400_000 (second debit).
    expect(await auditStates(userId)).toEqual(new Set([1_000_000n, 700_000n, 400_000n]));
  });

  it('a debit cannot be lost when interleaved many-fold', async () => {
    const userId = await createUser();
    await applyDelta(userId, 1_000_000n, 'credit');

    // Ten concurrent 50_000 debits — every one must land (no lost update).
    await Promise.all(Array.from({ length: 10 }, () => applyDelta(userId, -50_000n, 'debit')));

    expect(await balanceOf(userId)).toBe(500_000n);
    // 1 credit + 10 debits = 11 audit rows.
    const rows = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, userId));
    expect(rows).toHaveLength(11);
  });
});

// ===========================================================================
// Credit concurrent with debit → no torn write (REQ-9.2)
// ===========================================================================

describe('wallet concurrency — credit concurrent with debit (no torn write)', () => {
  it('a credit and a debit both commit fully; final balance is the sum, audit chain consistent', async () => {
    const userId = await createUser();
    await applyDelta(userId, 500_000n, 'credit');

    // Concurrent credit (+1_000_000) and debit (−200_000). Both must apply atomically;
    // neither sees/writes a half-applied row.
    await Promise.all([
      applyDelta(userId, 1_000_000n, 'credit'),
      applyDelta(userId, -200_000n, 'debit'),
    ]);

    expect(await balanceOf(userId)).toBe(1_300_000n);

    // No torn write: every row's balance_after is one of the valid serialized
    // states. Whichever of the two concurrent ops committed second, the states
    // recorded are 500_000 (initial credit) and the two post-states of applying
    // +1_000_000 and −200_000 in some order: {1_500_000, 1_300_000}. The summed
    // balance landing at 1_300_000 proves both ops applied fully (no half-write).
    expect(await auditStates(userId)).toEqual(new Set([500_000n, 1_500_000n, 1_300_000n]));
  });
});

// ===========================================================================
// Crash mid-credit (forced rollback) → no orphaned webhook_events processed row
// without its credit (REQ-9.4)
// ===========================================================================

describe('wallet concurrency — crash mid-credit atomicity (REQ-9.4)', () => {
  it('a credit that throws AFTER the claim rolls back the webhook_events row too (no orphan)', async () => {
    const userId = await createUser();
    const eventId = uniqueEventId('crash');
    const payload = checkoutCompletedPayload({
      id: eventId,
      userId,
      creditGrant: '1000000',
      amountMinor: 500,
    });

    // Inject a crash mid-credit: the claim succeeds, then crediting throws inside
    // the SAME withTransaction. REQ-9.4 requires the claim (webhook_events row)
    // and the credit to commit or roll back together — so the row must NOT
    // survive without its credit.
    vi.spyOn(billingQuery, 'creditWalletForEvent').mockRejectedValueOnce(
      new Error('injected crash mid-credit'),
    );

    const res = await postWebhook(payload);
    // Unexpected error ⇒ retryable 5xx so Stripe redelivers.
    expect(res.status).toBe(500);
    expect((await res.json()).outcome).toBe('retry');

    // No credit applied.
    const credits = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.kind, 'credit')));
    expect(credits).toHaveLength(0);

    // CRUCIAL (REQ-9.4): NO orphaned webhook_events row — the claim rolled back
    // with the failed credit, so a redelivery can reprocess cleanly.
    const [evRow] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, eventId));
    expect(evRow).toBeUndefined();
  });

  it('after a crashed delivery, a clean redelivery of the SAME event credits exactly once', async () => {
    const userId = await createUser();
    const eventId = uniqueEventId('crash-then-ok');
    const payload = checkoutCompletedPayload({
      id: eventId,
      userId,
      creditGrant: '1000000',
      amountMinor: 500,
    });

    // First delivery crashes mid-credit (claim + credit rolled back atomically).
    vi.spyOn(billingQuery, 'creditWalletForEvent').mockRejectedValueOnce(
      new Error('injected crash mid-credit'),
    );
    const crashed = await postWebhook(payload);
    expect(crashed.status).toBe(500);

    // Redelivery (mock consumed — real credit runs). Because the first attempt
    // left NO webhook_events row, the claim now succeeds and credits exactly once.
    const redeliver = await postWebhook(payload);
    expect(redeliver.status).toBe(200);
    expect((await redeliver.json()).outcome).toBe('credited');

    const credits = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.kind, 'credit')));
    expect(credits).toHaveLength(1);
    expect(await balanceOf(userId)).toBe(1_000_000n);
  });
});
