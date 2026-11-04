import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * multi-leg-positions e2e suite (Task 21, AC 10.3 / design.md Testing Strategy).
 *
 * Drives the AC 10.3 scenario end to end against the REAL stack (no
 * `page.route` stubs): enter a bull call spread through multi-leg entry, close
 * it through close-all, read its ledger rows / flat event / lots through the
 * real API, then import a second two-leg fill set through the
 * `generic-execution` preset and confirm it groups, with the drawer and the
 * dashboard widget each counting the open group once.
 *
 * Every earlier task (1-20) already ships the piece this spec exercises in
 * isolation (unit/integration tests per design.md Testing Strategy); this is
 * the first test to drive all of them together through the real UI and API
 * in one continuous story, so it is a regression guard, not new behaviour.
 *
 * Contract block — one row per AC 10.3 success criterion:
 *
 * | Criterion                                   | Pre-condition                                   | Call through the seam (Test:)                         | Observable result                                        | Source of expected value |
 * |----------------------------------------------|--------------------------------------------------|--------------------------------------------------------|------------------------------------------------------------|---------------------------|
 * | One BCS row, net debit + max loss             | fresh user/account; two call legs via multi-leg form | submit `MultiLegEntryForm` (POST /api/position-groups) | list row: label "BCS", "debit", "300.00"; detail panel: "301.30" | requirements.md AC 3.6 case 1 (`strategy.test.ts:315-333`); design.md C13 |
 * | Both legs closed via close-all                | group open, both legs open                        | `CloseGroupDialog` submit (POST /:id/close)            | /positions: group row + both leg rows read "closed"        | requirements.md AC 4.1, 4.3; design.md C13 |
 * | Ledger rows per leg                           | group closed                                      | `GET /api/ledger/{accountId}`                          | an entry exists whose `positionId` is each leg's id        | requirements.md AC 4.6; codebase-context.md accounting.query.ts |
 * | One flat event (Total positions 1)            | group closed today, no other closed position      | `GET /api/performance?granularity=day&start=today&end=tomorrow` | `currencies[USD].stats.totalPositions === 1`        | requirements.md AC 10.3; design.md D2/D9 |
 * | Lots per leg                                  | group closed                                       | `GET /api/positions/{id}/lots` for each leg id          | `lots.length === 1`, `quantity === "1"`                    | requirements.md AC 4.8; codebase-context.md lots.ts |
 * | Imported set grouped (one proposal, confirmed) | two-leg option fill set, <5 min apart, no order id | import `multi-leg-execution.csv` via `generic-execution` preset, Confirm import | preview shows 1 group proposal; success panel: "Created 1 group." | requirements.md AC 8.4; design.md Component 10 (`csv-group-proposals.ts`) |
 * | Drawer's open tab counts the group once        | group open, imported, not yet closed               | open side drawer -> "Open positions" tab               | exactly one row containing the group's underlying           | design.md D3 (union, legs nested); `OpenPositionsTab.tsx` |
 * | Dashboard widget counts the group once         | same as above                                      | `/dashboard` Open Positions widget                      | exactly one row containing the group's underlying           | design.md D8; `OpenPositionsWidget.tsx` |
 *
 * STACK REQUIREMENT: the stack (web + api + db) must be running; the suite
 * `test.skip`s gracefully when `/api/auth/me` is unreachable (same guard as
 * csv-import.spec.ts / dashboard.spec.ts / option-position-entry.spec.ts).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'csv-import');

const PASSWORD = 'test-password-1234';

// eslint-disable-next-line no-restricted-syntax
const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';

function uniqueEmail(): string {
  return `e2e-mlp-${randomUUID()}@example.com`;
}

/**
 * `MultiLegEntryForm` reads `#multi-leg-filled-at` with `new Date(value)`,
 * which parses a bare `datetime-local` string as the browser's LOCAL time —
 * not UTC. A UTC `toISOString()` slice fed straight in shifts `filledAt` by
 * the local offset (CST here), landing it in the future relative to
 * close-all's real-UTC-now default and tripping "Close date cannot precede
 * open date". Subtract the offset first so the local-interpreted value
 * lands on the real current instant.
 */
