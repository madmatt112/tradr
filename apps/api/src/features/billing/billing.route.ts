import { Hono } from 'hono';
import Stripe from 'stripe';

import { ProviderIdSchema, type BillingModel, CheckoutRequestSchema } from '@tradr/shared';

import { db } from '@/db';
import {
  config,
  getPlatformApiKey,
  isFeatureGatingEnabled,
  isProSubscriptionConfigured,
  isStripeConfigured,
} from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  createCheckoutSession,
  getBalance,
  handleStripeEvent,
  listUsage,
  type WebhookResult,
} from './billing.service';
import { CREDIT_PACKS } from './credit-packs';
import { RATE_TABLE } from './pricing';
import { createPortalSession, createSubscriptionCheckout } from './subscription.service';
import { ALLOWANCE_MODEL } from './tier-limits.constants';
import { getTierState } from './tier.query';

// ---------------------------------------------------------------------------
// Billing API routes (design Components 2, 4, 8, 11; plan-tiers Component 6).
//
// Two routers are exported and mounted distinctly in app.ts:
//   - `billingRouter`        — authed money/read endpoints under /api/billing.
//   - `billingWebhookRouter` — the PUBLIC Stripe webhook (NO authMiddleware),
//     mounted so session auth never wraps it and it receives the unmodified raw
//     body for signature verification (REQ-3.1).
//
// Convention: hand-authored JSDoc `@swagger` blocks (advisor/csv-import/options
// route style), NOT `@hono/zod-openapi` (not a dependency) — design Component 11.
// ---------------------------------------------------------------------------

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

// === authed billing router ===
const billingRouter = new Hono<AuthEnv>();

billingRouter.use(authMiddleware);

// Per-user checkout rate limiter (design Component 2, Security NFR). Keyed on
// the authenticated userId (not IP) so the money-spend cap is per-account: NAT'd
// users do not collide and one user across IPs cannot bypass it. Mounted on the
// POST money endpoints ONLY — pack checkout, subscription checkout, and portal
// share this ONE 10/60s spend-adjacent budget (plan-tiers Component 6/D8/D15).
// GET /tier and GET /config are deliberately NOT behind it (see GET /tier).
const perUserCheckoutRateLimit = createRateLimiter({
  name: 'checkout',
  max: 10,
  windowMs: 60_000,
  keyGenerator: (c) => c.get('userId'),
  // Redis-outage fallback keeps the normal per-container budget (D8; not tightened).
  fallbackMax: 10,
});

/**
 * Resolve the request's origin (scheme + host) as the base URL for Stripe
 * Checkout return links. Prefers `Origin`, then `X-Forwarded-{Proto,Host}`
 * (set by the reverse proxy), falling back to parsing `c.req.url`.
 */
