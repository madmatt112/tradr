import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { promoteToAdmin } from '../support/db';

/**
 * symbol-search-quotes e2e suite (Task 14).
 *
 * Drives the two calculator paths + graceful-absence against the REAL running
 * stack, with all SEC/quote egress redirected to local stubs so no e2e boot
 * touches the live SEC or API Ninjas hosts:
 *
 *   - SEC_TICKERS_URL      → e2e/support/sec-tickers-stub-server.ts (UNCONDITIONAL;
 *                            the boot-time `syncSymbolsIfStale()` runs under
 *                            NODE_ENV=development, so this MUST point at the stub
 *                            on every run — REQ-2.3/REQ-2.4(c)).
 *   - STOCK_QUOTE_BASE_URL → e2e/support/stock-quote-stub-server.ts (always).
 *   - STOCK_QUOTE_API_KEY  → arms the pull-quote capability (set by the shell).
 *
 * Cases:
 *   1. Stock path (ARMED — key set): autocomplete a prefix, pick a suggestion,
 *      pull the last price, see the ~15-min disclaimer, confirm sizing outputs.
 *   2. Absent-key path (UNARMED — key unset, the DEFAULT): the pull-quote button
 *      is absent from first paint; autocomplete still works.
 *   3. Option hand-off (UW stub): open the chain dialog from the options path,
 *      select a no-last-price row ⇒ entry blank + manual note, then a
 *      last-price row ⇒ entry = premium + OCC shown, then confirm the mode
 *      switch clears the carried-over price.
 *   4. Graceful SEC absence: with the SEC stub 403-ing, an admin refresh fails
 *      softly (no crash) and /search still serves — the app never falls over.
 *
 * The armed/unarmed cases are complementary and gated on whether the shell
 * exported STOCK_QUOTE_API_KEY, so the default (unarmed) run skips the stock
 * path cleanly and runs the absent-key path.
 */

