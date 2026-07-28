import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * csv-import e2e suite (Task 23).
 *
 * Per design.md §Testing Strategy > E2E, this drives the full import journey
 * against the LIVE stack (the same server-boot harness the advisor/dashboard
 * suites use — Playwright's `webServer` array boots api + web against a real
 * Postgres; see e2e/playwright.config.ts). Nothing here is route-mocked: the
 * preview/commit endpoints, the parse→map→normalize→segment→validate pipeline,
 * the lifecycle replay, and the imported positions are all real.
 *
 * Scenarios (design E2E):
 *   1. HAPPY (preset) — upload an IBKR-shaped execution CSV via the
 *      `interactive-brokers` preset → preview → confirm → the imported closed
 *      position is visible on /positions with the correct net P&L.
 *      Re-importing the same file exercises the ≥90%-overlap affirmation gate:
 *      the distinct "import anyway" checkbox is required, and confirming with it
 *      imports a second time.
 *   2. HAPPY (preset) — a TradeZella-shaped execution CSV via the `tradezella`
 *      preset → preview → confirm → imported closed position with correct P&L.
 *   3. HAPPY (manual round-trip, NO preset) — a round-trip CSV imported via the
 *      first-class manual row-shape selector (Task 21) with no preset selected →
 *      preview → confirm → one position per row (REQ-4.1, d-b394aea7: round-trip
 *      is preset-less, reached only via the manual selector).
 *   4. MALFORMED — an execution CSV with an unparseable price and an invalid date
 *      → the preview surfaces clear located (row/field) blocking errors, confirm
 *      stays disabled, and the app does not crash (no stack trace).
 *
 * Auth + seed follow the live-stack convention (dashboard.spec.ts,
 * advisor-tools.spec.ts): register a unique user via POST /api/auth/register
 * (which sets the `session` cookie in the shared browser cookie jar) and seed
 * the target account via POST /api/accounts. The suite `test.skip`s gracefully
 * when the API stack is unreachable so a CI run without the booted stack does
 * not fail spuriously.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'csv-import');

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-csv-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/seed call. The auth `/register` route
 * is rate-limited to 5 / 15 min per client IP; the harness sets
 * `TRUSTED_PROXIES=127.0.0.1` (playwright.config.ts) so the limiter keys off
 * this forwarded IP rather than the shared loopback socket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process — the chromium +
  // Mobile Chrome projects re-run this spec in fresh workers that reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.114.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  accountId: string;
  accountName: string;
}

async function registerUser(req: APIRequestContext, label: string): Promise<string> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  return email;
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

/**
 * Register a user, seed a USD target account, and confirm the shared cookie jar
 * authenticated the browser context. After this the page is signed in and the
 * account exists for the importer to target.
 */
async function setup(page: Page, label: string): Promise<SeededUser> {
  const email = await registerUser(page.request, label);
  const accountName = `Import Acct ${label}`;
  const accountId = await seedAccount(page.request, accountName);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  return { email, accountId, accountName };
}

/**
 * Probe the stack — if `/api/auth/me` is unreachable (no booted stack), skip
 * gracefully. Same guard as dashboard.spec.ts / advisor-tools.spec.ts.
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
// Page helpers — drive the Component-13 import UI (Tasks 21–22).
// ---------------------------------------------------------------------------

/** Select an option from a Radix combobox identified by its accessible (label) name. */
async function chooseFromSelect(page: Page, label: string, optionName: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

/**
 * Map a target field to a CSV column in the mapper. The per-field mapping rows
 * have no `htmlFor`-associated label (the field name is a sibling <span>, not a
 * <Label>), so the combobox has no accessible name. Locate the row by its label
 * text, then the combobox inside it.
 */
async function mapField(page: Page, fieldLabel: string, column: string): Promise<void> {
  // Each mapping row is a div holding the field-label <span> and the column
  // <Select>. The combobox has no accessible name, so locate the row's combobox
  // via the label span (xpath: the span whose text starts with the label →
  // following combobox in the same row container).
  const combobox = page.locator(
    `xpath=//span[starts-with(normalize-space(.), ${xpathLiteral(fieldLabel)})]/following-sibling::*[@role="combobox"]`,
  );
  await combobox.click();
  await page.getByRole('option', { name: column, exact: true }).click();
}

/** Quote a string as an XPath literal (handles embedded quotes/parentheses). */
function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replace(/'/g, "',\"'\",'")}')`;
}

