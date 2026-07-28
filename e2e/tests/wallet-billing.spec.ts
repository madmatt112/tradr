import { createHmac } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * wallet-billing e2e suite (Task 21).
 *
 * Per design.md §Testing Strategy > End-to-End, this drives the full money
 * round-trip against the LIVE stack (the same Playwright `webServer` boot the
 * csv-import / advisor / dashboard suites use — api + web against a real
 * Postgres; see e2e/playwright.config.ts). Nothing here is route-mocked: the
 * checkout endpoint, the signed webhook, the wallet credit, the balance read,
 * and the billing-config gate are all real.
 *
 * Design E2E journey (REQ-2.6, 3.3, 5.x, 6.4, 7.x, 10.2):
 *   buy a pack via Stripe test mode (or a stubbed/forwarded webhook) → balance
 *   appears AFTER the webhook (NOT on the success redirect) → run a platform
 *   advisor turn → credits deducted, usage history shows the turn → spend to
 *   zero → the advisor "out of credits" state links to Billing. Plus the
 *   billing-not-configured instance: no Billing purchase UI, advisor BYOK-only
 *   unaffected.
 *
 * ── Two-mode harness ───────────────────────────────────────────────────────
 *
 * The default e2e harness (playwright.config.ts `apiEnv`) configures NEITHER
 * Stripe NOR a platform LLM key, so against the booted stack
 * `isStripeConfigured()` is false. That IS the design's billing-not-configured
 * instance, and the BILLING-DISABLED describe block below asserts it in full and
 * always runs.
 *
 * The purchasable (Stripe-configured) journey requires the API booted WITH
 * `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (Stripe test-mode keys). When the
 * running stack exposes that (probed via GET /api/billing/config `.enabled`), the
 * STRIPE-CONFIGURED block runs and asserts the REAL post-webhook balance and the
 * webhook-only crediting (balance is zero on the success-redirect return, then
 * non-zero only AFTER the signed webhook POST) and the out-of-credits → Billing
 * link. When the stack is not Stripe-configured, that block `test.skip`s with the
 * exact env it needs documented — it is NOT faked as passing.
 *
 * The webhook is the design-permitted STUBBED webhook: rather than scraping the
 * hosted Stripe Checkout page (non-deterministic to automate), we create a real
 * checkout session, then simulate Stripe's settlement by POSTing a
 * validly-SIGNED `checkout.session.completed` (paid) event to
 * /api/billing/webhook. The event carries the SAME metadata snapshot the
 * checkout created (userId / packId / creditGrant / expectedAmountMinor /
 * expectedCurrency — billing.service.createCheckoutSession), and is signed with
 * the configured STRIPE_WEBHOOK_SECRET using Stripe's exact scheme
 * (`t=<ts>,v1=<HMAC_SHA256("<ts>.<body>", secret)>` — Webhooks.js, verified
 * against the installed stripe@19). This is deterministic while still proving
 * "balance appears only after the webhook".
 *
 * ── Platform advisor turn (deduction step) ─────────────────────────────────
 *
 * The "run a platform advisor turn → credits deducted → usage history shows the
 * turn" step needs a DETERMINISTIC LLM provider response. As documented in
 * advisor-tools.spec.ts, the booted stack has NO out-of-process LLM stub seam:
 * the claude/openai adapters build their SDK clients with no `baseURL` and the
 * registry wires them once at bootstrap, reachable only via in-process
 * `vi.mock` — unreachable from an out-of-process Playwright run. Wiring an
 * OpenAI-shaped SSE stub (the documented seam: boot the API with
 * `OPENAI_BASE_URL` → a local stub + a platform `OPENAI_API_KEY`) is out of this
 * task's scope. So the live provider-call deduction + usage-history assertions
 * are `test.fixme` with the seam documented inline — they are NOT faked as
 * passing. The webhook-credit, the out-of-credits → Billing link, and the
 * graceful-absence path — everything drivable WITHOUT a deterministic provider —
 * are implemented and asserted.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-billing-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call. The auth `/register` route is
 * rate-limited to 5 / 15 min per client IP; the harness sets
 * `TRUSTED_PROXIES=127.0.0.1` (playwright.config.ts), so the limiter keys off
 * this forwarded IP rather than the shared loopback socket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process — the chromium +
  // Mobile Chrome projects re-run this spec in fresh workers that reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.115.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  userId: string;
}

async function registerUser(req: APIRequestContext, label: string): Promise<SeededUser> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return { email, userId: body.user.id };
}

/** Register a user and confirm the shared cookie jar authenticated the context. */
async function setup(page: Page, label: string): Promise<SeededUser> {
  const user = await registerUser(page.request, label);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  return user;
}

interface BillingConfig {
  enabled: boolean;
  packs: Array<{ id: string; priceMinor: number; currency: string; credits: string }>;
  models: Array<{ providerId: string; model: string }>;
}

async function getBillingConfig(req: APIRequestContext): Promise<BillingConfig | null> {
  const res = await req.get('/api/billing/config', { failOnStatusCode: false });
  if (res.status() !== 200) return null;
  return (await res.json()) as BillingConfig;
}

/**
 * Probe the stack — if `/api/auth/me` is unreachable (no booted stack), skip
 * gracefully. Same guard as csv-import.spec.ts / advisor-tools.spec.ts.
 */
async function ensureStackOrSkip(req: APIRequestContext): Promise<void> {
  try {
    const res = await req.get('/api/auth/me', { failOnStatusCode: false });
    if (res.status() >= 500) {
      test.skip(true, `API stack returned ${res.status()} — skipping live e2e`);
    }
  } catch (err) {
    test.skip(true, `API stack unreachable — skipping live e2e (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Stubbed Stripe webhook helpers (design-permitted: a validly-signed direct
// POST to /api/billing/webhook in lieu of scraping the hosted Checkout page).
// ---------------------------------------------------------------------------

/**
 * Sign a webhook payload with Stripe's exact scheme so the route's
 * `stripe.webhooks.constructEvent` accepts it. Stripe signs `<ts>.<body>` with
 * HMAC-SHA256(secret) as hex and ships `t=<ts>,v1=<sig>` in `Stripe-Signature`
 * (verified against the installed stripe@19 Webhooks.js). Computed with Node
 * `crypto` directly — no extra dependency, fully deterministic.
 */
function stripeSignature(payload: string, secret: string, timestamp: number): string {
  const signed = `${timestamp}.${payload}`;
  const v1 = createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/**
 * Build a `checkout.session.completed` (paid) event carrying the SAME metadata
 * snapshot the checkout created — the webhook credits from this metadata, not a
 * live table (billing.service.readCreditMetadata). `amount_total` / `currency`
 * MUST reconcile against `expectedAmountMinor` / `expectedCurrency`
 * (classifyReconciliation) or the credit is refused.
 */
function checkoutCompletedEvent(opts: {
  userId: string;
  packId: string;
  creditGrant: string;
  amountMinor: number;
  currency: string;
}): Record<string, unknown> {
  const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  return {
    id: `evt_e2e_${uniqueSuffix}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_${uniqueSuffix}`,
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: opts.amountMinor,
        currency: opts.currency,
        payment_intent: `pi_e2e_${uniqueSuffix}`,
        metadata: {
          userId: opts.userId,
          packId: opts.packId,
          creditGrant: opts.creditGrant,
          expectedAmountMinor: String(opts.amountMinor),
          expectedCurrency: opts.currency,
        },
      },
    },
  };
}

/** POST a validly-signed event to the public webhook route. */
async function postSignedWebhook(
  req: APIRequestContext,
  event: Record<string, unknown>,
  secret: string,
): Promise<{ status: number; outcome?: string }> {
  const body = JSON.stringify(event);
  const sig = stripeSignature(body, secret, Math.floor(Date.now() / 1000));
  const res = await req.post('/api/billing/webhook', {
    data: body,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
    failOnStatusCode: false,
  });
  let outcome: string | undefined;
  try {
    outcome = ((await res.json()) as { outcome?: string }).outcome;
  } catch {
    outcome = undefined;
  }
  return { status: res.status(), outcome };
}

async function readBalance(
  req: APIRequestContext,
): Promise<{ balance: string; available: string }> {
  const res = await req.get('/api/billing/balance', { failOnStatusCode: false });
  expect(res.status(), 'GET /api/billing/balance').toBe(200);
  return (await res.json()) as { balance: string; available: string };
}

// ===========================================================================
// Desktop suite (chromium) — billing settings + advisor surfaces are
// desktop-shaped. Mirror the csv-import / dashboard project gate.
// ===========================================================================

test.describe('wallet-billing', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // BILLING-NOT-CONFIGURED — always runs on the default harness (no Stripe
  // env). No purchase UI; advisor is BYOK-only and unaffected (REQ-10.2/10.3).
  // -------------------------------------------------------------------------
  test.describe('billing not configured (graceful absence)', () => {
    test('Stripe unconfigured → config.enabled false, no purchase UI', async ({ page }) => {
      // GET /api/billing/config is authed, so register first (sets the session
      // cookie in the shared jar) before probing it.
      await setup(page, 'noconf');
      const cfg = await getBillingConfig(page.request);
      test.skip(cfg === null, 'GET /api/billing/config unavailable — billing routes not mounted');
      test.skip(
        cfg!.enabled,
        'Stack IS Stripe-configured — graceful-absence asserted by the configured block',
      );

      // The billing settings tab renders the graceful-absence state, NOT the
      // balance card or pack picker.
      await page.goto('/settings/billing');
      await expect(page.getByTestId('billing-disabled')).toBeVisible();
      await expect(page.getByTestId('billing-panel')).toHaveCount(0);
      await expect(page.getByTestId('balance-card')).toHaveCount(0);
      // No "Buy credits" heading or button renders (the BillingPanel pack picker
      // is absent). Match by role so the descriptive copy ("…buy credits…") does
      // not false-positive.
      await expect(page.getByRole('button', { name: 'Buy credits' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Buy credits' })).toHaveCount(0);

      // The config endpoint itself reports billing absent and offers no models
      // (no platform key configured ⇒ the no-BYOK picker has nothing to show).
      expect(cfg!.enabled).toBe(false);
      expect(cfg!.models).toEqual([]);

      // POST /checkout is a stable 402 BILLING_NOT_AVAILABLE, not a 500 — the
      // feature is absent, not broken.
      const checkout = await page.request.post('/api/billing/checkout', {
        data: { packId: 'pack_10' },
        failOnStatusCode: false,
      });
      expect(checkout.status()).toBe(402);
    });

    test('advisor BYOK-only unaffected: no key + no billing → "configure a key" surface', async ({
      page,
    }) => {
      await setup(page, 'byok');
      const cfg = await getBillingConfig(page.request);
      test.skip(cfg === null, 'GET /api/billing/config unavailable — billing routes not mounted');
      test.skip(cfg!.enabled, 'Stack IS Stripe-configured — see the configured block');

      // A user with no BYOK key on a billing-disabled instance cannot start a
      // conversation: the no-key surface stands (AdvisorPage canStartConversation
      // = hasProviderKey || platformEnabled; both false here). The composer is
      // absent — the advisor is unaffected by billing being off, exactly as
      // before this spec (REQ-10.3).
      await page.goto('/advisor/new');
      await expect(page.getByTestId('no-key-banner')).toBeVisible();
      await expect(page.getByTestId('composer')).toHaveCount(0);
    });
  });

  // -------------------------------------------------------------------------
  // STRIPE-CONFIGURED — the buy → credit → out-of-credits journey. Runs only
  // when the booted stack has STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (test
  // mode); otherwise skips with the exact env it needs.
  // -------------------------------------------------------------------------
  test.describe('Stripe configured (purchase → webhook credit → out-of-credits)', () => {
    // Playwright runs outside the app boot path, so it reads its signing secret
    // from the env directly (same exemption playwright.config.ts takes). There is
    // no `@/lib/config` in scope here.
    // eslint-disable-next-line no-restricted-syntax
    const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

    test('balance appears only AFTER the signed webhook, not on the success redirect', async ({
      page,
    }) => {
      const user = await setup(page, 'buy');
      const cfg = await getBillingConfig(page.request);
      test.skip(cfg === null, 'GET /api/billing/config unavailable — billing routes not mounted');
      test.skip(
        !cfg!.enabled || !WEBHOOK_SECRET,
        'Stripe test mode not configured on the booted stack — set STRIPE_SECRET_KEY + ' +
          'STRIPE_WEBHOOK_SECRET (test keys) in the api env AND export STRIPE_WEBHOOK_SECRET to ' +
          'the playwright process to run the purchase journey.',
      );

      const pack = cfg!.packs.find((p) => p.id === 'pack_10') ?? cfg!.packs[0];
      expect(pack, 'at least one credit pack offered').toBeTruthy();

      // (1) Create a REAL checkout session (no wallet write happens here — REQ-2.6).
      const checkoutRes = await page.request.post('/api/billing/checkout', {
        data: { packId: pack.id },
        failOnStatusCode: false,
      });
      expect(checkoutRes.status(), 'POST /api/billing/checkout').toBe(200);
      const { url } = (await checkoutRes.json()) as { url: string };
      expect(url, 'checkout returns a Stripe-hosted URL').toContain('http');

      // (2) Simulate the user RETURNING via the success redirect. The success_url
      // is /settings/billing — landing there must NOT have credited anything;
      // crediting is webhook-only (REQ-2.6). Assert REAL balance is still zero.
      await page.goto('/settings/billing');
      await expect(page.getByTestId('balance-card')).toBeVisible();
      const preWebhook = await readBalance(page.request);
      expect(preWebhook.balance, 'no credit on the success redirect (webhook-only)').toBe('0');
      await expect(page.getByTestId('balance-card')).toContainText('0 credits');

      // (3) Now Stripe settles: POST a validly-signed checkout.session.completed
      // (paid) carrying the same metadata snapshot the checkout created.
      const evt = checkoutCompletedEvent({
        userId: user.userId,
        packId: pack.id,
        creditGrant: pack.credits,
        amountMinor: pack.priceMinor,
        currency: pack.currency,
      });
      const wh = await postSignedWebhook(page.request, evt, WEBHOOK_SECRET);
      expect(wh.status, 'signed webhook accepted').toBe(200);
      expect(wh.outcome, 'webhook credited the wallet').toBe('credited');

      // (4) REAL post-webhook balance reflects the grant (assert the API truth,
      // not a UI stub).
      const postWebhook = await readBalance(page.request);
      expect(postWebhook.balance, 'balance credited after the webhook').toBe(pack.credits);
      expect(postWebhook.available).toBe(pack.credits);

      // (5) The UI now shows the credited balance after a reload.
      await page.reload();
      await expect(page.getByTestId('balance-card')).toContainText(`${pack.credits} credits`);

      // (6) Idempotency: redelivering the SAME event must not double-credit
      // (REQ-9.1/9.4) — the webhook_events unique constraint dedupes.
      const redeliver = await postSignedWebhook(page.request, evt, WEBHOOK_SECRET);
      expect(redeliver.status).toBe(200);
      expect(redeliver.outcome, 'redelivered event is a no-op duplicate').toBe('duplicate');
      const afterRedeliver = await readBalance(page.request);
      expect(afterRedeliver.balance, 'no double-credit on redelivery').toBe(pack.credits);
    });

    test('zero-balance advisor shows the out-of-credits state linking to Billing', async ({
      page,
    }) => {
      await setup(page, 'zero');
      const cfg = await getBillingConfig(page.request);
      test.skip(cfg === null, 'GET /api/billing/config unavailable — billing routes not mounted');
      test.skip(
        !cfg!.enabled,
        'Stripe not configured on the booted stack — see the suite header for the env needed.',
      );
      test.skip(
        cfg!.models.length === 0,
        'No platform model configured (no platform LLM key) — the no-BYOK composer/out-of-credits ' +
          'state needs config.models non-empty; set ANTHROPIC_API_KEY or OPENAI_API_KEY in the api env.',
      );

      // A platform-enabled, no-BYOK user with a ZERO balance can OPEN the
      // composer (canStartConversation = platformEnabled) but the pre-stream gate
      // refuses with INSUFFICIENT_CREDITS, which surfaces as the billing-refusal
      // banner linking to /settings/billing (Composer billingRefusal → "Add
      // credits"). Drive a platform turn to trigger the gate refusal.
      await page.goto('/advisor/new');
      await expect(page.getByTestId('composer')).toBeVisible();

      // Pick the first platform model, type, and send → the gate refuses (zero
      // balance) BEFORE any provider call (REQ-6.3/6.4). No deterministic LLM is
      // needed: the refusal is a pre-stream 402, not a streamed response.
      const picker = page.getByTestId('platform-model-picker');
      if (await picker.count()) {
        await picker.scrollIntoViewIfNeeded();
      }
      const input = page.getByTestId('composer').getByRole('textbox');
      await input.fill('What is my P&L this week?');
      await page.getByTestId('composer').getByRole('button', { name: 'Send message' }).click();

      // The out-of-credits state links to Billing (REQ-6.4).
      const refusal = page.getByTestId('billing-refusal');
      await expect(refusal).toBeVisible();
      await expect(refusal).toHaveAttribute('data-error-code', 'INSUFFICIENT_CREDITS');
      await expect(refusal.getByRole('link', { name: 'Add credits' })).toHaveAttribute(
        'href',
        /\/settings\/billing/,
      );
    });

    // -----------------------------------------------------------------------
    // Platform advisor TURN — credits deducted, usage history shows the turn
    // (provider/model/tokens/credits). BLOCKED on a deterministic LLM provider:
    // the booted stack exposes no out-of-process LLM stub seam (see suite
    // header + advisor-tools.spec.ts). NOT faked as passing.
    // -----------------------------------------------------------------------
    test.fixme('platform turn deducts credits and records usage history (needs an LLM stub seam)', async ({
      page,
    }) => {
      // To enable (the documented seam): boot the API with `OPENAI_BASE_URL` →
      // a local OpenAI-shaped SSE stub (sibling to the UW stub) scripting
      // token deltas + a `usage` frame, and configure a platform `OPENAI_API_KEY`
      // so config.models is non-empty. Then, after crediting via the signed
      // webhook above:
      //   1. open /advisor/new, pick the platform model, send a turn;
      //   2. await the streamed completion;
      //   3. assert GET /api/billing/balance dropped by the metered cost (a
      //      REAL deduction, not a UI stub);
      //   4. open /settings/billing and assert UsageHistory shows the turn with
      //      provider / model / tokens / credit cost;
      //   5. spend to zero and assert the next send hits the out-of-credits
      //      state (covered standalone by the zero-balance test above).
      await setup(page, 'turn');
    });
  });
});
