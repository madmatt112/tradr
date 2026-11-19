import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

/**
 * unrealised-pnl e2e suite (Task 13, design.md Testing Strategy > End-to-end).
 *
 * Drives the real stack (no `page.route` stubs) with the quote provider
 * pointed at `e2e/support/stock-quote-stub-server.ts` (always) and armed only
 * when the shell exports `STOCK_QUOTE_API_KEY` — the `ARMED` pattern of
 * `e2e/tests/symbol-search-quotes.spec.ts:43`.
 *
 *   - Unarmed (default, always runs): the widget header is unchanged, the
 *     drawer note reads "Cost basis only, fees included.", and no request is
 *     sent to `/api/symbols/quotes` (Req 1.1, 1.4).
 *   - Armed (gated on the key): a long 10 MSFT @ 400 shows last 421.50,
 *     unrealised +215.00 and +5.38% on the widget, the drawer and the detail
 *     page (Req 5.1, 6.1, 7.3); an option position shows its reason (Req 4.2);
 *     a EUR-account stock position shows the currency reason (Req 4.4). The
 *     MSFT price comes from the stub's fixed `PRICES.MSFT` (421.50,
 *     `e2e/support/stock-quote-stub-server.ts:38-42`).
 */

// Standalone Playwright CLI context, same `process.env` carve-out as
// symbol-search-quotes.spec.ts — no `@/lib/config` in scope here.
/* eslint-disable no-restricted-syntax */
const ARMED = Boolean(process.env.STOCK_QUOTE_API_KEY);
/* eslint-enable no-restricted-syntax */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-upnl-${label}-${randomUUID()}@example.com`;
}

/**
 * A unique, non-loopback IP per register call (the drawer/dashboard idiom —
 * `TRUSTED_PROXIES=127.0.0.1` on the booted stack trusts it). Octet 133 is
 * unused by any other spec sharing the single-worker run.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.133.${ipCounter % 254}`;
}

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

async function registerAndAuthenticate(page: Page, label: string): Promise<void> {
  const email = uniqueEmail(label);
  const res = await page.request.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
}