/** Steps 1–2: pick the seeded target account and attach a fixture CSV. */
async function pickAccountAndFile(
  page: Page,
  accountName: string,
  fixtureFile: string,
): Promise<void> {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import trades from CSV' })).toBeVisible();

  // Step 1 — target account (the SelectItem label is "<name> (USD)").
  await chooseFromSelect(page, 'Target account', `${accountName} (USD)`);

  // Step 2 — the file input is hidden behind a "Choose file" button; setInputFiles
  // works on hidden inputs. This unlocks step 3 (the mapper). The CardTitle is a
  // styled div (not a semantic heading), so match on its text.
  await page.locator('#import-file').setInputFiles(fixturePath(fixtureFile));
  await expect(page.getByText('3. Map columns')).toBeVisible();
}

/** Run the preview and wait for the summary to render. */
async function runPreview(page: Page): Promise<void> {
  const previewBtn = page.getByRole('button', { name: 'Preview import' });
  await expect(previewBtn).toBeEnabled();
  await previewBtn.click();
  // Preview summary card renders once the server responds.
  await expect(page.getByText('Rows parsed')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Desktop suite (chromium) — the import surface is desktop-shaped (multi-card
// stepper, selects, preview tables). Mirror the dashboard suite's project gate.
// ---------------------------------------------------------------------------

test.describe('csv-import', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — IBKR execution via preset → import → P&L → duplicate gate.
  // -------------------------------------------------------------------------
  test('IBKR execution preset: preview → confirm → closed position with P&L, then duplicate gate', async ({
    page,
  }) => {
    const { accountName } = await setup(page, 'ibkr');

    await pickAccountAndFile(page, accountName, 'ibkr-execution.csv');

    // Apply the Interactive Brokers preset — auto-fills the mapping + formats.
    await chooseFromSelect(page, 'Preset (optional)', 'Interactive Brokers (Flex Query — Trades)');

    await runPreview(page);

    // The IBKR file is one closed long: BUY 100 @ 121.50 then SELL 100 @ 123.10
    // → 1 position, 2 fills. Confirm is enabled (no blocking errors).
    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // Success panel → the import is complete and links to /positions.
    await expect(page.getByText('Import complete')).toBeVisible();
    await expect(page.getByText(/Added\s+1\s+position/)).toBeVisible();

    // Imported position is visible on /positions with correct net P&L:
    // (123.10 − 121.50) × 100 − 1 (exit fee) − 1 (entry fee) = $158.00.
    await page.getByRole('link', { name: 'View imported positions' }).click();
    await expect(page).toHaveURL(/\/positions/);
    const row = page.getByRole('row').filter({ hasText: 'AAPL' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('closed');
    await expect(row).toContainText('158.00');

    // ---- Duplicate gate: re-import the same file → ≥90% overlap → affirmation.
    await pickAccountAndFile(page, accountName, 'ibkr-execution.csv');
    await chooseFromSelect(page, 'Preset (optional)', 'Interactive Brokers (Flex Query — Trades)');
    await runPreview(page);

    // The distinct duplicate-affirmation checkbox gates confirm (REQ-9.1/12.3):
    // confirm is disabled until the "import anyway" checkbox is ticked.
    const dupCheckbox = page.getByRole('checkbox');
    await expect(dupCheckbox).toBeVisible();
    const confirm2 = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirm2).toBeDisabled();
    await dupCheckbox.check();
    await expect(confirm2).toBeEnabled();
    await confirm2.click();
    await expect(page.getByText('Import complete')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — TradeZella execution via preset → import → P&L.
  // -------------------------------------------------------------------------
  test('TradeZella execution preset: preview → confirm → closed position with P&L', async ({
    page,
  }) => {
    const { accountName } = await setup(page, 'tz');

    await pickAccountAndFile(page, accountName, 'tradezella-execution.csv');
    await chooseFromSelect(page, 'Preset (optional)', 'TradeZella (generic CSV)');

    await runPreview(page);

    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await expect(page.getByText('Import complete')).toBeVisible();

    // SPY long: BUY 50 @ 400 then SELL 50 @ 410 → (410 − 400) × 50 − 1 − 1 = $498.00.
    await page.getByRole('link', { name: 'View imported positions' }).click();
    const row = page.getByRole('row').filter({ hasText: 'SPY' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('closed');
    await expect(row).toContainText('498.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — manual round-trip (NO preset) → one position per row.
  // -------------------------------------------------------------------------
  test('manual round-trip (no preset): one position per row via the row-shape selector', async ({
    page,
  }) => {
    const { accountName } = await setup(page, 'rt');

    await pickAccountAndFile(page, accountName, 'round-trip.csv');

    // No preset selected. Flip the FIRST-CLASS row-shape selector to round-trip
    // (Task 21 — the only path to a round-trip import; no preset ships one).
    await chooseFromSelect(page, 'Row shape', 'Round-trip (one row per closed trade)');

    // Map the round-trip target fields by hand to the fixture's columns. The
    // per-field mapping rows have unnamed comboboxes (no htmlFor label), so map
    // by row label text.
    const rtMapping: Array<[string, string]> = [
      ['Symbol', 'Symbol'],
      ['Asset type', 'AssetType'],
      ['Side (long/short)', 'Side'],
      ['Entry price', 'EntryPrice'],
      ['Entry quantity', 'EntryQty'],
      ['Entry date', 'EntryDate'],
      ['Exit price', 'ExitPrice'],
      ['Exit quantity', 'ExitQty'],
      ['Exit date', 'ExitDate'],
    ];
    for (const [field, column] of rtMapping) {
      await mapField(page, field, column);
    }

    await runPreview(page);

    // Two round-trip rows → two discrete closed positions, one per row (REQ-4.1).
    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await expect(page.getByText(/Added\s+2\s+positions/)).toBeVisible();

    await page.getByRole('link', { name: 'View imported positions' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'MSFT' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'TSLA' })).toBeVisible();
    // MSFT long (330 − 300) × 10 = $300.00; TSLA short (250 − 230) × 5 = $100.00.
    await expect(page.getByRole('row').filter({ hasText: 'MSFT' })).toContainText('300.00');
    await expect(page.getByRole('row').filter({ hasText: 'TSLA' })).toContainText('100.00');
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — malformed CSV → located errors, confirm blocked, no crash.
  // -------------------------------------------------------------------------
  test('malformed CSV: clear located errors, confirm disabled, no crash', async ({ page }) => {
    const { accountName } = await setup(page, 'bad');

    await pickAccountAndFile(page, accountName, 'malformed.csv');
    // Generic execution preset matches the malformed file's headers; the bad
    // price/date values are what produce located errors (not a mapping gap).
    await chooseFromSelect(page, 'Preset (optional)', 'Generic execution (one row per fill)');

    await runPreview(page);

    // Blocking errors card renders with located (row/field) messages — NOT a
    // stack trace. Assert the located prefix ("Row N") and that confirm is off.
    const errorsCard = page.getByText(/Blocking errors \(\d+\)/);
    await expect(errorsCard).toBeVisible();
    await expect(page.getByText(/Row \d+/).first()).toBeVisible();

    // Confirm is disabled while blocking errors remain (REQ-12.3).
    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeDisabled();

    // The app did not crash: the import heading is still mounted and no raw
    // error boundary / stack trace surfaced.
    await expect(page.getByRole('heading', { name: 'Import trades from CSV' })).toBeVisible();
    await expect(page.getByText(/at .*\.ts:\d+/)).toHaveCount(0);
  });
});
