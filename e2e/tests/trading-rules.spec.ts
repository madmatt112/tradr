import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Trading-rules e2e suite — the design's End-to-End Testing section run against
 * the booted stack (Testing Strategy, End-to-end).
 *
 * One journey, the decomposition's verification scenario:
 *
 *  1. Register a user and create a funded account through the API.
 *  2. Define three rules through the Settings Rules tab: a critical,
 *     account-scoped `max_risk_amount`; an `allowed_directions` (long); and an
 *     `allowed_markets` (stocks). Two pass, one breaches.
 *  3. Open a position that breaches the critical rule. It SAVES (rules are
 *     scored, never blocking), and the detail's compliance card shows the breach
 *     — measured against the limit, weighted `Critical` — and the weighted score
 *     (100 × pass 3 ÷ (pass 3 + breach 3) = 50), Provisional while open.
 *  4. Close it; a second, compliant closed position joins it. The performance
 *     page's Compliance panel shows the rate (50.0%) and the compliant /
 *     non-compliant split (one each).
 *  5. Disabling the critical rule through its switch rescores the detail to 100
 *     with no breaches.
 *  6. A second user sees none of the first user's rules — the Rules tab shows the
 *     empty state and `GET /api/trading-rules` returns `[]`.
 *
 * ASSERTIONS ARE ON THE DOM AND THE NETWORK, NEVER ON REACT STATE — the score
 * and breach are read off the compliance card's text, the split off the panel's
 * rows, and the rule vocabulary off `GET /api/trading-rules`, all things a user
 * or a proxy could see. `ensureStackOrSkip` skips (not fails) when the API is
 * down, matching every other live suite here. This spec is NOT env-gated.
 */

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-rules-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP (5 / 15 min) and the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1` in playwright.config.ts), so a forwarded IP is
 * what the limiter keys off. The third octet — 128 — is this spec's own; every
 * other suite's range is taken. `process.pid` namespaces the worker.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.128.${ipCounter % 254}`;
}

/**
 * Register a user; the session cookie lands on `req`, so the returned context
 * stays authenticated as this user for the API-side setup and assertions.
 */
async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
}

/** Log in through the form. A unique forwarded IP keeps logins out of one bucket. */
async function loginViaUi(page: Page, email: string): Promise<void> {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Skip gracefully when the API is not up, rather than failing the run. */
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

// A May-2026 window: both positions go flat inside it, so the performance page's
// month timeframe brackets exactly them.
const ENTRY_AT = '2026-05-04T14:30:00.000Z';
const EXIT_AT = '2026-05-05T14:30:00.000Z';
const PERF_URL =
  '/performance?granularity=month&start=2026-05-01T00:00:00.000Z&end=2026-06-01T00:00:00.000Z&tz=UTC';

/** A funded account over the API — the Rules tab is the surface under test. */
async function createAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD', startingBalance: '10000' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `POST /accounts ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * An OPEN long stock position whose risk breaches the critical `max_risk_amount`
 * rule: risk = |entry − stop| × qty = |150 − 140| × 10 = 100 > the 50 limit. The
 * entry fill precedes `/open` (the API refuses to open a position with none).
 */
async function openBreachingPosition(req: APIRequestContext, accountId: string): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock', stopLoss: '140' },
  });
  expect(posRes.status(), 'POST /positions (breaching)').toBe(201);
  const id = ((await posRes.json()) as { id: string }).id;

  const entry = await req.post(`/api/positions/${id}/fills`, {
    data: { type: 'entry', price: '150.00', quantity: '10', fees: '0', filledAt: ENTRY_AT },
  });
  expect(entry.status(), 'POST entry fill (breaching)').toBe(201);

  const open = await req.post(`/api/positions/${id}/open`, { data: { openedAt: ENTRY_AT } });
  // It SAVES despite the breach — rules are scored, never blocking (REQ-5.1).
  expect(open.status(), 'POST /open (breaching)').toBe(200);
  return id;
}

/** Fully exit a position — a reconciling exit fill auto-closes it at its own
 * `filledAt` (positions.service.ts addFill), so no separate `/close` is needed. */
