import {
  expect,
  test,
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Option-position-entry e2e suite (Task 8).
 *
 * Per design.md §Testing Strategy > End-to-End and NFR Reliability, this drives
 * the WHOLE structured-option-entry pipeline against the REAL running stack (no
 * `page.route` mocks):
 *
 *   1. Option flow — open New Position → Asset Type = Option → enter
 *      underlying / expiry / strike / type → submit → assert the position lists
 *      with the DECODED contract (underlying + compact label) → open the detail
 *      view (decoded header) → reopen the draft's Edit dialog → assert the
 *      structured fields are PREFILLED with the NORMALISED values (strike `120`,
 *      never `120.000`), i.e. the encode → decode → prefill round trip holds.
 *   2. Stock flow (behaviour-unchanged guard) — the plain-ticker path: Asset
 *      Type stays Stock, a bare ticker submits and lists verbatim with no option
 *      decoration, and the detail view shows it as a stock.
 *
 * Auth/setup follows the existing conventions: one user + one account are seeded
 * ONCE via the real API (register shares no cookie jar with the page here, so
 * each test logs the browser in via the UI — the dashboard.spec.ts `loginViaUi`
 * pattern). Seeding once keeps registrations well under the `/register` rate
 * limit (5 / 15 min) across the re-runs this spec is expected to survive.
 *
 * STACK REQUIREMENT: the stack (web + api + db) must be running. The suite
 * `test.skip`s gracefully when `/api/auth/me` is unreachable so CI without a
 * booted stack does not fail spuriously (same guard as dashboard.spec.ts).
 */

const PASSWORD = 'test-password-1234';

// eslint-disable-next-line no-restricted-syntax
const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';

function uniqueEmail(label: string): string {
  return `e2e-options-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call. The `/register` route is
 * rate-limited per client IP; when the api trusts the loopback proxy
 * (TRUSTED_PROXIES=127.0.0.1, set by playwright.config.ts's managed stack) this
 * forwarded IP — not the shared socket IP — is the limiter key. The distinct
 * 3rd octet (121) separates this spec from the others.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.121.${ipCounter % 254}`;
}

// ---------------------------------------------------------------------------
// Shared, one-time setup — register a single user + one account via the real
// API, then each test logs the browser in as that user.
// ---------------------------------------------------------------------------

const ACCOUNT_NAME = 'E2E Options USD';
const ACCOUNT_LABEL = `${ACCOUNT_NAME} (USD)`;

let api: APIRequestContext;
let sharedEmail = '';
let stackReady = false;

test.beforeAll(async () => {
  api = await playwrightRequest.newContext({ baseURL });
  // Probe the stack — a 401 (unauthenticated) means reachable; a 5xx or a thrown
  // connection error means it's down, so skip rather than fail.
  try {
    const me = await api.get('/api/auth/me', { failOnStatusCode: false });
    if (me.status() >= 500) return;
  } catch {
    return;
  }

  sharedEmail = uniqueEmail('flow');
  const reg = await api.post('/api/auth/register', {
    data: { email: sharedEmail, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(reg.status(), `register ${sharedEmail}`).toBe(201);

  const acc = await api.post('/api/accounts', {
    data: { name: ACCOUNT_NAME, currency: 'USD' },
  });
  expect(acc.status(), 'POST /accounts').toBe(201);

  stackReady = true;
});

test.afterAll(async () => {
  await api?.dispose();
});

test.beforeEach(() => {
  test.skip(!stackReady, 'live stack not reachable — skipping live e2e');
});

// ---------------------------------------------------------------------------
// Page helpers — drive the Component-5 New Position dialog (Tasks 5–7).
// ---------------------------------------------------------------------------

/** Log the browser in via the UI form (dashboard.spec.ts pattern). */
async function loginViaUi(page: Page): Promise<void> {
  // UI logins reach the API through the loopback Vite proxy, so without a unique
  // forwarded IP every spec's logins share ONE rate-limit bucket (login: 10 / 15
  // min) and the long single-worker run trips 429 → the app redirects to
  // /login?expired=true. Mirror the register pattern: a unique X-Forwarded-For
  // per login gives each its own bucket (TRUSTED_PROXIES=127.0.0.1).
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(sharedEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Open the Positions page and the New Position dialog; returns the dialog. */
async function openNewPositionDialog(page: Page): Promise<Locator> {
  await page.goto('/positions');
  await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible();
  const newBtn = page.getByRole('button', { name: 'New Position' });
  await expect(newBtn).toBeEnabled();
  await newBtn.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New Position' })).toBeVisible();
  return dialog;
}

/**
 * Pick from one of the dialog's Radix `<Select>`s. Their `<Label>`s carry no
 * `htmlFor`, so the comboboxes have no accessible name (the csv-import.spec.ts
 * note documents the same shape) — locate by the trigger's current display text.
 */
async function chooseFromUnnamedSelect(
  page: Page,
  dialog: Locator,
  currentText: string,
  optionName: string,
): Promise<void> {
  await dialog.getByRole('combobox').filter({ hasText: currentText }).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

// ---------------------------------------------------------------------------
// Scenario 1 — full option-entry flow (REQ-2.1, REQ-3.1, REQ-8.1)
// ---------------------------------------------------------------------------

test.describe.serial('Option position entry — full flow', () => {
  test('option contract: create → list (decoded) → detail → edit prefill (normalised)', async ({
    page,
  }) => {
    await loginViaUi(page);
    const dialog = await openNewPositionDialog(page);

    // Asset Type = Option reveals the structured contract inputs.
    await chooseFromUnnamedSelect(page, dialog, 'Stock', 'Option');

    // Underlying entered lowercase to also exercise the upper-case normalisation
    // (Req 1.4) — every decoded surface should show "NVDA".
    await dialog.getByLabel('Underlying').fill('nvda');
    await dialog.getByLabel('Expiry').fill('2026-03-21');
    await dialog.getByLabel('Strike').fill('120');
    // Type defaults to Call — leave it (asserted on prefill below).

    await chooseFromUnnamedSelect(page, dialog, 'Select account', ACCOUNT_LABEL);

    await dialog.getByRole('button', { name: 'Create' }).click();

    // --- LIST: decoded contract (underlying link + compact label + draft) ---
    await expect(page.getByRole('link', { name: 'NVDA' })).toBeVisible();
    await expect(page.getByText('21 Mar 26 · $120C')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'NVDA' });
    await expect(row.getByText('draft')).toBeVisible();

    // --- DETAIL: decoded header ---
    await page.getByRole('link', { name: 'NVDA' }).click();
    await expect(page).toHaveURL(/\/positions\/[0-9a-f-]+/i);
    await expect(page.getByRole('heading', { name: 'NVDA' })).toBeVisible();
    await expect(page.getByText('Exp 21 Mar 2026 · $120 Call')).toBeVisible();
    await expect(page.getByText('option', { exact: true })).toBeVisible();

    // --- EDIT: structured fields PREFILLED with NORMALISED values ---
    await page.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByRole('heading', { name: 'Edit Position' })).toBeVisible();

    await expect(editDialog.getByLabel('Underlying')).toHaveValue('NVDA');
    await expect(editDialog.getByLabel('Expiry')).toHaveValue('2026-03-21');
    // The crux: the strike round-trips to the normalised "120", never "120.000".
    await expect(editDialog.getByLabel('Strike')).toHaveValue('120');
    await expect(editDialog.getByRole('tab', { name: 'Call' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — stock path is unchanged (behaviour-unchanged guard)
  // -------------------------------------------------------------------------

  test('stock ticker: plain symbol submits and lists verbatim, no option decoration', async ({
    page,
  }) => {
    await loginViaUi(page);
    const dialog = await openNewPositionDialog(page);

    // Asset Type stays Stock (default) — a bare ticker, no OCC encoding.
    await dialog.getByLabel('Symbol').fill('AAPL');
    await chooseFromUnnamedSelect(page, dialog, 'Select account', ACCOUNT_LABEL);

    await dialog.getByRole('button', { name: 'Create' }).click();

    // --- LIST: plain ticker, draft, no decoded compact label ---
    await expect(page.getByRole('link', { name: 'AAPL' })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'AAPL' });
    await expect(row.getByText('draft')).toBeVisible();
    await expect(row.getByText('·')).toHaveCount(0);

    // --- DETAIL: rendered as a stock, no option contract subline ---
    await page.getByRole('link', { name: 'AAPL' }).click();
    await expect(page).toHaveURL(/\/positions\/[0-9a-f-]+/i);
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await expect(page.getByText('stock', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Exp /)).toHaveCount(0);
  });
});
