import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * option-lifecycle e2e suite (Task 30, design.md Testing Strategy > End-to-end).
 *
 * Drives the option-lifecycle-events decomposition's scenario against the REAL
 * booted stack (web + api + db; the Unusual Whales stub server the
 * `advisor-tools.spec.ts` / `symbol-search-quotes.spec.ts` suites already run
 * against, per `e2e/playwright.config.ts`'s `webServer` array). Every piece this
 * spec drives (past-expiry flag, settlement, unsettle, rolls, the chain/key off
 * the advisor, Flex lifecycle import) already shipped in tasks 1-29, each with
 * its own unit/integration coverage (design.md Testing Strategy); this is the
 * first spec to drive them together through the app's own UI in one continuous
 * story per scenario, so it is a regression guard, not new behaviour.
 *
 * Contract block — one row per assigned success criterion. 8.1 (the timeline)
 * has no dedicated case: it is folded into cases 1 and 2, the only places this
 * spec reads a timeline.
 *
 * | Criterion | Pre-condition | Call through the seam (Test:) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | 1.5 (flag) | a short put opened with an expiry already past | `GET /positions` (list page) and `GET /performance` (page) | the list row and the performance page both show the flag; absent once settled | requirements.md AC 1.5; design.md C2 |
 * | 2.1 (settle) | the same past-expiry short put, open | `SettleLegDialog` submit (`POST /:id/settle`) with outcome `assigned` | dialog closes, the leg's row reads `closed` | requirements.md AC 2.1; design.md C3 |
 * | 3.9 (assignment basis) | short put strike 50 sold at 2.50, assigned | same `POST /:id/settle` call | a new long stock row at avg entry 47.50 (strike − premium) | requirements.md AC 3.9 worked example |
 * | 4.6 (unsettle reverts) | the settled leg from case 1/2 | `UnsettleDialog` submit (`POST /:id/unsettle`) from the timeline's Unsettle button | the stock row is gone, the leg is open again and re-flagged | requirements.md AC 4.6; full fills/ledger/tax-year precision is `option-unsettle.test.ts`'s (design.md Testing Strategy), this case confirms the user-visible surface |
 * | 5.3 (roll chain credit) | a short put sold at 2.00, rolled at 1.00 for 2.50, then at 1.50 for 3.00 | `RollLegDialog` submit twice (`POST /:id/roll`) | the newest leg's timeline reads "Rolled, net credit $500.00" | requirements.md AC 5.3 worked example |
 * | 7.4 (chain/key off the advisor) | the `/api/config` route stubbed `advisorEnabled: false` (TD15 — the only stub here; the server itself keeps the advisor on, proving the client wiring and a real key/chain through the UW stub rather than a stubbed chain route) | save a key on Settings → Market data, then read the chain on `/options` and inside the calculator's chain dialog | the Advisor settings tab is gone, Market data stays, and the chain renders on both surfaces | requirements.md AC 7.4; the server-side `ADVISOR_DISABLED` half of 7.4 is `advisor.disabled.route.test.ts`'s (task 14) |
 * | 8.1 (timeline) | folded into cases 1/2 above | the same list/detail reads | the timeline shows the fill, the settlement (linked to the stock row) and the roll chain (linked to the other leg) | requirements.md AC 8.1; design.md D17/C10 |
 * | 10.7 (Flex import) | a Flex file with one `A` row, one `EX` row and one `EP` row, each against a leg opened in the same file | `Preview import` (`POST /api/csv-import/preview`) via the Interactive Brokers preset | "Proposed lifecycle events (2)" (assigned + exercised) and "Blocking errors (1)" (the `EP` refusal) | requirements.md AC 10.7; apps/api/.../csv-contract.ts's `OPTION_EVENT_NOT_SUPPORTED` message |
 *
 * Restrictions observed: the `/api/config` route is the only `page.route` stub in this
 * file (case 4); every other case drives the real server with no mocking.
 * Every account/email/CSV-row underlying is built from `crypto.randomUUID()` or
 * a per-test counter, never `Math.random()`.
 *
 * STACK REQUIREMENT: web + api + db (+ the UW stub) must be booted; the suite
 * `test.skip`s gracefully when `/api/auth/me` is unreachable, same guard as
 * `csv-import.spec.ts` / `multi-leg-positions.spec.ts`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'csv-import');

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-lifecycle-${label}-${randomUUID()}@example.com`;
}

/**
 * A unique, non-loopback IP per register call (the csv-import.spec.ts /
 * multi-leg-positions.spec.ts idiom): `/register` is rate-limited per client
 * IP, and the harness trusts the loopback proxy (`TRUSTED_PROXIES=127.0.0.1`),
 * so a unique `X-Forwarded-For` dodges the shared bucket. The distinct 3rd
 * octet (126) separates this spec's registrations from the others.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.126.${ipCounter % 254}`;
}