// Standalone Playwright CLI context — same `process.env` carve-out as the other
// specs (no `@/lib/config` in scope here).
/* eslint-disable no-restricted-syntax */
const SEC_STUB_URL = `http://localhost:${Number(process.env.SEC_STUB_PORT ?? 4602)}`;
// ARMED when the shell exported a quote key (playwright.config.ts forwards it to
// the API's apiEnv). Then `isStockQuoteConfigured()` is true and the pull-quote
// button paints; unset ('') is the default absent-key path.
const ARMED = Boolean(process.env.STOCK_QUOTE_API_KEY);
/* eslint-enable no-restricted-syntax */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-symbols-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login call (the changelog/advisor
 * idiom): `/register` and `/login` are rate-limited per client IP and the
 * harness trusts the loopback proxy, so a unique `X-Forwarded-For` dodges the
 * shared bucket. The distinct 3rd octet (118) separates this spec from the
 * others so files never collide.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.118.${ipCounter % 254}`;
}

/**
 * Register a user via the real API and return it authenticated in the page's
 * browser context (POST /register sets the `session` cookie, which `page.request`
 * shares with the page). Returns the email so admin promotion can target it.
 */
async function registerAndAuthenticate(page: Page, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await page.request.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  return email;
}

/** Probe the stack — skip gracefully when no booted stack is reachable. */
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

/** Point the SEC stub at `ok` (serve fixture) or `fail` (403 like live SEC). */
async function setSecStubMode(req: APIRequestContext, mode: 'ok' | 'fail'): Promise<void> {
  const res = await req.post(`${SEC_STUB_URL}/__mode`, { data: { mode } });
  expect(res.status(), `sec stub mode → ${mode}`).toBe(200);
}

/**
 * Wait until bootstrap symbol population has finished (the fire-and-forget
 * `syncSymbolsIfStale()` runs after migrations on boot). Polling the authed
 * search API — rather than typing into the UI immediately — avoids a race where
 * the autocomplete caches an empty result fetched before population completed.
 */
async function awaitSymbolsPopulated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/symbols/search?q=AAPL');
        if (res.status() !== 200) return 0;
        const body = (await res.json()) as { results?: unknown[] };
        return body.results?.length ?? 0;
      },
      { timeout: 30_000, message: 'symbols never populated from the SEC stub' },
    )
    .toBeGreaterThan(0);
}

/** Save a UW market-data key on Settings → Advisor and wait for it to verify. */
async function saveMarketDataKey(page: Page, key: string): Promise<void> {
  await page.goto('/settings/advisor');
  const card = page.getByTestId('market-data-key-card');
  await expect(card).toBeVisible();
  await card.getByLabel('API key').fill(key);
  await card.getByRole('button', { name: /Save key|Replace key/ }).click();
  await expect(card.getByText('Key verified')).toBeVisible();
}

test.describe('symbol-search-quotes', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
    // Keep the SEC stub healthy so each test (and each retry) starts from a
    // source that serves the fixture, regardless of what a prior run left.
    await setSecStubMode(page.request, 'ok');
  });

  // -------------------------------------------------------------------------
  // 1. Stock path (ARMED): autocomplete → pull last price → disclaimer → sizing.
  // -------------------------------------------------------------------------
  test('stock path: autocomplete a ticker, pull the delayed last price, size the trade', async ({
    page,
  }) => {
    test.skip(!ARMED, 'STOCK_QUOTE_API_KEY unset — quote capability not armed.');

    await registerAndAuthenticate(page, 'stock');
    await awaitSymbolsPopulated(page);

    await page.goto('/calculator');
    await expect(page.getByRole('heading', { name: 'Trade Calculator' })).toBeVisible();

    // Autocomplete: type a prefix, the SEC-stub-backed suggestion appears, pick it.
    await page.locator('#symbol').fill('AAP');
    const option = page.getByRole('option', { name: /AAPL/ });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('#symbol')).toHaveValue('AAPL');

    // The pull-quote button paints only because the key arms the capability.
    const pull = page.getByRole('button', { name: 'Pull last price' });
    await expect(pull).toBeVisible();
    await pull.click();

    // The quote stub returns AAPL @ 187.32 → entry populated + ~15-min disclaimer.
    await expect(page.locator('#entryPrice')).toHaveValue('187.32');
    await expect(page.getByText('Last price is ~15 minutes delayed.')).toBeVisible();

    // Complete the inputs and confirm the sizing output renders.
    await page.locator('#stopLoss').fill('180');
    await page.locator('#dollarRisk').fill('100');
    await page.locator('#dollarRisk').press('Tab');
    await expect(page.getByText('Position Sizing')).toBeVisible();
    // `exact` avoids colliding with the page subtitle ("Plan position size …").
    await expect(page.getByText('Position size', { exact: true })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. Absent-key path (UNARMED, default): pull-quote absent; autocomplete works.
  // -------------------------------------------------------------------------
  test('absent-key path: no pull-quote button, autocomplete still works', async ({ page }) => {
    test.skip(ARMED, 'STOCK_QUOTE_API_KEY set — the absent-key path does not apply.');

    await registerAndAuthenticate(page, 'nokey');
    await awaitSymbolsPopulated(page);

    await page.goto('/calculator');
    await expect(page.getByRole('heading', { name: 'Trade Calculator' })).toBeVisible();

    // Autocomplete works without any quote key.
    await page.locator('#symbol').fill('AAP');
    const option = page.getByRole('option', { name: /AAPL/ });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('#symbol')).toHaveValue('AAPL');

    // The pull-quote affordance is absent from first paint (no probe call, no
    // flash) because the config query reports the capability off.
    await expect(page.getByRole('button', { name: 'Pull last price' })).toHaveCount(0);
    // And the quote-config endpoint confirms the unarmed state.
    const cfg = await page.request.get('/api/symbols/quote-config');
    expect(cfg.status()).toBe(200);
    expect((await cfg.json()).stockQuoteConfigured).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Option hand-off (UW stub): premium → entry + OCC; no-last-price → blank +
  //    manual note; mode switch clears the carried-over price.
  // -------------------------------------------------------------------------
  test('option hand-off: premium into entry with OCC, blank on no-last-price, cleared on mode switch', async ({
    page,
  }) => {
    await registerAndAuthenticate(page, 'options');
    // The chain viewer needs a verified UW key (per-user BYOK). Save it against
    // the UW stub (same flow as advisor-tools.spec.ts).
    await saveMarketDataKey(page, 'uw-e2e-test-key');

    await page.goto('/calculator');
    await expect(page.getByRole('heading', { name: 'Trade Calculator' })).toBeVisible();

    // Switch to the options path — the chain entry point renders only in options
    // mode (and the switch clears the entry/stop/target fields).
    await page.getByRole('tab', { name: 'Options' }).click();
    const entry = page.locator('#entryPrice');
    await expect(entry).toHaveValue('');

    // --- No-last-price row ⇒ entry stays blank + manual-entry note ---
    await page.getByRole('button', { name: 'Select from options chain' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.locator('#options-chain-symbol').fill('AAPL');
    // The strike-190 row from the UW stub has no last_price.
    await dialog
      .getByRole('row')
      .filter({ hasText: '190' })
      .getByRole('button', { name: 'Use' })
      .click();
    await expect(entry).toHaveValue('');
    await expect(page.getByText('No last trade — enter the premium manually.')).toBeVisible();

    // --- Last-price row ⇒ entry = the premium (5.25) + OCC shown ---
    await page.getByRole('button', { name: 'Select from options chain' }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('#options-chain-symbol').fill('AAPL');
    // The strike-200 row carries last_price 5.25 (the premium).
    await dialog
      .getByRole('row')
      .filter({ hasText: '5.25' })
      .getByRole('button', { name: 'Use' })
      .click();
    await expect(entry).toHaveValue('5.25');
    await expect(page.getByText('Selected contract: AAPL260717C00200000')).toBeVisible();
    // The premium hand-off cleared the earlier manual-entry note.
    await expect(page.getByText('No last trade — enter the premium manually.')).toHaveCount(0);

    // --- Mode switch clears the carried-over price (and the OCC note) ---
    await page.getByRole('tab', { name: 'Stock' }).click();
    await expect(entry).toHaveValue('');
    await expect(page.getByText('Selected contract:')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 4. Graceful SEC absence: SEC 403 ⇒ soft sync failure, no crash, /search serves.
  // -------------------------------------------------------------------------
  test('graceful SEC absence: an admin refresh against a down SEC fails softly and /search still serves', async ({
    page,
  }) => {
    const email = await registerAndAuthenticate(page, 'graceful');
    // Promote to admin so the refresh path is reachable (takes effect on the
    // next request — the auth middleware re-reads is_admin per request).
    await promoteToAdmin(email);

    try {
      // Take the SEC source down (403, like the live non-compliant-agent block).
      await setSecStubMode(page.request, 'fail');

      // Force a refresh: the sync catches the SEC 403 and resolves a soft error
      // outcome — it NEVER throws or 5xxes (REQ-2.3). Existing rows stay intact.
      const refresh = await page.request.post('/api/symbols/refresh', {
        headers: { 'X-Forwarded-For': uniqueIp() },
      });
      expect(refresh.status(), 'admin refresh must not 5xx when SEC is down').toBe(200);
      expect((await refresh.json()).status).toBe('error');

      // The app is still alive and /search still serves a 200 (no crash) — the
      // failed population never took the endpoint down.
      const search = await page.request.get('/api/symbols/search?q=A');
      expect(search.status()).toBe(200);
      expect(Array.isArray((await search.json()).results)).toBe(true);
    } finally {
      // Restore the source for any later suite / retry.
      await setSecStubMode(page.request, 'ok');
    }
  });
});
