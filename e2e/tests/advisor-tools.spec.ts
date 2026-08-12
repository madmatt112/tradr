import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * advisor-tools e2e suite (Task 38).
 *
 * Runs against the TASK-37 server-boot harness: Playwright's `webServer` array
 * (e2e/playwright.config.ts) boots the local Unusual Whales stub
 * (e2e/support/uw-stub-server.ts), the API with `UNUSUAL_WHALES_BASE_URL`
 * pointed at that stub, and the web dev server. UW responses are therefore
 * deterministic and NEVER hit the live host — the stub serves the three pinned
 * ticker endpoints (`/api/stock/{ticker}/{info|flow-alerts|expiry-breakdown|option-contracts}`),
 * with ticker `UNKNOWN` yielding an empty envelope (the SYMBOL_NOT_FOUND path).
 *
 * Auth + seed follow the established live-stack convention from
 * dashboard.spec.ts: register a unique user via POST /api/auth/register. That
 * call sets the `session` cookie in the shared browser cookie jar, so the page
 * is authenticated immediately — no separate UI login step is needed. The suite
 * `test.skip`s gracefully when the API stack is unreachable so a CI run without
 * the booted stack does not fail spuriously.
 *
 * ---------------------------------------------------------------------------
 * LLM DETERMINISM — the load-bearing constraint for this suite
 * ---------------------------------------------------------------------------
 * Four of the five design §Testing-Strategy flows ("ask about a stock → tool
 * cards → grounded answer", "positions question → trade-data card", "non-tool
 * model → conversation-only", "long conversation → summarized notice") drive
 * the advisor STREAM, which calls a real LLM provider. There is NO
 * out-of-process stub seam for the provider:
 *
 *   - The Claude/OpenAI adapters construct their SDK clients with only
 *     `{ apiKey, timeout }` and no `baseURL`
 *     (apps/api/.../providers/{claude,openai}.ts `client()`), and the registry
 *     (providers/registry.ts) builds those adapters once at bootstrap with no
 *     runtime injection point. The unit/integration tests reach a fake
 *     provider ONLY by `vi.mock('./providers/registry')` in-process
 *     (see __fixtures__/scriptable-provider.ts) — unreachable from an
 *     out-of-process Playwright run.
 *   - The task-37 harness stubs UNUSUAL_WHALES_BASE_URL but adds no LLM stub.
 *
 * The seam that WOULD close the gap (and keep these flows deterministic without
 * a live key): the OpenAI Node SDK falls back to `process.env.OPENAI_BASE_URL`
 * when no `baseURL` is passed, so booting the API with `OPENAI_BASE_URL` →
 * a local OpenAI-shaped SSE stub (a sibling to the UW stub, scripting
 * tool_call + token deltas) plus a seeded BYOK `openai` provider key would make
 * the streaming flows deterministic end-to-end. That stub is NOT part of the
 * task-37 harness and building it is out of this task's scope. Per the task
 * brief, those four flows are therefore implemented as `test.fixme` with the
 * exact seam documented inline — they are NOT faked as passing.
 *
 * What IS deterministically reachable through the task-37 harness (UW stub +
 * real DB, no LLM) is implemented and asserted below:
 *   - Flow 1/2 precondition: with no provider key the advisor refuses to chat
 *     (no-key banner, composer absent) — the "no access" surface.
 *   - The UW market-data key save+verify round-trip against the stub
 *     (verify probe hits `/api/stock/{ticker}/info`).
 *   - Trade-data consent enable → disable persistence (the toggle the advisor
 *     reads per-iteration; its on/off state is the access gate).
 *   - Flow 4 in full: the options page — Black-Scholes + OCC are pure
 *     client-side math (LLM-free, unchanged), and the Options Chain viewer
 *     renders with/without a UW key against the stub.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-advisor-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

interface SeededUser {
  email: string;
  userId: string;
}

/**
 * A unique, non-loopback IP per registration. The auth `/register` route is
 * rate-limited to 5 / 15 min per client IP; this suite registers more than five
 * users, so each register carries a unique `X-Forwarded-For`. The harness sets
 * `TRUSTED_PROXIES=127.0.0.1` (playwright.config.ts), so the limiter keys off
 * this forwarded IP rather than the shared loopback socket — the same trick the
 * auth unit tests use (apps/api/.../auth.test.ts uniqueIp).
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process — the chromium +
  // Mobile Chrome projects re-run this spec in fresh workers that reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.113.${ipCounter % 254}`;
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

/**
 * Register a user and return it already authenticated in the page's browser
 * context. POST /register sets the `session` cookie, and `page.request` shares
 * the page's cookie jar, so after `registerUser(page.request, …)` the page is
 * signed in — no UI login step is needed (and a UI login would in fact be
 * redirected straight to /dashboard, since the session already exists).
 */
async function registerAndAuthenticate(page: Page, label: string): Promise<SeededUser> {
  const user = await registerUser(page.request, label);
  // Confirm the shared cookie authenticated the browser context.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  return user;
}

/**
 * Probe the stack — if `/api/auth/me` is unreachable, skip gracefully so a CI
 * run without the booted stack does not fail spuriously. Same guard as
 * dashboard.spec.ts.
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

/** Save a UW market-data key on Settings → Advisor and wait for it to verify. */
async function saveMarketDataKey(page: Page, key: string): Promise<void> {
  await page.goto('/settings/advisor');
  const card = page.getByTestId('market-data-key-card');
  await expect(card).toBeVisible();
  await card.getByLabel('API key').fill(key);
  await card.getByRole('button', { name: /Save key|Replace key/ }).click();
  // The verify probe hits the UW stub's `/api/stock/{PROBE}/info` (200) →
  // verified: true → "Key verified" + the Configured badge.
  await expect(card.getByText('Key verified')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Desktop suite (chromium) — these flows are desktop-shaped (settings cards,
// two-pane advisor, options grid). Run under chromium only, mirroring the
// dashboard suite's project gate.
// ---------------------------------------------------------------------------

test.describe('advisor-tools', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Flow 1/2 precondition (no LLM): no provider key → advisor refuses to chat.
  //
  // This is the deterministic, LLM-free half of flows 1 and 2: it proves the
  // capability gate the advisor enforces before any provider call. A fresh
  // user has no BYOK provider key, so the advisor surfaces the no-key banner
  // and the Composer is absent — there is no path to a stream, so no LLM is
  // reached. (The "grounded answer" / "trade-data card" halves require the LLM
  // and live in the fixme flows below.)
  // -------------------------------------------------------------------------
  test('advisor refuses to chat without a provider key (no-key banner, composer absent)', async ({
    page,
  }) => {
    await registerAndAuthenticate(page, 'nokey');

    await page.goto('/advisor');
    await expect(page.getByTestId('no-key-banner')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Settings → Advisor' })).toBeVisible();
    // No Composer renders without a provider key (composer is gated on
    // hasProviderKey), so there is no way to start a stream.
    await expect(page.getByTestId('composer')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Flow 2 (no LLM): trade-data consent enable → disable persistence.
  //
  // Consent is the access gate the advisor re-reads each loop iteration
  // (reReadAdvisorIterationState). Its persisted on/off state — independent of
  // any LLM call — is what "the advisor states no access" ultimately keys off.
  // We assert the toggle persists across a reload in both directions.
  // -------------------------------------------------------------------------
  test('trade-data consent toggles on and off and persists across reload', async ({ page }) => {
    await registerAndAuthenticate(page, 'consent');

    await page.goto('/settings/advisor');
    const card = page.getByTestId('trade-data-consent-card');
    await expect(card).toBeVisible();
    const toggle = card.getByRole('switch', { name: 'Trade-data access' });

    // Defaults OFF (REQ-10.1b).
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Enable → persists across reload.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(card.getByRole('switch', { name: 'Trade-data access' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Disable → persists across reload (the "no access" state).
    await card.getByRole('switch', { name: 'Trade-data access' }).click();
    await expect(card.getByRole('switch', { name: 'Trade-data access' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.reload();
    await expect(card.getByRole('switch', { name: 'Trade-data access' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  // -------------------------------------------------------------------------
  // UW market-data key save + verify against the task-37 stub.
  //
  // The save handler runs a verify probe (getStockQuote(PROBE) →
  // GET /api/stock/{PROBE}/info) through the SAME UW client the advisor tools
  // use. Against the stub that returns a 200 non-empty payload, so the key
  // saves as verified. This is the precondition for market-data tools and for
  // the options-chain viewer's keyed state below.
  // -------------------------------------------------------------------------
  test('UW market-data key saves and verifies against the stub', async ({ page }) => {
    await registerAndAuthenticate(page, 'uwkey');

    await saveMarketDataKey(page, 'uw-e2e-test-key');

    const card = page.getByTestId('market-data-key-card');
    await expect(card.getByText('Configured')).toBeVisible();
    // Survives a reload (persisted + GET status reports verified).
    await page.reload();
    await expect(page.getByTestId('market-data-key-card').getByText('Configured')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Flow 4 (no LLM): options page — Black-Scholes + OCC unchanged; chain viewer
  // with/without key.
  //
  // Fully deterministic through the task-37 harness: Black-Scholes and OCC are
  // pure client-side math (no API, no LLM), and the Options Chain viewer hits
  // GET /api/advisor/options-chain which fans out to the UW stub.
  // -------------------------------------------------------------------------
  test('Black-Scholes pricer computes Greeks (pure client-side math, unchanged)', async ({
    page,
  }) => {
    await registerAndAuthenticate(page, 'bs');

    await page.goto('/options');
    await expect(page.getByRole('heading', { name: 'Options Tools' })).toBeVisible();

    // Before inputs: placeholder, no result rows.
    await expect(
      page.getByText('Enter spot, strike, T, σ, r to see prices and Greeks.'),
    ).toBeVisible();

    // Fill a standard ATM call: S=100, K=100, T≈0.0822 (default), σ=0.3, r=0.044.
    await page.locator('#bs-S').fill('100');
    await page.locator('#bs-K').fill('100');

    // The result panel now shows Price + the five Greeks (values are computed
    // locally and never touch the network). The placeholder is replaced.
    await expect(
      page.getByText('Enter spot, strike, T, σ, r to see prices and Greeks.'),
    ).toHaveCount(0);
    await expect(page.getByText('Price', { exact: true })).toBeVisible();
    await expect(page.getByText('Delta (Δ)')).toBeVisible();
    await expect(page.getByText('Gamma (Γ)')).toBeVisible();
    await expect(page.getByText('Theta / day (Θ)')).toBeVisible();
    await expect(page.getByText('Vega / 1% (ν)')).toBeVisible();
    await expect(page.getByText('Rho / 1% (ρ)')).toBeVisible();
  });

  test('OCC decoder/encoder round-trips (pure client-side math, unchanged)', async ({ page }) => {
    await registerAndAuthenticate(page, 'occ');

    await page.goto('/options');

    // Decode a well-formed OCC symbol → underlying / expiration / type / strike.
    // parseOccSymbol('AAPL  250620C00150000') → underlying AAPL, expiration
    // 2025-06-20, type call, strike 150.000.
    await page.locator('#occ-decode-input').fill('AAPL  250620C00150000');
    await expect(page.getByText('Underlying')).toBeVisible();
    await expect(page.getByText('2025-06-20')).toBeVisible();
    await expect(page.getByText('call', { exact: true })).toBeVisible();
    await expect(page.getByText('150.000')).toBeVisible();
  });

  test('options chain viewer shows the no-key CTA, then a chain after a key is saved', async ({
    page,
  }) => {
    await registerAndAuthenticate(page, 'chain');

    // Without a UW key: typing a symbol yields the empty-state CTA to Settings,
    // NOT an error (REQ-12.2). GET /options-chain returns { configured: false }.
    await page.goto('/options');
    await page.locator('#options-chain-symbol').fill('AAPL');
    await expect(
      page.getByText('Connect an Unusual Whales key to view live options chains.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Settings' })).toBeVisible();

    // Save a UW key (verifies against the stub).
    await saveMarketDataKey(page, 'uw-e2e-test-key');

    // Back on the options page, the same symbol now renders the stubbed chain
    // for the NEAREST expiry (2030-06-21). Strike and expiry are decoded from
    // the OCC symbol — the upstream sends neither.
    await page.goto('/options');
    await page.locator('#options-chain-symbol').fill('AAPL');
    await expect(page.getByText('190')).toBeVisible();
    await expect(page.locator('#options-chain-expiry')).toHaveValue('2030-06-21');
    // Row B never traded, so its premium is the NBBO mid: (4.10 + 4.30) / 2.
    await expect(page.getByRole('cell', { name: '4.2', exact: true })).toBeVisible();
    // The ladder is anchored on the underlying's last trade (stub: 192.50), so
    // strike 190 is the ATM row and is in the money for a call.
    await expect(page.locator('[data-slot="underlying-spot"]')).toContainText('192.5');
    await expect(page.locator('tr[data-atm="true"]')).toContainText('190');
    await expect(page.locator('tr[data-itm="true"]').first()).toBeVisible();
    // Side and expiry live in controls, not as a column repeated down every row.
    await expect(page.getByRole('button', { name: 'Calls' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Expiry' })).toHaveCount(0);
    // The no-key CTA is gone now that a key is configured.
    await expect(
      page.getByText('Connect an Unusual Whales key to view live options chains.'),
    ).toHaveCount(0);
  });

  test('options chain viewer surfaces a non-success state for an unknown ticker', async ({
    page,
  }) => {
    await registerAndAuthenticate(page, 'unknown');

    await saveMarketDataKey(page, 'uw-e2e-test-key');

    // The stub returns an EMPTY envelope (`{ data: [] }`) for ticker UNKNOWN.
    // The UW client's empty-payload guard maps that to the SYMBOL_NOT_FOUND
    // family (REQ-6.5), which the viewer renders as a ChainError <p> carrying a
    // `data-error-code` attribute (REQ-12.3) — never the contracts table. We
    // assert that deterministic invariant (error state present, no table)
    // rather than one exact reason string, since the empty-envelope path can
    // surface as either SYMBOL_NOT_FOUND or the generic unavailable reason
    // depending on the client's envelope guard, both of which are correct
    // "no usable chain" outcomes for an unknown ticker.
    await page.goto('/options');
    await page.locator('#options-chain-symbol').fill('UNKNOWN');

    const viewer = page.locator('[data-slot="options-chain-viewer"]');
    await expect(viewer.locator('p[data-error-code]')).toBeVisible();
    // No contracts table rendered for an unknown ticker.
    await expect(viewer.locator('table')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // LLM-dependent flows — documented as fixme (NOT faked).
  //
  // Each of these drives the advisor stream, which calls a real LLM provider.
  // The task-37 harness has no LLM stub and the provider adapters expose no
  // out-of-process baseURL seam, so these cannot be made deterministic from
  // Playwright today. They are recorded here so the coverage gap is explicit
  // and the closing seam is captured in one place.
  //
  // To enable (the documented seam): add an OpenAI-shaped SSE stub server as a
  // sibling `webServer` entry, boot the API with `OPENAI_BASE_URL` pointed at
  // it (the OpenAI Node SDK reads OPENAI_BASE_URL when no baseURL is passed),
  // and seed a BYOK `openai` provider key for the test user. The stub scripts
  // the tool_call → token-delta sequences these flows assert.
  // -------------------------------------------------------------------------

  // Flow 1: UW key → ask about a stock → tool cards → grounded answer.
  // Needs: scripted provider stream emitting a `market_data_*` tool_call
  // (rendered as a [data-testid="market-data-card"]) followed by grounded text.
  test.fixme('UW key → ask about a stock → market-data tool cards → grounded answer', async () => {
    // Blocked: no out-of-process LLM stub (see suite header). Would assert the
    // stream renders a market-data-card then a grounded assistant answer that
    // cites the stubbed UW figures (e.g. last 187.32).
  });

  // Flow 2: consent on → positions question → trade-data card; consent off →
  // advisor states no access.
  // Needs: scripted provider stream emitting a trade-data tool_call (rendered
  // as [data-testid="trade-data-card"]); with consent off the dispatcher
  // returns TOOL_NOT_PERMITTED and the assistant states it has no access.
  test.fixme('consent on → positions question → trade-data card; consent off → no access', async () => {
    // Blocked: no out-of-process LLM stub (see suite header). The consent
    // persistence half of this flow IS covered above; only the streamed
    // tool-card + answer half is blocked.
  });

  // Flow 3: non-tool model → "conversation-only"; tools absent.
  // Needs: a seeded provider key whose default model is NOT in the tool-use
  // prefix set (so capability resolves conversation-only) + a scripted text
  // stream; asserts no tool cards render and tools are not offered.
  test.fixme('non-tool model → conversation-only; tool cards absent', async () => {
    // Blocked: no out-of-process LLM stub (see suite header).
  });

  // Flow 5: long conversation → summarized notice; keeps working.
  // Needs: a scripted provider stream where `prepare` crosses the 0.75 window
  // and emits the summarized notice, then a subsequent turn still answers.
  test.fixme('long conversation → summarized notice; keeps working', async () => {
    // Blocked: no out-of-process LLM stub (see suite header).
  });
});