interface Seeded {
  accountName: string;
}

/** Register a unique user via the real API and seed one USD account. */
async function setup(page: Page, label: string): Promise<Seeded> {
  const email = uniqueEmail(label);
  const reg = await page.request.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(reg.status(), `register ${email}`).toBe(201);

  const accountName = `E2E Lifecycle ${label}`;
  const acc = await page.request.post('/api/accounts', {
    data: { name: accountName, currency: 'USD' },
  });
  expect(acc.status(), 'POST /accounts').toBe(201);

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  return { accountName };
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

/** Select an option from a Radix combobox identified by its accessible (label) name. */
async function chooseFromSelect(page: Page, label: string, optionName: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

/** Run the preview and wait for the summary to render (csv-import.spec.ts's `runPreview`). */
async function runPreview(page: Page): Promise<void> {
  const previewBtn = page.getByRole('button', { name: 'Preview import' });
  await expect(previewBtn).toBeEnabled();
  await previewBtn.click();
  await expect(page.getByText('Rows parsed')).toBeVisible();
}

/**
 * Open a single option leg through the app's own CSV importer (generic-execution
 * preset, task-21's `multi-leg-execution.csv` shape) rather than injecting a
 * position directly — the e2e drives a real app code path, never a shortcut
 * the app itself does not offer.
 */
async function openOptionLegViaImport(
  page: Page,
  accountName: string,
  occSymbol: string,
  action: 'Buy' | 'Sell',
  price: string,
  filledAt: string,
): Promise<void> {
  const csv = [
    'Symbol,AssetType,Action,Quantity,Price,FilledAt,Fees',
    `${occSymbol},Option,${action},1,${price},${filledAt},0.65`,
  ].join('\n');

  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import trades from CSV' })).toBeVisible();
  await chooseFromSelect(page, 'Target account', `${accountName} (USD)`);
  await page
    .locator('#import-file')
    .setInputFiles({
      name: `${occSymbol}-open.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
  await expect(page.getByText('3. Map columns')).toBeVisible();
  await chooseFromSelect(page, 'Preset (optional)', 'Generic execution (one row per fill)');
  await runPreview(page);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();
}

/** The open leg's position id, read through the real list API (no UI parsing). */
async function findPositionId(page: Page, symbol: string): Promise<string> {
  const res = await page.request.get('/api/positions');
  expect(res.status()).toBe(200);
  const list = (await res.json()) as Array<{ id: string; symbol?: string }>;
  const found = list.find((p) => p.symbol === symbol);
  expect(found, `position ${symbol} present in GET /api/positions`).toBeTruthy();
  return found!.id;
}

/** Save a UW market-data key on Settings → Market data (symbol-search-quotes.spec.ts's helper). */
async function saveMarketDataKey(page: Page, key: string): Promise<void> {
  await page.goto('/settings/market-data');
  const card = page.getByTestId('market-data-key-card');
  await expect(card).toBeVisible();
  await card.getByLabel('API key').fill(key);
  await card.getByRole('button', { name: /Save key|Replace key/ }).click();
  await expect(card.getByText('Key verified')).toBeVisible();
}

test.describe('option-lifecycle', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — the settle/roll dialogs and importer are desktop-shaped.',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Case 1 — AC 1.5, 2.1, 3.9, 4.6 (+ 8.1 fold): flag -> assign -> stock row at
  // strike minus premium -> unsettle -> stock row gone, flag back.
  // -------------------------------------------------------------------------
  test('past-expiry put: flagged, assigned at strike minus premium, then unsettled back to open', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { accountName } = await setup(page, 'settle');

    // GLDX260918P50: short put, strike 50, sold at 2.50, expiring 2026-09-18 —
    // already past "today" (the suite's system clock), so it reads flagged on
    // first read with no boot-time sweep involved (AC 1.1/1.5).
    await openOptionLegViaImport(
      page,
      accountName,
      'GLDX260918P50',
      'Sell',
      '2.50',
      '2026-08-01T14:00:00',
    );

    await page.goto('/positions');
    const legRow = page.getByRole('row').filter({ hasText: '$50P' });
    await expect(legRow).toContainText('Past expiry');

    // Performance page carries the same count (AC 1.5's last sentence).
    await page.goto('/performance');
    await expect(page.getByTestId('unsettled-legs-notice')).toContainText(
      '1 past-expiry leg unsettled.',
    );

    const legId = await findPositionId(page, 'GLDX260918P50');
    await page.goto(`/positions/${legId}`);
    await expect(page.getByText('Past expiry', { exact: true })).toBeVisible();

    // --- AC 2.1: settle via the detail page's Settle dialog, outcome assigned ---
    await page.getByRole('button', { name: 'Settle' }).click();
    const settleDialog = page.getByRole('dialog');
    await expect(settleDialog.getByText(/OCC automatically exercises/)).toBeVisible();
    const assignedBtn = settleDialog.getByRole('button', { name: 'Assigned' });
    await expect(assignedBtn).toBeVisible();
    await assignedBtn.click();
    await settleDialog.getByRole('button', { name: 'Settle' }).click();
    await expect(settleDialog).toBeHidden();

    await expect(page.getByText('closed', { exact: true })).toBeVisible();

    // --- AC 3.9: a new long GLDX stock row at 47.50 (50 strike − 2.50 premium) ---
    await page.goto('/positions');
    const stockRow = page
      .getByRole('row')
      .filter({ hasText: 'GLDX' })
      .filter({ hasNotText: '$50P' });
    await expect(stockRow).toBeVisible();
    await expect(stockRow).toContainText('47.50');

    // Flag is gone now that the leg is closed.
    await expect(page.getByRole('row').filter({ hasText: '$50P' })).not.toContainText(
      'Past expiry',
    );

    // --- AC 4.6 / 8.1: unsettle from the leg's timeline, reverting both rows ---
    await page.goto(`/positions/${legId}`);
    await expect(page.getByText(/Settled assigned on/)).toBeVisible();
    await page.getByRole('button', { name: 'Unsettle' }).click();
    const unsettleDialog = page.getByRole('dialog');
    await expect(unsettleDialog.getByRole('heading', { name: 'Undo settlement' })).toBeVisible();
    await expect(unsettleDialog.getByText(/go with it/)).toBeVisible();
    await unsettleDialog.getByRole('button', { name: 'Unsettle' }).click();
    await expect(unsettleDialog).toBeHidden();

    await page.goto('/positions');
    await expect(
      page.getByRole('row').filter({ hasText: 'GLDX' }).filter({ hasNotText: '$50P' }),
    ).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: '$50P' })).toContainText('Past expiry');
  });

  // -------------------------------------------------------------------------
  // Case 2 — AC 5.3 (+ 8.1 fold): two rolls, cumulative net credit in the
  // newest leg's timeline, linked to the other chain legs.
  // -------------------------------------------------------------------------
  test('short put rolled twice: the chain reports a 500 credit before fees', async ({ page }) => {
    test.setTimeout(120_000);
    const { accountName } = await setup(page, 'roll');

    // ZQRP270115P80 sold at 2.00 (AC 5.3's worked example).
    await openOptionLegViaImport(
      page,
      accountName,
      'ZQRP270115P80',
      'Sell',
      '2.00',
      '2026-11-01T09:30:00',
    );
    const leg1Id = await findPositionId(page, 'ZQRP270115P80');

    // --- Roll 1: close 1.00, open 2.50 on a later-dated put ---
    await page.goto(`/positions/${leg1Id}`);
    await page.getByRole('button', { name: 'Roll' }).click();
    let rollDialog = page.getByRole('dialog');
    await expect(rollDialog.getByRole('heading', { name: /^Roll / })).toBeVisible();
    await rollDialog.getByLabel('Underlying').fill('ZQRP');
    await rollDialog.getByLabel('Expiry').fill('2027-02-19');
    await rollDialog.getByRole('tab', { name: 'Put' }).click();
    await rollDialog.getByLabel('Strike').fill('80');
    await rollDialog.getByLabel('Close price').fill('1.00');
    await rollDialog.getByLabel('Open price').fill('2.50');
    await rollDialog.getByLabel('Date').fill('2026-11-02T10:00');
    await rollDialog.getByRole('button', { name: 'Roll' }).click();
    await expect(rollDialog).toBeHidden();

    const leg2Id = await findPositionId(page, 'ZQRP270219P80');

    // --- Roll 2: close 1.50, open 3.00 on a further-dated put ---
    await page.goto(`/positions/${leg2Id}`);
    await page.getByRole('button', { name: 'Roll' }).click();
    rollDialog = page.getByRole('dialog');
    await rollDialog.getByLabel('Underlying').fill('ZQRP');
    await rollDialog.getByLabel('Expiry').fill('2027-03-19');
    await rollDialog.getByRole('tab', { name: 'Put' }).click();
    await rollDialog.getByLabel('Strike').fill('80');
    await rollDialog.getByLabel('Close price').fill('1.50');
    await rollDialog.getByLabel('Open price').fill('3.00');
    await rollDialog.getByLabel('Date').fill('2026-11-03T10:00');
    await rollDialog.getByRole('button', { name: 'Roll' }).click();
    await expect(rollDialog).toBeHidden();

    const leg3Id = await findPositionId(page, 'ZQRP270319P80');

    // --- AC 5.3 / 8.1: the newest leg's timeline carries the cumulative net
    // credit (2.00 + 2.50 + 3.00 premium in, less 1.00 + 1.50 premium out =
    // 5.00/share = $500.00) and links to the other two chain legs.
    await page.goto(`/positions/${leg3Id}`);
    await expect(page.getByText('Rolled, net credit')).toBeVisible();
    await expect(page.getByTestId('numeric').filter({ hasText: '$500.00' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'ZQRP270115P80' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ZQRP270219P80' })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Case 3 — AC 10.7: a Flex file with A, EX and EP rows proposes an assigned
  // and an exercised event, and refuses the EP row with its reason.
  // -------------------------------------------------------------------------
  test('Flex import: A and EX propose lifecycle events, EP stays an unsupported refusal', async ({
    page,
  }) => {
    const { accountName } = await setup(page, 'import');

    await page.goto('/import');
    await expect(page.getByRole('heading', { name: 'Import trades from CSV' })).toBeVisible();
    await chooseFromSelect(page, 'Target account', `${accountName} (USD)`);
    await page.locator('#import-file').setInputFiles(fixturePath('ibkr-flex-lifecycle.csv'));
    await expect(page.getByText('3. Map columns')).toBeVisible();
    await chooseFromSelect(page, 'Preset (optional)', 'Interactive Brokers (Flex Query — Trades)');

    await runPreview(page);

    // Two proposed lifecycle events: the AMZN put assigned, the NVDA call exercised.
    await expect(page.getByText('Proposed lifecycle events (2)')).toBeVisible();
    await expect(page.getByText('assigned', { exact: true })).toBeVisible();
    await expect(page.getByText('exercised', { exact: true })).toBeVisible();

    // One refusal: the TSLA EP row, unsupported (AC 10.1), located to the row
    // and the Notes/Codes column (csv-contract.ts's OPTION_EVENT_NOT_SUPPORTED).
    await expect(page.getByText('Blocking errors (1)')).toBeVisible();
    await expect(page.getByText('Row 6 · column "Notes/Codes" · field eventCode')).toBeVisible();
    await expect(page.getByText(/expiration or assignment event \("EP"\)/)).toBeVisible();

    // Confirm stays disabled while the EP row's blocking error remains, and the
    // app did not crash (csv-import.spec.ts scenario 4/6's guard).
    await expect(page.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
    await expect(page.getByText(/at .*\.ts:\d+/)).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // Case 4 — AC 7.4: with the client told the advisor is off, a saved
  // market-data key still renders the chain on /options and in the calculator.
  // -------------------------------------------------------------------------
  test('advisor hidden via a stubbed /api/config: the chain still works on /options and the calculator', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await setup(page, 'advisoroff');

    // The ONE page.route stub in this file (TD15): the client believes the
    // advisor is off, while the real server (DISABLE_ADVISOR=false in this
    // suite) still serves a real key + a real chain through the UW stub.
    await page.route('**/api/config', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ registrationEnabled: true, advisorEnabled: false }),
      }),
    );

    await page.goto('/settings');
    await expect(page.getByRole('tab', { name: 'Market data' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Advisor' })).toHaveCount(0);

    await saveMarketDataKey(page, `uw-e2e-${randomUUID()}`);

    // --- Options page: the chain renders for the stub's deterministic ticker. ---
    await page.goto('/options');
    await page.locator('#options-chain-symbol').fill('AAPL');
    await expect(page.getByText('190.00')).toBeVisible();
    await expect(page.locator('[data-slot="underlying-spot"]')).toContainText('192.5');
    await expect(page.locator('tr[data-atm="true"]')).toContainText('190');

    // --- Calculator: the same chain is reachable from the options entry path. ---
    await page.goto('/calculator');
    await expect(page.getByRole('heading', { name: 'Trade Calculator' })).toBeVisible();
    await page.getByRole('tab', { name: 'Options' }).click();
    await page.getByRole('button', { name: 'Select from options chain' }).click();
    const chainDialog = page.getByRole('dialog');
    await chainDialog.locator('#options-chain-symbol').fill('AAPL');
    await expect(
      chainDialog.getByRole('row').filter({ hasText: '190' }).getByRole('button', { name: 'Use' }),
    ).toBeVisible();
  });
});
