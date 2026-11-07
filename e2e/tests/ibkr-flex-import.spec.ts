import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  BAD_TOKEN,
  GOOD_TOKEN,
  QID_HAPPY,
  QID_PARTIAL_1,
  QID_PARTIAL_2,
  QID_REPEAT,
  QID_SECOND,
} from '../support/flex-stub-server';

/**
 * ibkr-flex-import e2e suite (Task 14).
 *
 * Drives the whole path against the LIVE stack (Playwright's `webServer`
 * array boots api + web + the Flex stub against a real Postgres; see
 * e2e/playwright.config.ts), with the Flex Web Service itself replaced by the
 * booted stub (e2e/support/flex-stub-server.ts) — nothing here is
 * route-mocked. Follows the csv-import.spec.ts convention: register a unique
 * user via POST /api/auth/register (sets the session cookie), seed target
 * accounts via POST /api/accounts, save every IBKR Flex connection through
 * the app's own Settings UI (never a direct API write), then drive the
 * import page.
 *
 * Scenarios (Req 9.1):
 *   A. a fetch previews and commits.
 *   B. a second connection imports into a second account.
 *   C. a bad token shows its message naming Settings.
 *   D. no connection shows no fetch button.
 *   E. a repeat fetch of one period trips the duplicate gate.
 *   F. a partly overlapping period gates on a fetch where the equivalent
 *      upload only warns.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-flex-${label}-${randomUUID()}@example.com`;
}

/**
 * A unique, non-loopback IP per register/seed call (same TRUSTED_PROXIES
 * idiom as csv-import.spec.ts). The `.115.` third octet is this suite's own
 * lane — distinct from csv-import.spec.ts's `.114.` — so two spec files
 * sharing one worker process (playwright.config.ts `workers: 1`) never
 * contend for the same /register rate-limit bucket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.115.${ipCounter % 254}`;
}

async function registerUser(req: APIRequestContext, label: string): Promise<void> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
}

async function seedAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `seed account ${name}`).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Register a user and confirm the shared cookie jar authenticated the browser. */
async function setup(page: Page, label: string): Promise<void> {
  await registerUser(page.request, label);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Probe the stack — if `/api/auth/me` is unreachable (no booted stack), skip
 * gracefully. Same guard as csv-import.spec.ts / dashboard.spec.ts.
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

/** Select an option from a Radix combobox identified by its accessible (label) name. */
async function chooseFromSelect(page: Page, label: string, optionName: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

/**
 * Save (or replace) the account's IBKR Flex connection through its own
 * Settings card (REQ-1.1/1.4/1.9) — never a direct API write.
 */
async function saveIbkrConnection(
  page: Page,
  accountName: string,
  token: string,
  queryId: string,
): Promise<void> {
  await page.goto('/settings/ibkr');
  await expect(page.getByRole('heading', { name: 'IBKR' })).toBeVisible();
  const card = page.getByTestId('ibkr-connection-card').filter({ hasText: accountName });
  await card.getByLabel('Token').fill(token);
  await card.getByLabel('Query ID').fill(queryId);
  await card.getByRole('button', { name: /^(Save|Replace) connection$/ }).click();
  await expect(card.getByText('Connected')).toBeVisible();
}

/** Go to /import and pick the target account (step 1). */
async function gotoImportAndSelect(page: Page, accountName: string): Promise<void> {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import trades from CSV' })).toBeVisible();
  await chooseFromSelect(page, 'Target account', `${accountName} (USD)`);
}

/** Click the Flex fetch button and wait for the preview summary to render. */
async function runFlexFetch(page: Page): Promise<void> {
  const fetchBtn = page.getByRole('button', { name: 'Fetch my Flex report' });
  await expect(fetchBtn).toBeEnabled();
  await fetchBtn.click();
  // The client sleeps ~2s before its first poll (flex.client.ts
  // FLEX_FIRST_POLL_MS) — give the round trip room beyond the default timeout.
  await expect(page.getByText('Rows parsed')).toBeVisible({ timeout: 15_000 });
}

/** Confirm the staged preview and wait for the success panel. */
async function confirmImport(page: Page): Promise<void> {
  const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(page.getByText('Import complete')).toBeVisible();
}

const EXECUTION_HEADER =
  'Symbol,Description,UnderlyingSymbol,Strike,Expiry,Put/Call,Multiplier,AssetClass,Buy/Sell,Open/CloseIndicator,Quantity,TradePrice,IBCommission,DateTime,Notes/Codes';

/**
 * One upload-side row in the `interactive-brokers` preset's shape — same
 * shape as flex-stub-server.ts's `flexRow`, minus `ClientAccountID` (a plain
 * upload never runs the flex-only single-account proof).
 */
function executionRow(
  symbol: string,
  action: 'BUY' | 'SELL',
  quantity: number,
  price: string,
  fee: string,
  dateTime: string,
): string {
  const indicator = action === 'BUY' ? 'O' : 'C';
  return [
    symbol,
    '',
    '',
    '',
    '',
    '',
    '1',
    'STK',
    action,
    indicator,
    String(quantity),
    price,
    fee,
    `"${dateTime}"`,
    '',
  ].join(',');
}

function executionCsv(rows: string[]): Buffer {
  return Buffer.from([EXECUTION_HEADER, ...rows].join('\n') + '\n');
}

/** Upload a buffer as the fixture file (step 2) — unlocks step 3 (the mapper). */
async function uploadBuffer(page: Page, buffer: Buffer, name: string): Promise<void> {
  await page.locator('#import-file').setInputFiles({ name, mimeType: 'text/csv', buffer });
  await expect(page.getByText('3. Map columns')).toBeVisible();
}

/** Apply the Interactive Brokers preset and run the (upload) preview. */
async function applyIbkrPresetAndPreview(page: Page): Promise<void> {
  await chooseFromSelect(page, 'Preset (optional)', 'Interactive Brokers (Flex Query — Trades)');
  const previewBtn = page.getByRole('button', { name: 'Preview import' });
  await expect(previewBtn).toBeEnabled();
  await previewBtn.click();
  await expect(page.getByText('Rows parsed')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Desktop suite (chromium) — same gate as csv-import.spec.ts; the import
// surface is desktop-shaped (multi-card stepper, selects, preview tables).
// ---------------------------------------------------------------------------

test.describe('ibkr-flex-import', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // A — a fetch previews and commits.
  // -------------------------------------------------------------------------
  test('a fetch previews and commits', async ({ page }) => {
    await setup(page, 'happy');
    const accountName = `Flex Happy ${randomUUID()}`;
    await seedAccount(page.request, accountName);

    await saveIbkrConnection(page, accountName, GOOD_TOKEN, QID_HAPPY);

    await gotoImportAndSelect(page, accountName);
    await expect(page.getByText('No fetch yet')).toBeVisible();
    await runFlexFetch(page);

    await confirmImport(page);
    await expect(page.getByText(/Added\s+1\s+position/)).toBeVisible();

    // AAPL round trip: (123.10 − 121.50) × 100 − 1 (entry fee) − 1 (exit fee) = $158.00.
    await page.getByRole('link', { name: 'View imported positions' }).click();
    await expect(page).toHaveURL(/\/positions/);
    const row = page.getByRole('row').filter({ hasText: 'AAPL' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('closed');
    await expect(row).toContainText('158.00');
  });

  // -------------------------------------------------------------------------
  // B — a second connection imports into a second account.
  // -------------------------------------------------------------------------
  test('a second connection imports into a second account', async ({ page }) => {
    await setup(page, 'two');
    const accountA = `Flex A ${randomUUID()}`;
    const accountB = `Flex B ${randomUUID()}`;
    await seedAccount(page.request, accountA);
    await seedAccount(page.request, accountB);

    await saveIbkrConnection(page, accountA, GOOD_TOKEN, QID_HAPPY);
    await saveIbkrConnection(page, accountB, GOOD_TOKEN, QID_SECOND);

    await gotoImportAndSelect(page, accountB);
    await runFlexFetch(page);
    await confirmImport(page);

    // MSFT round trip: (410 − 400) × 50 − 1 − 1 = $498.00, landed in account B.
    await page.getByRole('link', { name: 'View imported positions' }).click();
    const row = page.getByRole('row').filter({ hasText: 'MSFT' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('498.00');

    // Account A's own connection was never fetched — the second connection's
    // fetch recorded only against account B (REQ-7.2 per-account history).
    await page.goto('/settings/ibkr');
    const cardA = page.getByTestId('ibkr-connection-card').filter({ hasText: accountA });
    await expect(cardA.getByText('No fetch yet')).toBeVisible();
    const cardB = page.getByTestId('ibkr-connection-card').filter({ hasText: accountB });
    await expect(cardB.getByText(/Last fetched/)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // C — a bad token shows its message naming Settings.
  // -------------------------------------------------------------------------
  test('a bad token shows its message naming Settings', async ({ page }) => {
    await setup(page, 'bad');
    const accountName = `Flex Bad ${randomUUID()}`;
    await seedAccount(page.request, accountName);
    await saveIbkrConnection(page, accountName, BAD_TOKEN, 'qid-bad-e1');

    await gotoImportAndSelect(page, accountName);
    const fetchBtn = page.getByRole('button', { name: 'Fetch my Flex report' });
    await fetchBtn.click();
    await expect(page.getByText(/replace it in Settings/)).toBeVisible({ timeout: 15_000 });
  });

  // -------------------------------------------------------------------------
  // D — no connection shows no fetch button.
  // -------------------------------------------------------------------------
  test('no connection shows no fetch button', async ({ page }) => {
    await setup(page, 'none');
    const accountName = `Flex None ${randomUUID()}`;
    await seedAccount(page.request, accountName);

    await gotoImportAndSelect(page, accountName);
    await expect(page.getByRole('button', { name: 'Fetch my Flex report' })).toHaveCount(0);
    await expect(page.locator('#import-file')).toHaveCount(1);
  });

  // -------------------------------------------------------------------------
  // E — a repeat fetch of one period trips the duplicate gate.
  // -------------------------------------------------------------------------
  test('a repeat fetch of one period trips the duplicate gate', async ({ page }) => {
    await setup(page, 'repeat');
    const accountName = `Flex Repeat ${randomUUID()}`;
    await seedAccount(page.request, accountName);
    await saveIbkrConnection(page, accountName, GOOD_TOKEN, QID_REPEAT);

    await gotoImportAndSelect(page, accountName);
    await runFlexFetch(page);
    await confirmImport(page);

    await gotoImportAndSelect(page, accountName);
    await runFlexFetch(page);

    // The same period fetched again is a 100% overlap — the distinct
    // duplicate-affirmation checkbox gates confirm (REQ-9.1).
    const dupCheckbox = page.getByRole('checkbox');
    await expect(dupCheckbox).toBeVisible();
    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeDisabled();
    await dupCheckbox.check();
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await expect(page.getByText('Import complete')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // F — a partly overlapping period gates on a fetch where the equivalent
  //     upload only warns.
  // -------------------------------------------------------------------------
  test('a partly overlapping period gates on a fetch where the equivalent upload only warns', async ({
    page,
  }) => {
    await setup(page, 'partial');
    const flexAccount = `Flex Partial ${randomUUID()}`;
    const uploadAccount = `Flex Partial Upload ${randomUUID()}`;
    await seedAccount(page.request, flexAccount);
    await seedAccount(page.request, uploadAccount);

    // ---- Flex side: a baseline fetch, then a 1-of-3 (33%) overlapping fetch
    // still gates — `gateAnyOverlap` (csv-import.service.ts `scanDuplicates`)
    // is flex-only and does not wait for the 90% block ratio.
    await saveIbkrConnection(page, flexAccount, GOOD_TOKEN, QID_PARTIAL_1);
    await gotoImportAndSelect(page, flexAccount);
    await runFlexFetch(page);
    await confirmImport(page);

    await saveIbkrConnection(page, flexAccount, GOOD_TOKEN, QID_PARTIAL_2);
    await gotoImportAndSelect(page, flexAccount);
    await runFlexFetch(page);

    const dupCheckbox = page.getByRole('checkbox');
    await expect(dupCheckbox).toBeVisible();
    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeDisabled();
    await dupCheckbox.check();
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await expect(page.getByText('Import complete')).toBeVisible();

    // ---- Upload side: the SAME 1-of-3 overlap, via a plain upload, only
    // warns — no checkbox, confirm enabled immediately (Req 6.8: `gateAnyOverlap`
    // defaults off, so the upload path is unchanged).
    const baseline = executionCsv([
      executionRow('AAPL', 'BUY', 100, '121.50', '-1.00', '2026-04-01;09:30:00'),
      executionRow('AAPL', 'SELL', -100, '123.10', '-1.00', '2026-04-01;15:55:00'),
    ]);
    const overlap = executionCsv([
      executionRow('AAPL', 'BUY', 100, '121.50', '-1.00', '2026-04-01;09:30:00'),
      executionRow('MSFT', 'BUY', 50, '400.00', '-1.00', '2026-04-02;09:30:00'),
      executionRow('MSFT', 'SELL', -50, '410.00', '-1.00', '2026-04-02;15:30:00'),
    ]);

    await gotoImportAndSelect(page, uploadAccount);
    await uploadBuffer(page, baseline, 'flex-partial-baseline.csv');
    await applyIbkrPresetAndPreview(page);
    await confirmImport(page);

    await gotoImportAndSelect(page, uploadAccount);
    await uploadBuffer(page, overlap, 'flex-partial-overlap.csv');
    await applyIbkrPresetAndPreview(page);

    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByText(/matches an existing fill in this account/)).toBeVisible();
    const confirmBtn2 = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn2).toBeEnabled();
    await confirmBtn2.click();
    await expect(page.getByText('Import complete')).toBeVisible();
  });
});
