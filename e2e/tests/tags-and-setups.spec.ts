import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Tags-and-setups e2e suite — the design's End-to-End Testing section run
 * against the booted stack.
 *
 * Two independent journeys, each with its own freshly registered user:
 *
 *  A. The offer, the tab, the picker, the list filter and delete: the starter
 *     offer is declined once and never re-shown; three tags in two categories
 *     are created through the tab; two positions are tagged from their detail
 *     pages; the `?tag=a,b` list filter is exercised hand-typed and reloaded and
 *     through the control (whose ids land in lexicographic order regardless of
 *     click order, comma percent-encoded by the router); the Closed/All tabs
 *     write and clear `status`; and deleting a tag leaves the positions their
 *     other tag.
 *  B. Sample data: the demo seed paints tag chips on AAPL and six other rows,
 *     creates the sixteen starter tags, and answers the offer so the Settings
 *     tab shows neither the offer nor the secondary "Add starter tags" action.
 *
 * ASSERTIONS ARE ON THE DOM AND THE NETWORK, NEVER ON REACT STATE — chips are
 * read off their accessible names, the filter off the URL, and the tag/position
 * vocabulary off `GET /api/tags` and `GET /api/positions`, all things a user or
 * a proxy could see. `ensureStackOrSkip` skips (not fails) when the API is down,
 * matching every other live suite here. This spec is NOT env-gated.
 */

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-tags-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register/login. `/register` is rate-limited per
 * client IP (5 / 15 min) and the harness trusts the loopback proxy
 * (`TRUSTED_PROXIES=127.0.0.1` in playwright.config.ts), so a forwarded IP is
 * what the limiter keys off. The third octet — 125 — is this spec's own; every
 * other suite's range is taken. `process.pid` namespaces the worker.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${process.pid % 256}.125.${ipCounter % 254}`;
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

const OPENED_AT = '2026-05-01T14:30:00.000Z';

/**
 * A funded account over the API — the tab and picker are the surfaces under
 * test, not account creation.
 */