function nowForDatetimeLocal(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * A unique, non-loopback IP for the one `/register` call this spec makes
 * (option-position-entry.spec.ts's pattern) — `TRUSTED_PROXIES=127.0.0.1` on
 * the booted stack makes this the limiter key. Distinct 3rd octet (122)
 * separates this spec from the others sharing a worker process.
 */
function uniqueIp(): string {
  return `10.${process.pid % 256}.122.1`;
}

const ACCOUNT_NAME = 'E2E MultiLeg USD';

// The entry group (multi-leg entry, close-all): AC 3.6 case 1 verbatim
// (strategy.test.ts:315-333) — long 100 call @5.00 / short 110 call @2.00,
// one contract each, 1.30 entry fees on the short leg only. Net entry 300
// (debit), max loss 301.30.
const ENTRY_UNDERLYING = 'ZOLA';
const ENTRY_EXPIRY = '2026-06-19';
const LEG0_SYMBOL = `${ENTRY_UNDERLYING}260619C100`;
const LEG1_SYMBOL = `${ENTRY_UNDERLYING}260619C110`;

// The import group: two option legs, no order id, opening fills 3 minutes
// apart (<=5 min, csv-group-proposals.ts FIVE_MINUTES_MS), same underlying and
// entry quantity -> pass 2 heuristic groups them (AC 8.4).
const IMPORT_UNDERLYING = 'TSTA';

let api: APIRequestContext;
let stackReady = false;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL });
  try {
    const me = await api.get('/api/auth/me', { failOnStatusCode: false });
    if (me.status() >= 500) return;
  } catch {
    return;
  }
  stackReady = true;
});

test.afterAll(async () => {
  await api?.dispose();
});

test.beforeEach(() => {
  test.skip(!stackReady, 'live stack not reachable — skipping live e2e');
});

// ---------------------------------------------------------------------------
// Setup — register a user via the real API (sets the session cookie in the
// page's shared cookie jar, csv-import.spec.ts's `setup()` pattern) and seed
// one USD account.
// ---------------------------------------------------------------------------

interface Seeded {
  accountId: string;
}

async function setup(page: Page): Promise<Seeded> {
  const email = uniqueEmail();
  const reg = await page.request.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(reg.status(), `register ${email}`).toBe(201);

  const acc = await page.request.post('/api/accounts', {
    data: { name: ACCOUNT_NAME, currency: 'USD' },
  });
  expect(acc.status(), 'POST /accounts').toBe(201);
  const account = (await acc.json()) as { id: string };

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  return { accountId: account.id };
}

// ---------------------------------------------------------------------------
// Multi-leg entry helpers
// ---------------------------------------------------------------------------