async function closePosition(req: APIRequestContext, id: string, exitPrice: string): Promise<void> {
  const exit = await req.post(`/api/positions/${id}/fills`, {
    data: { type: 'exit', price: exitPrice, quantity: '10', fees: '0', filledAt: EXIT_AT },
  });
  expect(exit.status(), 'POST exit fill').toBe(201);
  const detail = await req.get(`/api/positions/${id}`);
  expect(((await detail.json()) as { status: string }).status, 'auto-closed on full exit').toBe(
    'closed',
  );
}

/**
 * A CLOSED long stock position that passes every rule: risk = |150 − 149| × 10 =
 * 10 ≤ 50, long, stock. Scores 100 → compliant, so it is the compliant half of
 * the performance panel's split.
 */
async function createCompliantClosedPosition(
  req: APIRequestContext,
  accountId: string,
): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: 'MSFT', side: 'long', assetType: 'stock', stopLoss: '149' },
  });
  expect(posRes.status(), 'POST /positions (compliant)').toBe(201);
  const id = ((await posRes.json()) as { id: string }).id;

  const entry = await req.post(`/api/positions/${id}/fills`, {
    data: { type: 'entry', price: '150.00', quantity: '10', fees: '0', filledAt: ENTRY_AT },
  });
  expect(entry.status(), 'POST entry fill (compliant)').toBe(201);
  const open = await req.post(`/api/positions/${id}/open`, { data: { openedAt: ENTRY_AT } });
  expect(open.status(), 'POST /open (compliant)').toBe(200);
  await closePosition(req, id, '151.00');
  return id;
}

async function fetchRules(req: APIRequestContext): Promise<{ id: string; description: string }[]> {
  const res = await req.get('/api/trading-rules');
  expect(res.status(), 'GET /trading-rules').toBe(200);
  return (await res.json()) as { id: string; description: string }[];
}

// ---------------------------------------------------------------------------
// Rules-tab helpers — drive the RuleDialog (design C9) through its real DOM.
// ---------------------------------------------------------------------------