async function createAccount(req: APIRequestContext, name: string): Promise<string> {
  const res = await req.post('/api/accounts', {
    data: { name, currency: 'USD', startingBalance: '10000' },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `POST /accounts ${name}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A position the user has open with one entry fill. The entry fill MUST precede
 * `/open`: the API refuses to open a position that has none.
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

// Any tag chip's accessible name is `<category>: <name>` (TagChip, REQ-4.5).
// The list overflow marker and the neutral side chip do not begin with a
// category word, so this matches tag chips only.
const TAG_CHIP_SELECTOR =
  '[aria-label^="setup: "], [aria-label^="emotion: "], [aria-label^="mistake: "], [aria-label^="general: "]';

/** Create one tag through the Settings tab's New tag dialog. */
async function createTagViaDialog(page: Page, name: string, categoryLabel?: string): Promise<void> {
  // Two "New tag" buttons coexist while the list is empty (toolbar + empty
  // state); the toolbar one is first in the DOM.
  await page.getByRole('button', { name: 'New tag' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New tag' })).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  if (categoryLabel) {
    await dialog.getByLabel('Category').click();
    await page.getByRole('option', { name: categoryLabel }).click();
  }
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
}

async function fetchTags(req: APIRequestContext): Promise<{ id: string; name: string }[]> {
  const res = await req.get('/api/tags');
  expect(res.status(), 'GET /tags').toBe(200);
  return (await res.json()) as { id: string; name: string }[];
}

test.describe('tags and setups', () => {
  // Desktop only. The Tags column is `hidden md:table-cell`, so the list-side
  // chips are only visible above the md breakpoint; the mobile project would
  // re-run this file at a width where that column is hidden and buy no coverage.
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile);

  test.beforeEach(async ({ request }) => {
    await ensureStackOrSkip(request);
  });

  test('offer declined once, three tags, list filter, delete', async ({ page, request }) => {
    const email = await registerUser(request, 'flow');
    await loginViaUi(page, email);
    const accountId = await createAccount(request, 'Tags account');
    const pos1 = await createOpenPosition(request, accountId);
    const pos2 = await createOpenPosition(request, accountId);

    // 2. The prominent offer is shown once; declining it is remembered across a
    //    navigation, and the secondary "Add starter tags" action takes its place.
    await page.goto('/settings/tags');
    await expect(page.locator('[data-slot="starter-tags-offer"]')).toBeVisible();
    await page.getByRole('button', { name: 'Start from scratch' }).click();
    await expect(page.locator('[data-slot="starter-tags-offer"]')).toHaveCount(0);
    await page.goto('/settings/profile');
    await page.goto('/settings/tags');
    await expect(page.locator('[data-slot="starter-tags-offer"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add starter tags' })).toBeVisible();

    // 3. Three tags in two categories, created through the tab.
    await createTagViaDialog(page, 'e2e-breakout');
    await createTagViaDialog(page, 'e2e-pullback');
    await createTagViaDialog(page, 'e2e-oversized', 'Mistakes');

    const tags = await fetchTags(request);
    const idBreakout = tags.find((t) => t.name === 'e2e-breakout')!.id;
    const idPullback = tags.find((t) => t.name === 'e2e-pullback')!.id;
    expect(idBreakout, 'e2e-breakout id').toBeTruthy();
    expect(idPullback, 'e2e-pullback id').toBeTruthy();

    // 4. Tag each position from its detail page; the chips render under the symbol.
    await tagPosition(page, pos1, ['e2e-breakout', 'e2e-pullback']);
    await expect(page.locator('[aria-label="setup: e2e-breakout"]')).toBeVisible();
    await expect(page.locator('[aria-label="setup: e2e-pullback"]')).toBeVisible();

    await tagPosition(page, pos2, ['e2e-breakout', 'e2e-oversized']);
    await expect(page.locator('[aria-label="setup: e2e-breakout"]')).toBeVisible();
    await expect(page.locator('[aria-label="mistake: e2e-oversized"]')).toBeVisible();

    // 5. The hand-typed `?tag=a,b` filter (AND semantics) shows only the position
    //    carrying both tags, and the control paints both chips; a reload holds.
    const sortedPair = [idBreakout, idPullback].sort();
    await page.goto(`/positions?tag=${sortedPair.join(',')}`);
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    const filterControl = page.getByRole('button', { name: 'Tags' }).locator('..');
    await expect(filterControl.locator('[aria-label="setup: e2e-breakout"]')).toBeVisible();
    await expect(filterControl.locator('[aria-label="setup: e2e-pullback"]')).toBeVisible();

    await page.reload();
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await expect(filterControl.locator('[aria-label="setup: e2e-breakout"]')).toBeVisible();
    await expect(filterControl.locator('[aria-label="setup: e2e-pullback"]')).toBeVisible();

    // 6. Clear, then select the two tags in reverse click order; the URL still
    //    reads them lexicographically, comma percent-encoded by the router.
    await page.getByRole('button', { name: 'Tags' }).click();
    await page.getByRole('menuitem', { name: 'Clear filter' }).click();
    await expect(page).not.toHaveURL(/tag=/);

    await page.getByRole('button', { name: 'Tags' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'e2e-pullback' }).click();
    await expect(page).toHaveURL(new RegExp(`tag=${idPullback}`));
    await page.getByRole('menuitemcheckbox', { name: 'e2e-breakout' }).click();
    await expect(page).toHaveURL(new RegExp(`tag=${sortedPair.join('%2C')}`));
    await page.keyboard.press('Escape');

    // 7. The Closed tab writes `status=closed`; All clears it.
    await page.getByRole('tab', { name: 'Closed' }).click();
    await expect(page).toHaveURL(/status=closed/);
    await page.getByRole('tab', { name: 'All' }).click();
    await expect(page).not.toHaveURL(/status=/);

    // 8. Delete one tag: the dialog names it and its position count; the two
    //    positions keep their other tag.
    await page.goto('/settings/tags');
    await page.getByRole('button', { name: 'Actions for e2e-breakout' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('e2e-breakout');
    await expect(confirm).toContainText('2 positions');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('[aria-label="setup: e2e-breakout"]')).toHaveCount(0);

    const positions = (await (await request.get('/api/positions')).json()) as {
      id: string;
      tags: { name: string }[];
    }[];
    const p1 = positions.find((p) => p.id === pos1)!;
    const p2 = positions.find((p) => p.id === pos2)!;
    expect(p1.tags.map((t) => t.name)).toEqual(['e2e-pullback']);
    expect(p2.tags.map((t) => t.name)).toEqual(['e2e-oversized']);
  });

  test('sample data paints chips, sixteen tags, and no offer', async ({ page, request }) => {
    const email = await registerUser(request, 'demo');
    await loginViaUi(page, email);
    await expect(page.getByTestId('activation-checklist')).toBeVisible();

    await page.getByTestId('zero-state-sample-data').click();
    // The seed drives fourteen trades through the real lifecycle in one
    // transaction, so it is the slowest write in the product.
    await expect(page.getByTestId('demo-banner')).toBeVisible({ timeout: 30_000 });

    await page.goto('/positions');
    const aaplRow = page
      .locator('table tbody tr')
      .filter({ has: page.getByRole('link', { name: 'AAPL', exact: true }) });
    await expect(aaplRow).toHaveCount(1);
    await expect(aaplRow.locator('[aria-label="setup: breakout"]')).toBeVisible();
    await expect(aaplRow.locator('[aria-label="emotion: calm"]')).toBeVisible();

    // AAPL plus at least six other rows carry a chip (the seven-row demo table).
    const taggedRows = page.locator('table tbody tr').filter({
      has: page.locator(TAG_CHIP_SELECTOR),
    });
    expect(await taggedRows.count()).toBeGreaterThanOrEqual(7);

    const tags = await fetchTags(request);
    expect(tags).toHaveLength(16);

    await page.goto('/settings/tags');
    await expect(page.locator('[data-slot="tags-settings"]')).toBeVisible();
    await expect(page.locator('[data-slot="starter-tags-offer"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add starter tags' })).toHaveCount(0);
  });
});

/** Open a position's detail page and tick the named tags in the picker. */
async function tagPosition(page: Page, positionId: string, names: string[]): Promise<void> {
  await page.goto(`/positions/${positionId}`);
  await page.getByRole('button', { name: 'Edit tags' }).click();
  const picker = page.getByRole('dialog');
  await expect(picker.getByRole('heading', { name: 'Edit tags' })).toBeVisible();
  for (const name of names) {
    await picker.getByRole('checkbox', { name }).click();
  }
  await picker.getByRole('button', { name: 'Save' }).click();
  await expect(picker).toBeHidden();
}