async function openMultiLegDialog(page: Page): Promise<Locator> {
  await page.goto('/positions');
  await expect(page.getByRole('heading', { name: 'Positions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Position' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New Position' })).toBeVisible();

  await dialog.getByRole('combobox').filter({ hasText: 'Single position' }).click();
  await page.getByRole('option', { name: 'Multi-leg strategy', exact: true }).click();
  return dialog;
}

/** A multi-leg entry row's own container — the only place to scope the
 * duplicated Stock/Option and Long/Short tab labels per leg. */
function legRow(page: Page, index: number): Locator {
  return page.locator('div.space-y-3.rounded-md.border.p-3').nth(index);
}

async function fillOptionLeg(
  page: Page,
  index: number,
  opts: {
    side: 'long' | 'short';
    strike: string;
    quantity: string;
    price: string;
    fee: string;
  },
): Promise<void> {
  const row = legRow(page, index);
  await row.getByRole('tab', { name: 'Option', exact: true }).click();
  if (opts.side === 'short') {
    await row.getByRole('tab', { name: 'Short', exact: true }).click();
  }
  await page.locator(`#leg-${index}-underlying`).fill(ENTRY_UNDERLYING);
  await page.locator(`#leg-${index}-expiry`).fill(ENTRY_EXPIRY);
  await page.locator(`#leg-${index}-strike`).fill(opts.strike);
  await page.locator(`#leg-${index}-quantity`).fill(opts.quantity);
  await page.locator(`#leg-${index}-price`).fill(opts.price);
  await page.locator(`#leg-${index}-fee`).fill(opts.fee);
}

// ---------------------------------------------------------------------------
// CSV import helpers (csv-import.spec.ts's `pickAccountAndFile`/`chooseFromSelect`)
// ---------------------------------------------------------------------------

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

async function chooseFromSelect(page: Page, label: string, optionName: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

async function pickAccountAndFile(page: Page, fixtureFile: string): Promise<void> {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import trades from CSV' })).toBeVisible();
  await chooseFromSelect(page, 'Target account', `${ACCOUNT_NAME} (USD)`);
  await page.locator('#import-file').setInputFiles(fixturePath(fixtureFile));
  await expect(page.getByText('3. Map columns')).toBeVisible();
}

test.describe('multi-leg-positions', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — the multi-leg dialog and importer are desktop-shaped.',
  );

  test('bull call spread: multi-leg entry -> close-all -> ledger/flat/lots via API -> grouped import -> drawer/widget count once', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const { accountId } = await setup(page);

    // --- 1. Multi-leg entry: AC 3.6 case 1 (net entry 300, max loss 301.30) ---
    const dialog = await openMultiLegDialog(page);

    await dialog.getByRole('combobox').filter({ hasText: 'Select account' }).click();
    await page.getByRole('option', { name: `${ACCOUNT_NAME} (USD)`, exact: true }).click();
    await page.locator('#multi-leg-filled-at').fill(nowForDatetimeLocal());

    await fillOptionLeg(page, 0, {
      side: 'long',
      strike: '100',
      quantity: '1',
      price: '5.00',
      fee: '0',
    });
    await fillOptionLeg(page, 1, {
      side: 'short',
      strike: '110',
      quantity: '1',
      price: '2.00',
      fee: '1.30',
    });

    // Live preview, before submit.
    await expect(page.getByTestId('multi-leg-net-entry')).toHaveText('$300.00');
    await expect(page.getByTestId('multi-leg-max-loss')).toHaveText('$301.30');

    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(dialog).toBeHidden();

    // --- One BCS row with net debit ---
    const groupRow = page.getByRole('row').filter({ hasText: ENTRY_UNDERLYING });
    await expect(groupRow).toContainText('BCS');
    await expect(groupRow).toContainText('debit');
    await expect(groupRow).toContainText('300.00');

    // Fetch the created group's leg ids through the real list API (no stub —
    // this is the same endpoint the list page itself reads).
    const listRes = await page.request.get('/api/positions');
    expect(listRes.status()).toBe(200);
    const list = (await listRes.json()) as Array<{
      kind?: string;
      underlying?: string;
      legs?: { id: string; symbol: string }[];
    }>;
    const entryGroup = list.find((e) => e.kind === 'group' && e.underlying === ENTRY_UNDERLYING);
    expect(entryGroup, 'created entry group present in GET /api/positions').toBeTruthy();
    const legIds = (entryGroup?.legs ?? []).map((l) => l.id);
    expect(legIds).toHaveLength(2);

    // --- Expand -> navigate to a leg's detail -> max loss on the group panel ---
    await groupRow.getByRole('button', { name: 'Expand BCS legs' }).click();
    await page.getByRole('link', { name: ENTRY_UNDERLYING }).first().click();
    await expect(page).toHaveURL(/\/positions\/[0-9a-f-]+/i);
    await expect(page.getByRole('heading', { name: ENTRY_UNDERLYING })).toBeVisible();
    const maxLossLabel = page.getByText('Max loss', { exact: true });
    await expect(maxLossLabel).toBeVisible();
    const maxLossValue = maxLossLabel.locator('xpath=following-sibling::*[1]');
    await expect(maxLossValue).toContainText('301.30');

    // --- 2. Close-all: both legs close in one transaction ---
    await page.getByRole('button', { name: 'Close all', exact: true }).click();
    const closeDialog = page.getByRole('dialog');
    await expect(closeDialog.getByRole('heading', { name: 'Close all legs' })).toBeVisible();
    await closeDialog.getByLabel(`Exit price (${LEG0_SYMBOL})`).fill('1.00');
    await closeDialog.getByLabel(`Exit price (${LEG1_SYMBOL})`).fill('1.00');
    await closeDialog.getByRole('button', { name: 'Close all', exact: true }).click();
    await expect(closeDialog).toBeHidden();

    await page.goto('/positions');
    const closedRows = page.getByRole('row').filter({ hasText: ENTRY_UNDERLYING });
    await expect(closedRows).toHaveCount(1); // collapsed: group row only
    await expect(closedRows.nth(0)).toContainText('closed');
    await closedRows
      .nth(0)
      .getByRole('button', { name: /Expand BCS legs/ })
      .click();
    await expect(closedRows).toHaveCount(3); // group row + 2 expanded legs
    await expect(closedRows.nth(1)).toContainText('closed');
    await expect(closedRows.nth(2)).toContainText('closed');

    // --- 3. Ledger rows per leg, through the API ---
    const ledgerRes = await page.request.get(`/api/ledger/${accountId}`, {
      params: { pageSize: '200' },
    });
    expect(ledgerRes.status()).toBe(200);
    const ledger = (await ledgerRes.json()) as { entries: { positionId: string | null }[] };
    for (const legId of legIds) {
      expect(
        ledger.entries.some((e) => e.positionId === legId),
        `a ledger row exists for leg ${legId}`,
      ).toBe(true);
    }

    // --- One flat event (Total positions 1), through the API ---
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
    const perfRes = await page.request.get('/api/performance', {
      params: { granularity: 'day', start, end, tz: 'UTC', currency: 'USD' },
    });
    expect(perfRes.status()).toBe(200);
    const perf = (await perfRes.json()) as {
      currencies: { code: string; stats: { totalPositions: number } }[];
    };
    const usd = perf.currencies.find((c) => c.code === 'USD');
    expect(usd?.stats.totalPositions, 'the closed group counts as exactly one flat event').toBe(1);

    // --- 4. Lots per leg, from GET /api/positions/{id}/lots ---
    for (const legId of legIds) {
      const lotsRes = await page.request.get(`/api/positions/${legId}/lots`);
      expect(lotsRes.status()).toBe(200);
      const lots = (await lotsRes.json()) as { lots: { quantity: string }[] };
      expect(lots.lots).toHaveLength(1);
      expect(Number(lots.lots[0].quantity)).toBe(1);
    }

    // --- 5. Import a two-leg fill set via generic-execution: one proposal ---
    await pickAccountAndFile(page, 'multi-leg-execution.csv');
    await chooseFromSelect(page, 'Preset (optional)', 'Generic execution (one row per fill)');

    await page.getByRole('button', { name: 'Preview import' }).click();
    await expect(page.getByText('Rows parsed')).toBeVisible();

    const groupProposals = page.getByTestId('group-proposals');
    await expect(groupProposals).toBeVisible();
    await expect(groupProposals).toContainText('TSTA260620C100');
    await expect(groupProposals).toContainText('TSTA260620C110');

    const confirmBtn = page.getByRole('button', { name: 'Confirm import' });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    await expect(page.getByText('Import complete')).toBeVisible();
    await expect(page.getByText(/Added\s+2\s+positions/)).toBeVisible();
    await expect(page.getByTestId('groups-created')).toContainText('Created 1 group.');

    // --- confirmed and grouped: one row, not two, on the positions list ---
    await page.getByRole('link', { name: 'View imported positions' }).click();
    await expect(page).toHaveURL(/\/positions/);
    const importedRows = page.getByRole('row').filter({ hasText: IMPORT_UNDERLYING });
    await expect(importedRows).toHaveCount(1);

    // --- 6. Dashboard widget counts the open group once ---
    await page.goto('/dashboard');
    const widgetRows = page.getByRole('row').filter({ hasText: IMPORT_UNDERLYING });
    await expect(widgetRows).toHaveCount(1);

    // --- 7. The drawer's open-positions tab counts the open group once ---
    await page.getByRole('button', { name: /open side drawer/i }).click();
    const sideDrawer = page.getByTestId('side-drawer');
    await expect(sideDrawer).toHaveAttribute('data-state', 'open');
    await page.getByRole('tab', { name: /open positions/i }).click();
    const drawerRows = sideDrawer.getByRole('link').filter({ hasText: IMPORT_UNDERLYING });
    await expect(drawerRows).toHaveCount(1);
  });
});