/** Pick an option from a shadcn/Radix Select by its trigger label and option text. */
async function selectByLabel(page: Page, label: string, option: string): Promise<void> {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const RULES_TAB = '[data-slot="rules-settings"]';

/** The critical, account-scoped `max_risk_amount` rule (limit 50 in the account
 * currency). Created through the tab so the whole create path is exercised. */
async function createMaxRiskAmountRule(page: Page, accountName: string): Promise<void> {
  await page.getByRole('button', { name: 'New rule' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New rule' })).toBeVisible();
  await selectByLabel(page, 'Type', 'Max risk amount');
  await dialog.getByLabel('Amount').fill('50');
  await selectByLabel(page, 'Weight', 'Critical');
  await selectByLabel(page, 'Account scope', accountName);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
}

/** A rule built from a checkbox set (allowed directions / allowed markets). */
async function createSetRule(
  page: Page,
  typeLabel: string,
  optionLabel: string,
  weightLabel: string,
): Promise<void> {
  await page.getByRole('button', { name: 'New rule' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New rule' })).toBeVisible();
  await selectByLabel(page, 'Type', typeLabel);
  await dialog.getByText(optionLabel, { exact: true }).click();
  await selectByLabel(page, 'Weight', weightLabel);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
}

// The compliance card on the position detail (design C10). Located by its title.
function complianceCard(page: Page) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Compliance' }) });
}

test.describe('trading rules', () => {
  // Desktop only. The journey drives Settings tabs, dialogs and the performance
  // page; re-running it at a mobile width buys no rule-scoring coverage.
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile);

  test.beforeEach(async ({ request }) => {
    await ensureStackOrSkip(request);
  });

  test('define rules, breach, score, close, panel, disable, isolation', async ({
    page,
    request,
  }) => {
    // 1. Register and create a funded account through the API.
    const email = await registerUser(request, 'owner');
    await loginViaUi(page, email);
    const accountName = 'Rules account';
    const accountId = await createAccount(request, accountName);

    // 2. Define three rules through the Rules tab: one account-scoped, one
    //    critical `max_risk_amount`; two that the position passes.
    await page.goto('/settings/rules');
    await expect(page.locator(RULES_TAB)).toBeVisible();
    await expect(page.getByText('No rules yet')).toBeVisible();

    await createMaxRiskAmountRule(page, accountName);
    await expect(page.getByText('Risk per trade at most 50 USD')).toBeVisible();
    await createSetRule(page, 'Allowed directions', 'Long', 'Important');
    await expect(page.getByText('Only long trades')).toBeVisible();
    await createSetRule(page, 'Allowed markets', 'Stocks', 'Nice to have');
    await expect(page.getByText('Only stocks')).toBeVisible();

    const rules = await fetchRules(request);
    expect(rules.map((r) => r.description).sort()).toEqual(
      ['Only long trades', 'Only stocks', 'Risk per trade at most 50 USD'].sort(),
    );

    // 3. Open a position that breaches the critical rule — it saves — and the
    //    detail's compliance card shows the breach and the weighted score.
    const breaching = await openBreachingPosition(request, accountId);

    await page.goto(`/positions/${breaching}`);
    const card = complianceCard(page);
    await expect(card).toBeVisible();
    // Weighted score: pass (2 + 1) / (pass 3 + breach 3) = 50; Provisional (open).
    await expect(card.getByText('50', { exact: true })).toBeVisible();
    await expect(card.getByText('Provisional')).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Breaches' })).toBeVisible();
    await expect(card.getByText('Risk per trade at most 50 USD')).toBeVisible();
    await expect(card.getByText('Critical')).toBeVisible();
    // Risk 100 measured against the 50 limit, in the account currency.
    const breachLine = card.getByText(/against/);
    await expect(breachLine).toContainText('100');
    await expect(breachLine).toContainText('50');

    // 4. Close it, add a compliant closed position, and read the performance
    //    page's Compliance panel: the rate and the compliant/non-compliant split.
    await closePosition(request, breaching, '155.00');
    await createCompliantClosedPosition(request, accountId);

    await page.goto(`/positions/${breaching}`);
    const closedCard = complianceCard(page);
    await expect(closedCard.getByText('Final')).toBeVisible();
    await expect(closedCard.getByText('50', { exact: true })).toBeVisible();

    await page.goto(PERF_URL);
    const perf = page.getByTestId('performance-page');
    await expect(perf).toBeVisible();
    const panel = perf.getByTestId('compliance-panel');
    await expect(panel).toBeVisible();
    // One compliant + one non-compliant closed position ⇒ rate 50.0%.
    await expect(panel.getByTestId('compliance-rate')).toContainText('50.0%');
    const compliantRow = panel.getByTestId('compliance-row-compliant');
    const nonCompliantRow = panel.getByTestId('compliance-row-non_compliant');
    await expect(compliantRow).toBeVisible();
    await expect(nonCompliantRow).toBeVisible();
    // The Positions cell is each row's first Numeric — one position on each side.
    await expect(compliantRow.getByTestId('numeric').first()).toHaveText('1');
    await expect(nonCompliantRow.getByTestId('numeric').first()).toHaveText('1');

    // 5. Disable the critical rule through its switch; the detail rescores to
    //    100 with no breaches (the two passing rules remain).
    await page.goto('/settings/rules');
    const ruleRow = page
      .locator(`${RULES_TAB} li`)
      .filter({ hasText: 'Risk per trade at most 50 USD' });
    await ruleRow.getByRole('switch').click();
    await expect(ruleRow.getByRole('switch')).not.toBeChecked();

    await page.goto(`/positions/${breaching}`);
    const rescored = complianceCard(page);
    await expect(rescored.getByText('100', { exact: true })).toBeVisible();
    await expect(rescored.getByText('No breaches')).toBeVisible();
    await expect(rescored.getByRole('heading', { name: 'Breaches' })).toHaveCount(0);

    // 6. A second user sees none of the first user's rules.
    const secondEmail = await registerUser(request, 'other');
    expect(await fetchRules(request)).toEqual([]);
    await loginViaUi(page, secondEmail);
    await page.goto('/settings/rules');
    await expect(page.locator(RULES_TAB)).toBeVisible();
    await expect(page.getByText('No rules yet')).toBeVisible();
    await expect(page.getByText('Risk per trade at most 50 USD')).toHaveCount(0);
  });
});
