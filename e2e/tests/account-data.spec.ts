import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * account-data e2e suite (Task 18).
 *
 * The decomposition's end-to-end scenario for the no-storage path: export one
 * user's whole account through the browser and import it into a second, empty
 * account, all on the booted self-host stack (the same Playwright `webServer`
 * boot the other live suites use — see e2e/playwright.config.ts, no Stripe and
 * no object bucket configured, so the export inlines every image and the import
 * writes nothing to object storage).
 *
 *   round trip — register user A, seed an account and an open position through
 *                the API, then sign in as A and export from the settings Data
 *                tab. The download is captured; its name is
 *                `tradr-export-<UTC date>.zip`. Register user B, sign in, upload
 *                the same file on the Data tab, read the preview counts, confirm,
 *                read the result, and find A's position on B's positions page.
 *                Then upload the file a second time and see the "not empty"
 *                refusal, because B's account now holds A's data.
 *
 * ── Seeding (the e2e DB seam) ──────────────────────────────────────────────
 *
 * Users are registered through the API (the account-deletion pattern); the
 * account and position are seeded through the API too — account and position
 * creation are not the surface under test. Every navigation is by URL
 * (`page.goto`) rather than the sidebar, so the flows are viewport-independent
 * and run under both projects (chromium + the iPhone-13 webkit project). The
 * export and import themselves go through the real controls the web tasks built.
 */

const PASSWORD = 'test-password-1234';
const OPENED_AT = '2026-05-01T14:30:00.000Z';

function uniqueEmail(label: string): string {
  return `e2e-acct-data-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login call. `/register` is rate-limited
 * to 5 / 15 min per client IP; the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1`, playwright.config.ts), so the limiter keys off
 * this forwarded IP. The third octet — 142 — is this spec's own; every other
 * suite's range is taken. `process.pid` namespaces each Playwright worker so the
 * chromium and webkit projects never replay the same low IPs.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.142.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  userId: string;
}

/**
 * Register a user; the session cookie lands on `req`, so the returned context
 * stays authenticated as this user for API-side setup.
 */
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

/** A funded account over the API — account creation is not the surface under test. */
async function createAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD', startingBalance: '10000' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `POST /accounts ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * An open position with one entry fill — the account has real data for the
 * export to carry. The entry fill MUST precede `/open`: the API refuses to open
 * a position that has none.
 */
async function createOpenPosition(req: APIRequestContext, accountId: string): Promise<string> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const positionId = ((await posRes.json()) as { id: string }).id;

  const entryRes = await req.post(`/api/positions/${positionId}/fills`, {
    data: { type: 'entry', price: '150.00', quantity: '10', fees: '0', filledAt: OPENED_AT },
  });
  expect(entryRes.status(), 'POST entry fill').toBe(201);

  const openRes = await req.post(`/api/positions/${positionId}/open`, {
    data: { openedAt: OPENED_AT },
  });
  expect(openRes.status(), 'POST /open').toBe(200);
  return positionId;
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

/**
 * Assert a counts-table row: the row whose first cell is exactly `label` shows
 * `value` in its right-hand count cell. Both the preview and result tables share
 * the shape (ImportFlow `CountsTable`), so this reads either.
 */
async function expectCount(scope: Locator, label: string, value: string): Promise<void> {
  const row = scope
    .getByRole('row')
    .filter({ has: scope.page().getByRole('cell', { name: label, exact: true }) });
  await expect(row.getByRole('cell').last()).toHaveText(value);
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

test.describe('account-data', () => {
  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('export one account and import it into an empty one', async ({ page, request }) => {
    // The import restore does real transactional DB work, and the flow drives two
    // users through the browser, so allow well beyond the default expect timeout.
    test.setTimeout(120_000);

    // ── User A: seed through the API, then export through the browser ─────────
    const userA = await registerUser(request, 'source');
    const accountId = await createAccount(request, 'Export account');
    await createOpenPosition(request, accountId);

    await loginViaUi(page, userA.email);
    await page.goto('/settings/data');
    await expect(page.getByRole('heading', { name: 'Data', exact: true })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export data' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename(), 'export file name').toMatch(
      /^tradr-export-\d{4}-\d{2}-\d{2}\.zip$/,
    );
    const archivePath = join(tmpdir(), `tradr-e2e-export-${process.pid}-${Date.now()}.zip`);
    await download.saveAs(archivePath);

    // ── User B: a fresh, empty account drives the import ──────────────────────
    const userB = await registerUser(request, 'target');
    await page.context().clearCookies();
    await loginViaUi(page, userB.email);
    await page.goto('/settings/data');

    // Choosing the file auto-previews (ImportFlow.onFileChange).
    await page.locator('#import-archive-file').setInputFiles(archivePath);

    const preview = page.locator('[data-slot="import-preview"]');
    await expect(preview).toBeVisible();
    await expect(preview.getByText('Exported by')).toBeVisible();
    // A's one account, one position and its one entry fill travel in the archive.
    await expectCount(preview, 'Accounts', '1');
    await expectCount(preview, 'Positions', '1');
    await expectCount(preview, 'Fills', '1');

    // ── Confirm the import ────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Import this archive' }).click();
    const dialog = page.locator('[data-slot="import-confirm-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Import data' }).click();

    const result = page.locator('[data-slot="import-result"]');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.getByText('Import complete')).toBeVisible();
    await expectCount(result, 'Positions', '1');

    // ── A's position now lives on B's positions page ──────────────────────────
    await page.goto('/positions');
    const aaplRow = page.getByRole('row').filter({ hasText: 'AAPL' });
    await expect(aaplRow).toBeVisible();

    // ── Importing the same file again is refused: B is no longer empty ────────
    await page.goto('/settings/data');
    await page.locator('#import-archive-file').setInputFiles(archivePath);
    const error = page.locator('[data-slot="import-error"]');
    await expect(error).toBeVisible();
    await expect(error.getByText('This account is not empty')).toBeVisible();
  });
});