function requestOrigin(c: {
  req: { header: (n: string) => string | undefined; url: string };
}): string {
  const origin = c.req.header('origin');
  if (origin) return origin;
  const proto = c.req.header('x-forwarded-proto');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
  if (host) return `${proto ?? 'https'}://${host}`;
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * The platform-priced, key-configured model list (design Component 8, REQ-7.4).
 * Authoritative source for the web no-BYOK model picker: the `pricing.ts` priced
 * set restricted to providers that ALSO have a configured platform key, so the
 * picker never offers an unpriced or unspendable model. Each provider's
 * allowance model carries `allowance: true` ONLY when feature gating is enabled
 * (plan-tiers D16, REQ-8.9a): with gating off there is no allowance (REQ-8.8),
 * so a self-host picker must never advertise free monthly turns.
 */
function pricedConfiguredModels(): BillingModel[] {
  const markAllowance = isFeatureGatingEnabled();
  const models: BillingModel[] = [];
  for (const providerId of ProviderIdSchema.options) {
    if (!getPlatformApiKey(providerId)) continue;
    for (const model of Object.keys(RATE_TABLE[providerId] ?? {})) {
      models.push(
        markAllowance && model === ALLOWANCE_MODEL[providerId]
          ? { providerId, model, allowance: true }
          : { providerId, model },
      );
    }
  }
  return models;
}

/**
 * @swagger
 * /api/billing/checkout:
 *   post:
 *     summary: Create a Stripe Checkout Session for a credit pack.
 *     description: >
 *       Authed and per-user rate limited (10 / 60 s). Body `{ packId }` selects
 *       a server-authoritative `CREDIT_PACKS` pack — the price and credit grant
 *       come solely from config, never client input (REQ-2.2). Returns
 *       `{ url }`, the Stripe-hosted checkout page to redirect to. NO wallet
 *       write happens here — crediting is the webhook's job (REQ-2.6). When
 *       Stripe is unconfigured the endpoint returns a stable
 *       `402 BILLING_NOT_AVAILABLE` (REQ-2.5/10.2).
 *     tags: [Billing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [packId]
 *             properties:
 *               packId: { type: string, minLength: 1 }
 *     responses:
 *       200: { description: '{ url } — the Stripe-hosted checkout URL.' }
 *       400: { description: Validation error or UNKNOWN_PACK. }
 *       402: { description: BILLING_NOT_AVAILABLE (Stripe unconfigured). }
 *       429: { description: Checkout rate limit reached (10 / 60 s). }
 */
billingRouter.post(
  '/checkout',
  perUserCheckoutRateLimit,
  validate('json', CheckoutRequestSchema),
  async (c) => {
    const userId = c.get('userId');
    const { packId } = c.req.valid('json');
    const result = await createCheckoutSession(userId, packId, requestOrigin(c));
    return c.json(result, 200);
  },
);

/**
 * @swagger
 * /api/billing/subscription/checkout:
 *   post:
 *     summary: Create a Stripe Checkout Session for the Pro subscription.
 *     description: >
 *       Authed; shares the per-user 10 / 60 s spend budget with the credit-pack
 *       checkout and the portal endpoint (plan-tiers D8). No request body — the
 *       Price sold is server-configured (`STRIPE_PRO_PRICE_ID`, REQ-2.2). Refuses
 *       `402 BILLING_NOT_AVAILABLE` unless the Pro subscription is fully
 *       configured (REQ-2.7), and `409 SUBSCRIPTION_EXISTS` when the user
 *       already has a qualifying subscription — including `past_due` and
 *       canceled-pending-period-end (REQ-2.4). Returns `{ url }`, the
 *       Stripe-hosted checkout page. NO mirror write happens here — the mirror
 *       is the webhook's job (REQ-3.2); the success URL returns to the billing
 *       tab in its `?subscription=confirming` state (REQ-2.6).
 *     tags: [Billing]
 *     responses:
 *       200: { description: '{ url } — the Stripe-hosted checkout URL.' }
 *       402: { description: BILLING_NOT_AVAILABLE (Stripe or the Pro price unconfigured). }
 *       409: { description: SUBSCRIPTION_EXISTS (a qualifying subscription already exists). }
 *       429: { description: Shared checkout rate limit reached (10 / 60 s). }
 *       502: { description: CHECKOUT_FAILED (Stripe returned no checkout URL). }
 */
billingRouter.post('/subscription/checkout', perUserCheckoutRateLimit, async (c) => {
  const userId = c.get('userId');
  const result = await createSubscriptionCheckout(userId, requestOrigin(c));
  return c.json(result, 200);
});

/**
 * @swagger
 * /api/billing/subscription/portal:
 *   post:
 *     summary: Create a Stripe Billing Portal session.
 *     description: >
 *       Authed; shares the per-user 10 / 60 s spend budget (plan-tiers D15).
 *       Looks up the persisted billing-customer linkage FIRST — none ⇒
 *       `404 NO_BILLING_CUSTOMER`; Stripe unconfigured ⇒
 *       `402 BILLING_NOT_AVAILABLE`. Returns `{ url }`, the Stripe-hosted
 *       Billing Portal (cancel / payment method / invoices per the account's
 *       operator-set default portal configuration — REQ-4.1/4.2).
 *     tags: [Billing]
 *     responses:
 *       200: { description: '{ url } — the Stripe-hosted Billing Portal URL.' }
 *       402: { description: BILLING_NOT_AVAILABLE (Stripe unconfigured). }
 *       404: { description: NO_BILLING_CUSTOMER (no billing customer exists for this account). }
 *       429: { description: Shared checkout rate limit reached (10 / 60 s). }
 */
billingRouter.post('/subscription/portal', perUserCheckoutRateLimit, async (c) => {
  const userId = c.get('userId');
  const result = await createPortalSession(userId, requestOrigin(c));
  return c.json(result, 200);
});

/**
 * @swagger
 * /api/billing/tier:
 *   get:
 *     summary: Get the authenticated user's tier state (plan card / CTA / usage surface).
 *     description: >
 *       Authed, DELIBERATELY UNTHROTTLED read (plan-tiers Component 6's pinned
 *       posture — the 2 s confirming poll alone is 30/min and the tier cache key
 *       is invalidated after every committed turn; sharing the spend budget
 *       would 429 the confirming banner and lock out legitimate checkout
 *       clicks). Returns the TierState shape: `gatingEnabled`, `exempt`,
 *       `tier`, `purchasable`, `subscription` (derived from the LOCAL mirror
 *       only via the qualifying-first display-row rule — renders with Stripe
 *       unconfigured, REQ-11.1; carried even when gating is off, the REQ-11.7
 *       carve-out), `limits` (the free/pro lever catalog), and `usage`
 *       (populated only when gating is on and the user is non-exempt).
 *       Booleans and state only — no server credentials, no price ids.
 *     tags: [Billing]
 *     responses:
 *       200: { description: TierState — see packages/shared/src/schemas/tier.ts. }
 */
billingRouter.get('/tier', async (c) => {
  const userId = c.get('userId');
  const isAdmin = c.get('isAdmin');
  return c.json(await getTierState(db, { userId, isAdmin }), 200);
});

/**
 * @swagger
 * /api/billing/balance:
 *   get:
 *     summary: Get the authenticated user's wallet balance.
 *     description: >
 *       User-scoped. Returns `{ balance, available }` as decimal credit strings
 *       (bigint micro-USD; `available = balance − reserved`). A user with no
 *       wallet row reads as zero (REQ-1.1).
 *     tags: [Billing]
 *     responses:
 *       200: { description: '{ balance, available } credit strings.' }
 */
billingRouter.get('/balance', async (c) => {
  const userId = c.get('userId');
  return c.json(await getBalance(userId), 200);
});

/**
 * @swagger
 * /api/billing/usage:
 *   get:
 *     summary: List the authenticated user's wallet/usage history (cursor-paginated).
 *     description: >
 *       User-scoped unified history (credits, debits, reversals) joined to
 *       per-turn token detail (REQ-7.3). `cursor` is the opaque base64 cursor
 *       from a prior page; absent/invalid ⇒ first page. Response
 *       `{ items, nextCursor }`.
 *     tags: [Billing]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: '{ items: WalletHistoryItem[], nextCursor: string | null }.' }
 */
billingRouter.get('/usage', async (c) => {
  const userId = c.get('userId');
  const cursor = c.req.query('cursor') ?? null;
  return c.json(await listUsage(userId, cursor), 200);
});

/**
 * @swagger
 * /api/billing/config:
 *   get:
 *     summary: Get billing availability, offered packs, the priced model list, and subscription purchasability.
 *     description: >
 *       Drives the billing settings tab and the no-BYOK model picker. Authed,
 *       unthrottled read (plan-tiers Component 6 — never behind the spend
 *       budget). `enabled` is `isStripeConfigured()`; `packs` is
 *       `CREDIT_PACKS`; `models` is the platform-priced provider/model set
 *       restricted to providers with a configured platform key (REQ-7.4) — the
 *       authoritative picker source, so the UI never offers an unpriced or
 *       unspendable model. Each provider's allowance model carries
 *       `allowance: true` ONLY when feature gating is enabled (REQ-8.9a/8.8 —
 *       self-host pickers must never advertise free monthly turns);
 *       `subscription.purchasable` is `isProSubscriptionConfigured()`
 *       (REQ-2.7). When `enabled` is false the frontend hides the purchase UI
 *       (graceful absence, REQ-10.2).
 *     tags: [Billing]
 *     responses:
 *       200: { description: '{ enabled, packs, models, subscription: { purchasable } }.' }
 */
billingRouter.get('/config', (c) => {
  return c.json(
    {
      enabled: isStripeConfigured(),
      packs: CREDIT_PACKS,
      models: pricedConfiguredModels(),
      subscription: { purchasable: isProSubscriptionConfigured() },
    },
    200,
  );
});

// === public webhook router ===
// Mounted WITHOUT authMiddleware (design Component 4): Stripe is the caller, not
// a logged-in user. Mounted on its own router so session auth NEVER wraps it.
const billingWebhookRouter = new Hono();

// Per-IP webhook rate limiter (design Component 4, Security NFR). Stripe is the
// caller, so there is no userId to key on — default IP keying applies.
const webhookIpRateLimit = createRateLimiter({
  name: 'webhook',
  max: 100,
  windowMs: 60_000,
  // Redis-outage fallback keeps the normal per-container budget (D8). MUST NOT
  // tighten: a Stripe retry burst during a Redis outage must not be 429'd.
  fallbackMax: 100,
});

/** Map a verified-event WebhookResult to its HTTP status (design Component 4). */
function webhookStatus(result: WebhookResult): 200 | 500 {
  // credited / acked / duplicate / refused / reversed are terminal → ack 200
  // (Stripe stops retrying); retry is a transient no-row state → 5xx so Stripe
  // redelivers and a legitimate purchase is not lost (REQ-3.6).
  return result.kind === 'retry' ? 500 : 200;
}

/**
 * @swagger
 * /api/billing/webhook:
 *   post:
 *     summary: Stripe webhook — idempotent, settled-only crediting (PUBLIC).
 *     description: >
 *       PUBLIC endpoint (NO session auth — Stripe is the caller) and IP-rate
 *       limited. Reads the UNMODIFIED RAW request body and verifies the
 *       `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` over the exact
 *       raw bytes (REQ-3.1) — an invalid or missing signature returns 400 and no
 *       wallet is touched. The verified event is dispatched to the idempotent
 *       settled-only handler; its outcome maps to 200 (credited / acked /
 *       duplicate / refused / reversed — terminal, Stripe stops retrying) or a
 *       retryable 5xx (transient verify-failure, no row written — Stripe
 *       redelivers). NOTE: this route MUST receive the raw body before any JSON
 *       parse; a global JSON body parser would silently break signatures.
 *     tags: [Billing]
 *     security: []
 *     requestBody:
 *       required: true
 *       description: Raw Stripe event JSON (verified by signature, not parsed by the framework).
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Event acknowledged (credited / acked / duplicate / refused / reversed). }
 *       400: { description: Missing/invalid signature or Stripe unconfigured — no wallet touched. }
 *       500: { description: Transient verify-failure — Stripe should redeliver. }
 */
billingWebhookRouter.post('/', webhookIpRateLimit, async (c) => {
  if (!isStripeConfigured() || !config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) {
    // Stripe not configured ⇒ the webhook is inert. Reject without touching the
    // wallet; never a 500 (graceful absence, REQ-10.2).
    throw new AppError(
      400,
      'BILLING_NOT_AVAILABLE',
      'platform billing is not enabled on this instance',
    );
  }

  // Read the UNMODIFIED raw body BEFORE any JSON parse — the signature is over
  // the exact raw bytes (REQ-3.1). c.req.text() does not parse/re-serialize, so
  // a future global JSON parser cannot silently break verification.
  const rawBody = await c.req.text();
  const signature = c.req.header('stripe-signature');
  if (!signature) {
    throw new AppError(400, 'WEBHOOK_SIGNATURE_INVALID', 'missing Stripe-Signature header');
  }

  const stripe = new Stripe(config.STRIPE_SECRET_KEY);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Invalid signature / unparsable payload ⇒ 400, no wallet touched.
    logger.warn('stripe webhook signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AppError(400, 'WEBHOOK_SIGNATURE_INVALID', 'invalid Stripe webhook signature');
  }

  const result = await handleStripeEvent(event);
  return c.json({ received: true, outcome: result.kind }, webhookStatus(result));
});

export { billingRouter, billingWebhookRouter };