async function createAccount(
  req: APIRequestContext,
  name: string,
  currency: string,
): Promise<string> {
  const res = await req.post('/api/accounts', { data: { name, currency } });
  expect(res.status(), `POST /accounts ${currency}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Past the onboarding zero-state (dashboard.spec.ts's `registerUser` idiom). */
async function markOnboardingDone(req: APIRequestContext): Promise<void> {
  const res = await req.patch('/api/users/me/onboarding', { data: { status: 'done' } });
  expect(res.status(), 'PATCH onboarding').toBe(200);
}

interface SeedPosition {
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  assetType: 'stock' | 'option';
  price: string;
  quantity: string;
  fees: string;
  filledAt: string;
}

/** Create a position, add its entry fill, and open it. Returns the position id. */
async function seedOpenPosition(req: APIRequestContext, seed: SeedPosition): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: {
      accountId: seed.accountId,
      symbol: seed.symbol,
      side: seed.side,
      assetType: seed.assetType,
    },
  });
  expect(posRes.status(), `POST /positions ${seed.symbol}`).toBe(201);
  const position = (await posRes.json()) as { id: string };

  const fillRes = await req.post(`/api/positions/${position.id}/fills`, {
    data: {
      type: 'entry',
      price: seed.price,
      quantity: seed.quantity,
      fees: seed.fees,
      filledAt: seed.filledAt,
    },
  });
  expect(fillRes.status(), `POST entry fill ${seed.symbol}`).toBe(201);

  const openRes = await req.post(`/api/positions/${position.id}/open`, { data: {} });
  expect(openRes.status(), `POST /positions/:id/open ${seed.symbol}`).toBe(200);

  return position.id;
}

/** Wait for the five default widgets (or click past the empty-state button once). */
async function ensureDefaultLayoutPopulated(page: Page): Promise<void> {
  const emptyHeading = page.getByRole('heading', { name: 'Your dashboard is empty' });
  if (await emptyHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Use the default layout' }).click();
  }
  await expect(page.locator('section[data-widget-id]').first()).toBeVisible();
}

const OPEN_POSITIONS_WIDGET = 'section[data-widget-type="open-positions"]';

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /open side drawer/i }).click();
  await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
}

const FILLED_AT = '2026-10-01T14:30:00.000Z';

test.describe('unrealised-pnl', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Unarmed (default, always runs): no key configured anywhere on screen.
  // -------------------------------------------------------------------------
  test('unarmed: no column, no reason text, no quote request', async ({ page }) => {
    test.skip(ARMED, 'STOCK_QUOTE_API_KEY set — the unarmed case does not apply.');

    await registerAndAuthenticate(page, 'unarmed');
    const accountId = await createAccount(page.request, 'E2E Unarmed USD', 'USD');
    await markOnboardingDone(page.request);
    await seedOpenPosition(page.request, {
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      price: '150.00',
      quantity: '10',
      fees: '1.00',
      filledAt: FILLED_AT,
    });

    const quoteRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/symbols/quotes')) quoteRequests.push(req);
    });

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
    await ensureDefaultLayoutPopulated(page);

    const widget = page.locator(OPEN_POSITIONS_WIDGET);
    await expect(widget.getByText('AAPL')).toBeVisible();

    // Req 1.3: the header is exactly as it was before this feature.
    const headers = await widget.locator('th').allTextContents();
    expect(headers).toEqual(['Symbol', 'Side', 'Asset', 'Quantity', 'Opened', 'Actions']);
    await expect(widget.getByText('Cost basis only')).toHaveCount(0);
    await expect(widget.getByText(/Prices are delayed/)).toHaveCount(0);

    await openDrawer(page);
    await page.getByRole('tab', { name: /open positions/i }).click();
    await expect(
      page.getByTestId('side-drawer').getByText('Cost basis only, fees included.'),
    ).toBeVisible();

    // No batch quote request was ever sent, on either surface.
    expect(quoteRequests.map((r) => r.url())).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Armed (gated on STOCK_QUOTE_API_KEY): mark-to-market across all three
  // surfaces, plus the option and currency reasons.
  // -------------------------------------------------------------------------
  test('armed: marks MSFT to market on the widget, drawer and detail page; shows option and currency reasons', async ({
    page,
  }) => {
    test.skip(!ARMED, 'STOCK_QUOTE_API_KEY unset — the armed case does not apply.');

    await registerAndAuthenticate(page, 'armed');
    const usdAccountId = await createAccount(page.request, 'E2E Armed USD', 'USD');
    const eurAccountId = await createAccount(page.request, 'E2E Armed EUR', 'EUR');
    await markOnboardingDone(page.request);

    // Long 10 MSFT @ 400, no fees: open cost basis 4000.00. The stub prices
    // MSFT at 421.50 (stock-quote-stub-server.ts:40), so market value is
    // 4215.00 — unrealised +215.00, +5.38% (215 / 4000 * 100).
    const msftPositionId = await seedOpenPosition(page.request, {
      accountId: usdAccountId,
      symbol: 'MSFT',
      side: 'long',
      assetType: 'stock',
      price: '400.00',
      quantity: '10',
      fees: '0.00',
      filledAt: FILLED_AT,
    });

    // An option row: never sent to the quote endpoint, shows the option reason.
    await seedOpenPosition(page.request, {
      accountId: usdAccountId,
      symbol: 'TSLA260619C300',
      side: 'long',
      assetType: 'option',
      price: '5.00',
      quantity: '1',
      fees: '0.00',
      filledAt: FILLED_AT,
    });

    // A EUR-account stock row: shows the currency reason.
    await seedOpenPosition(page.request, {
      accountId: eurAccountId,
      symbol: 'VOD',
      side: 'long',
      assetType: 'stock',
      price: '10.00',
      quantity: '5',
      fees: '0.00',
      filledAt: FILLED_AT,
    });

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
    await ensureDefaultLayoutPopulated(page);

    const widget = page.locator(OPEN_POSITIONS_WIDGET);
    await expect(widget.getByText('MSFT')).toBeVisible();
    const widgetHeaders = await widget.locator('th').allTextContents();
    expect(widgetHeaders).toEqual([
      'Symbol',
      'Side',
      'Asset',
      'Quantity',
      'Opened',
      'Last',
      'Unrealised P&L',
      'Unrealised %',
      'Actions',
    ]);

    const msftWidgetRow = widget.getByRole('row').filter({ hasText: 'MSFT' });
    await expect(msftWidgetRow).toContainText('$421.50');
    await expect(msftWidgetRow).toContainText('+$215.00');
    await expect(msftWidgetRow).toContainText('+5.38%');

    const optionWidgetRow = widget.getByRole('row').filter({ hasText: 'TSLA260619C300' });
    await expect(optionWidgetRow).toContainText('Cost basis only');
    await expect(optionWidgetRow).toContainText(
      'Delayed quotes cover stocks, not option contracts.',
    );

    const eurWidgetRow = widget.getByRole('row').filter({ hasText: 'VOD' });
    await expect(eurWidgetRow).toContainText('Cost basis only');
    await expect(eurWidgetRow).toContainText('Quotes are in USD; this account is in EUR');

    await expect(widget.getByText(/Prices are delayed about 15 minutes/)).toBeVisible();

    // --- Drawer's Open Positions tab ---
    await openDrawer(page);
    await page.getByRole('tab', { name: /open positions/i }).click();
    const drawer = page.getByTestId('side-drawer');
    await expect(drawer.getByText('Cost basis includes entry fees.')).toBeVisible();

    const msftDrawerRow = drawer.getByRole('link', { name: /MSFT/ });
    await expect(msftDrawerRow).toContainText('$421.50');
    await expect(msftDrawerRow).toContainText('+$215.00');
    await expect(msftDrawerRow).toContainText('+5.38%');

    // --- Position detail page ---
    await page.goto(`/positions/${msftPositionId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('MSFT');

    const lastPriceCard = page.locator('[data-slot="card"]', { hasText: 'Last Price' });
    await expect(lastPriceCard).toContainText('$421.50');

    const unrealisedPnlCard = page.locator('[data-slot="card"]', { hasText: 'Unrealised P&L' });
    await expect(unrealisedPnlCard).toContainText('+$215.00');

    const unrealisedPercentCard = page.locator('[data-slot="card"]', { hasText: 'Unrealised %' });
    await expect(unrealisedPercentCard).toContainText('+5.38%');

    // Scoped to `#root` — the drawer portal (document.body sibling of
    // `#root`) keeps its own copy of this text in the DOM even while closed
    // (it slides off-screen via `translate-x-full`, not `display: none`).
    await expect(
      page.locator('#root').getByText(/Prices are delayed about 15 minutes/),
    ).toBeVisible();
  });
});
