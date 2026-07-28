import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { TierStateSchema } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import {
  advisorImageCounters,
  advisorTurnCounters,
  billingCustomers,
  csvImportCounters,
  positions,
  subscriptions,
  users,
} from '@/db/schema';
import { config } from '@/lib/config';

import { ALLOWANCE_MODEL, PERIOD_KEY } from './tier-limits.constants';

// ---------------------------------------------------------------------------
// Billing HTTP surface integration tests (plan-tiers Task 14 — design
// Component 6, D8/D15/D16; REQ-2.x, REQ-4.1, REQ-8.9a, REQ-11.x). Drives the
// real routes through Hono `app.request` against a real Postgres (per-test
// transaction-rollback isolation from test-setup.ts), toggling billing/gating
// availability via the mutable `config` (restored per test). NO Stripe client
// stub is needed: every branch under test refuses BEFORE any Stripe call, and
// `GET /tier` derives from the local mirror only (REQ-11.1).
// ---------------------------------------------------------------------------

let testCounter = 0;
function uniqueEmail() {
  return `billing-tier-${Date.now()}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.88.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

let idCounter = 0;
function uniqueSubId() {
  return `sub_tiertest_${Date.now()}_${++idCounter}`;
}

// Mutable-config pattern: capture and restore everything this file touches.
const prevGating = config.FEATURE_GATING;
const prevSecret = config.STRIPE_SECRET_KEY;
const prevWebhookSecret = config.STRIPE_WEBHOOK_SECRET;
const prevPriceId = config.STRIPE_PRO_PRICE_ID;
const prevAnthropicKey = config.ANTHROPIC_API_KEY;

afterEach(() => {
  config.FEATURE_GATING = prevGating;
  config.STRIPE_SECRET_KEY = prevSecret;
  config.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
  config.STRIPE_PRO_PRICE_ID = prevPriceId;
  config.ANTHROPIC_API_KEY = prevAnthropicKey;
});

/** Stripe fully configured incl. the Pro price (isProSubscriptionConfigured() = true). */
function configureStripeWithPrice() {
  config.STRIPE_SECRET_KEY = 'sk_test_dummy_tier_tests';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy_tier_tests';
  config.STRIPE_PRO_PRICE_ID = 'price_test_dummy_pro';
}

/** Stripe entirely unconfigured (the self-host / keys-removed state). */
function unconfigureStripe() {
  config.STRIPE_SECRET_KEY = undefined;
  config.STRIPE_WEBHOOK_SECRET = undefined;
  config.STRIPE_PRO_PRICE_ID = undefined;
}

// --- harness helpers (csv-import.commit.test.ts pattern) ---------------------

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeDefined();
  return cookie!;
}

async function getUserId(cookie: string): Promise<string> {
  const res = await app.request('/api/auth/me', {
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status).toBe(200);
  const me = await res.json();
  return me.id as string;
}

async function createAccount(cookie: string, name = 'Tier Account'): Promise<string> {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ name, currency: 'USD' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id as string;
}

async function getTier(cookie: string): Promise<Response> {
  return app.request('/api/billing/tier', {
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
}

async function postSubscriptionCheckout(cookie: string): Promise<Response> {
  return app.request('/api/billing/subscription/checkout', {
    method: 'POST',
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
}

async function postPortal(cookie: string): Promise<Response> {
  return app.request('/api/billing/subscription/portal', {
    method: 'POST',
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Insert a mirror row directly (the webhook write path has its own suite). */
async function insertMirrorRow(
  userId: string,
  over: Partial<typeof subscriptions.$inferInsert> = {},
): Promise<void> {
  await db.insert(subscriptions).values({
    userId,
    stripeCustomerId: over.stripeCustomerId ?? `cus_tiertest_${++idCounter}`,
    stripeSubscriptionId: uniqueSubId(),
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
    stripeCreatedAt: new Date(),
    lastEventCreated: new Date(),
    ...over,
  });
}

// ===========================================================================
// POST /api/billing/subscription/checkout — refusals (D8; REQ-2.4/2.7)
// ===========================================================================

describe('POST /api/billing/subscription/checkout — refusals', () => {
  it('402 BILLING_NOT_AVAILABLE when the Pro price is unconfigured (Stripe keys alone are not enough)', async () => {
    const cookie = await registerAndGetCookie();
    config.STRIPE_SECRET_KEY = 'sk_test_dummy_tier_tests';
    config.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy_tier_tests';
    config.STRIPE_PRO_PRICE_ID = undefined;

    const res = await postSubscriptionCheckout(cookie);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('BILLING_NOT_AVAILABLE');
  });

  it('409 SUBSCRIPTION_EXISTS when a qualifying active subscription exists', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    configureStripeWithPrice();
    await insertMirrorRow(userId, { status: 'active' });

    const res = await postSubscriptionCheckout(cookie);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('SUBSCRIPTION_EXISTS');
  });

  it('409 SUBSCRIPTION_EXISTS while past_due within the dunning horizon (a past-due user still qualifies)', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    configureStripeWithPrice();
    await insertMirrorRow(userId, {
      status: 'past_due',
      enteredPastDueAt: new Date(Date.now() - 1 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
    });

    const res = await postSubscriptionCheckout(cookie);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('SUBSCRIPTION_EXISTS');
  });

  it('409 SUBSCRIPTION_EXISTS while cancel-pending (active + cancel_at_period_end keeps Pro until period end)', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    configureStripeWithPrice();
    await insertMirrorRow(userId, { status: 'active', cancelAtPeriodEnd: true });

    const res = await postSubscriptionCheckout(cookie);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('SUBSCRIPTION_EXISTS');
  });
});

// ===========================================================================
// POST /api/billing/subscription/portal — refusals (D15; REQ-4.1, REQ-11.3)
// ===========================================================================

describe('POST /api/billing/subscription/portal — refusals', () => {
  it('404 NO_BILLING_CUSTOMER when no linkage row exists (looked up BEFORE the Stripe-config check)', async () => {
    const cookie = await registerAndGetCookie();
    configureStripeWithPrice();

    const res = await postPortal(cookie);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NO_BILLING_CUSTOMER');
  });

  it('402 BILLING_NOT_AVAILABLE when a linkage exists but Stripe is unconfigured', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    unconfigureStripe();
    await db
      .insert(billingCustomers)
      .values({ userId, stripeCustomerId: `cus_tiertest_${++idCounter}` });

    const res = await postPortal(cookie);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('BILLING_NOT_AVAILABLE');
  });
});

// ===========================================================================
// GET /api/billing/tier — mirror-derived state (D16; REQ-11.1/11.4/11.7)
// ===========================================================================

describe('GET /api/billing/tier — tier state', () => {
  it('renders the mirrored subscription with Stripe unconfigured: manageable false, no price id leaked (REQ-11.1)', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    unconfigureStripe();
    config.FEATURE_GATING = true;
    await insertMirrorRow(userId, {
      status: 'active',
      priceId: 'price_secret_never_leaves',
      priceUnitAmount: 1000,
      priceCurrency: 'usd',
    });

    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The response IS the shared contract (Task 1's TierStateSchema).
    const state = TierStateSchema.parse(body);

    expect(state.gatingEnabled).toBe(true);
    expect(state.tier).toBe('pro');
    expect(state.purchasable).toBe(false); // Stripe unconfigured
    expect(state.subscription).not.toBeNull();
    expect(state.subscription!.status).toBe('active');
    expect(state.subscription!.pastDue).toBe(false);
    expect(state.subscription!.priceUnitAmount).toBe(1000);
    expect(state.subscription!.priceCurrency).toBe('usd');
    expect(state.subscription!.manageable).toBe(false); // no Portal without Stripe
    // Price IDS never leave the API (D16) — only the mirrored amount does.
    expect(JSON.stringify(body)).not.toContain('price_secret_never_leaves');
  });

  it('populates usage from the five reads when gating is on and the user is non-exempt', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    config.FEATURE_GATING = false; // create the account ungated
    const accountId = await createAccount(cookie);
    // performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'equity',
      status: 'open',
    });
    const periodKey = PERIOD_KEY();
    await db
      .insert(advisorTurnCounters)
      .values({ userId, periodKey, turnCount: 5, allowanceTurns: 3 });
    await db.insert(advisorImageCounters).values({ userId, periodKey, imageCount: 7 });
    await db.insert(csvImportCounters).values({ userId, committedCount: 2 });

    config.FEATURE_GATING = true;
    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const state = TierStateSchema.parse(await res.json());

    expect(state.exempt).toBe(false);
    expect(state.tier).toBe('free');
    expect(state.subscription).toBeNull();
    expect(state.usage).toEqual({
      accounts: { used: 1, writableAccountId: accountId },
      positions: { used: 1 },
      platformTurns: { allowanceUsed: 3 },
      images: { used: 7 },
      csvImports: { used: 2 },
    });
    // The lever catalog rides along for the CTA summary (REQ-11.6).
    expect(state.limits.free.accounts).toBe(1);
    expect(state.limits.pro.accounts).toBeNull();
  });

  it('gating off: usage is null but the subscription still renders — the REQ-11.7 carve-out', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    config.FEATURE_GATING = false;
    await insertMirrorRow(userId, { status: 'active' });

    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const state = TierStateSchema.parse(await res.json());

    expect(state.gatingEnabled).toBe(false);
    expect(state.usage).toBeNull();
    expect(state.subscription).not.toBeNull();
    expect(state.subscription!.status).toBe('active');
    expect(state.tier).toBe('pro');
  });

  it('admin is exempt: usage is null even with gating on', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    config.FEATURE_GATING = true;

    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const state = TierStateSchema.parse(await res.json());

    expect(state.gatingEnabled).toBe(true);
    expect(state.exempt).toBe(true);
    expect(state.usage).toBeNull();
  });

  it('qualifying-first display row: a re-subscribed user (dead unpaid + live active) sees the live one, never the zombie', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    // The dead row is EARLIEST-created — a created-order rule would pick it;
    // the qualifying-first rule must not.
    await insertMirrorRow(userId, {
      status: 'unpaid',
      stripeCreatedAt: new Date(Date.now() - 90 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() - 60 * DAY_MS),
    });
    const livePeriodEnd = new Date(Date.now() + 25 * DAY_MS);
    await insertMirrorRow(userId, {
      status: 'active',
      stripeCreatedAt: new Date(),
      currentPeriodEnd: livePeriodEnd,
    });

    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const state = TierStateSchema.parse(await res.json());

    expect(state.tier).toBe('pro');
    expect(state.subscription!.status).toBe('active');
    expect(state.subscription!.currentPeriodEnd).toBe(livePeriodEnd.toISOString());
  });

  it('nothing qualifies: the earliest-created NON-terminal lapsed row renders (terminal rows never do)', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    // Earliest row is terminal (`canceled`) — skipped even though it is oldest.
    await insertMirrorRow(userId, {
      status: 'canceled',
      stripeCreatedAt: new Date(Date.now() - 120 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() - 90 * DAY_MS),
    });
    // Lapsed `active` (10 days past period end — beyond the 72 h slack): no
    // longer confers Pro but may still be a live recurring charge (D16).
    const lapsedPeriodEnd = new Date(Date.now() - 10 * DAY_MS);
    await insertMirrorRow(userId, {
      status: 'active',
      stripeCreatedAt: new Date(Date.now() - 60 * DAY_MS),
      currentPeriodEnd: lapsedPeriodEnd,
    });
    // A later non-terminal row must lose to the earlier one.
    await insertMirrorRow(userId, {
      status: 'unpaid',
      stripeCreatedAt: new Date(Date.now() - 30 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() - 20 * DAY_MS),
    });

    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const state = TierStateSchema.parse(await res.json());

    expect(state.tier).toBe('free'); // display ≠ entitlement
    expect(state.subscription!.status).toBe('active');
    expect(state.subscription!.currentPeriodEnd).toBe(lapsedPeriodEnd.toISOString());
  });

  it('subscription is null when only terminal rows exist', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    await insertMirrorRow(userId, {
      status: 'canceled',
      currentPeriodEnd: new Date(Date.now() - 30 * DAY_MS),
    });
    await insertMirrorRow(userId, {
      status: 'incomplete_expired',
      currentPeriodEnd: new Date(Date.now() - 20 * DAY_MS),
    });

    const res = await getTier(cookie);
    expect(res.status).toBe(200);
    const state = TierStateSchema.parse(await res.json());

    expect(state.tier).toBe('free');
    expect(state.subscription).toBeNull();
  });

  it('is unthrottled: 12 back-to-back reads all 200 and none consume the spend budget (poll-safe)', async () => {
    const cookie = await registerAndGetCookie();
    unconfigureStripe();

    // 12 > the 10/60s spend budget: if GET /tier shared it (or carried its own
    // 10/60s limiter), read #11 would 429 — the confirming poll must never.
    for (let i = 0; i < 12; i++) {
      const res = await getTier(cookie);
      expect(res.status).toBe(200);
    }

    // The spend budget is untouched by the reads: the next money POST reaches
    // its handler (402 unconfigured), it is NOT 429'd at the limiter.
    const checkout = await postSubscriptionCheckout(cookie);
    expect(checkout.status).toBe(402);
    const body = await checkout.json();
    expect(body.error.code).toBe('BILLING_NOT_AVAILABLE');
  });
});

// ===========================================================================
// GET /api/billing/config — allowance marks + purchasable (D16; REQ-8.9a/2.7)
// ===========================================================================

describe('GET /api/billing/config — plan-tiers extension', () => {
  async function getConfig(cookie: string) {
    const res = await app.request('/api/billing/config', {
      headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it('marks exactly the allowance model when gating is ON; purchasable reflects the Pro price', async () => {
    const cookie = await registerAndGetCookie();
    config.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'; // priced + key-configured provider
    config.FEATURE_GATING = true;
    configureStripeWithPrice();

    const body = await getConfig(cookie);
    expect(body.subscription).toEqual({ purchasable: true });

    const claudeModels = body.models.filter(
      (m: { providerId: string }) => m.providerId === 'claude',
    );
    expect(claudeModels.length).toBeGreaterThan(1);
    const marked = claudeModels.filter((m: { allowance?: boolean }) => m.allowance === true);
    expect(marked).toHaveLength(1);
    expect(marked[0].model).toBe(ALLOWANCE_MODEL.claude);
  });

  it('emits NO allowance mark when gating is OFF — self-host pickers never advertise free turns (REQ-8.8)', async () => {
    const cookie = await registerAndGetCookie();
    config.ANTHROPIC_API_KEY = 'sk-ant-test-dummy';
    config.FEATURE_GATING = false;
    unconfigureStripe();

    const body = await getConfig(cookie);
    expect(body.subscription).toEqual({ purchasable: false });
    expect(body.models.length).toBeGreaterThan(0);
    for (const model of body.models) {
      expect(model).not.toHaveProperty('allowance');
    }
  });
});
