import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoHorizontalScroll, expectTargetSizes } from '../support/mobile-checks';

/**
 * Mobile responsive + navigation E2E (mobile-pwa design C7).
 *
 * Skipped unless `isMobile`, so it runs only on the Mobile Chrome (iPhone 13)
 * project — the iPhone 13 descriptor drives a WebKit engine at a 390px,
 * coarse-pointer viewport. On the desktop projects every test skips and the
 * seed is not built.
 *
 * This task adds the Requirement 5.1–5.3 mobile-navigation cases (they cover
 * task 9's MobileNav). The Requirement 6.1/6.2 route cases, which assert
 * `expectNoHorizontalScroll` / `expectTargetSizes` (e2e/support/mobile-checks.ts)
 * on each touched route, are added by later tasks and reuse this same seed.
 *
 * STACK REQUIREMENT: the dev stack (web + api + db) must be running. The seed
 * goes through the real API with a unique forwarded IP per call (the
 * drawer.mobile.spec.ts pattern), so each call gets its own auth rate-limit
 * bucket (TRUSTED_PROXIES=127.0.0.1, playwright.config.ts).
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-mobile-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

function uniqueSymbol(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return `TEST-MOBILE-${uuid.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/**
 * A unique, non-loopback IP per register/login. The auth routes are rate-limited
 * per client IP; the harness trusts 127.0.0.1 as a proxy, so the limiter keys
 * off this forwarded IP rather than the shared loopback socket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker; the distinct 3rd octet (143,
  // unused by any other suite) separates this spec from its neighbours so low
  // IPs never replay past the /register limit (5 / 15 min).
  return `10.${process.pid % 256}.143.${ipCounter % 254}`;
}

interface SeededFixture {
  email: string;
  userId: string;
  accountId: string;
  positionId: string;
  symbol: string;
  brokerageName: string;
}

async function registerUser(
  req: APIRequestContext,
  label: string,
): Promise<{ email: string; userId: string }> {
  const email = uniqueEmail(label);
  const res = await req.post('/api/auth/register', {
    data: { email, password: PASSWORD },
    headers: { 'X-Forwarded-For': uniqueIp() },
  });
  expect(res.status(), `register ${email}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return { email, userId: body.user.id };
}

async function createAccount(
  req: APIRequestContext,
  name: string,
  currency: string,
): Promise<{ id: string }> {
  const res = await req.post('/api/accounts', { data: { name, currency } });
  expect(res.status(), `POST /accounts ${currency}`).toBe(201);
  return (await res.json()) as { id: string };
}

async function createBrokerage(req: APIRequestContext, name: string): Promise<{ id: string }> {
  const res = await req.post('/api/brokerages', { data: { name } });
  expect(res.status(), 'POST /brokerages').toBe(201);
  return (await res.json()) as { id: string };
}

async function assignBrokerage(
  req: APIRequestContext,
  accountId: string,
  brokerageId: string,
): Promise<void> {
  const res = await req.put(`/api/accounts/${accountId}`, { data: { brokerageId } });
  expect(res.status(), 'PUT /accounts brokerageId').toBe(200);
}

async function createOpenPosition(
  req: APIRequestContext,
  accountId: string,
  symbol: string,
): Promise<{ id: string }> {
  const posRes = await req.post('/api/positions', {
    data: { accountId, symbol, side: 'long', assetType: 'stock' },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const position = (await posRes.json()) as { id: string };

  const entryRes = await req.post(`/api/positions/${position.id}/fills`, {
    data: {
      type: 'entry',
      price: '150.00',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-05-01T14:30:00.000Z',
    },
  });
  expect(entryRes.status(), 'POST entry fill').toBe(201);

  // The fills endpoint records the fill but does not flip status — `/open` is
  // the explicit transition, so the position lands as an open row.
  const openRes = await req.post(`/api/positions/${position.id}/open`, { data: {} });
  expect(openRes.status(), 'POST /positions/:id/open').toBe(200);
  return position;
}

async function markOnboardingDone(req: APIRequestContext): Promise<void> {
  // Past the onboarding zero-state and the "Get set up" checklist, so the
  // dashboard mounts its real shell rather than the setup surface.
  const res = await req.patch('/api/users/me/onboarding', { data: { status: 'done' } });
  expect(res.status(), 'PATCH onboarding').toBe(200);
}

async function seedFixture(req: APIRequestContext): Promise<SeededFixture> {
  // register set the session cookie on `req`, so every POST below is already
  // authenticated as the user just created.
  const user = await registerUser(req, 'nav');
  const account = await createAccount(req, 'Mobile USD', 'USD');
  // A brokerage on the account, not the position (positions.query.ts joins
  // through accounts.brokerageId), so the detail page's brokerage-fees card
  // renders its link rather than the "no brokerage assigned" placeholder —
  // the element Requirement 6.2 / design C6 item 2 targets.
  const brokerageName = `Mobile Brokerage ${Date.now()}`;
  const brokerage = await createBrokerage(req, brokerageName);
  await assignBrokerage(req, account.id, brokerage.id);
  const symbol = uniqueSymbol();
  const position = await createOpenPosition(req, account.id, symbol);
  await markOnboardingDone(req);
  return {
    email: user.email,
    userId: user.userId,
    accountId: account.id,
    positionId: position.id,
    symbol,
    brokerageName,
  };
}

async function loginAs(page: Page, email: string): Promise<void> {
  // A unique forwarded IP per login gives each its own rate-limit bucket (login:
  // 10 / 15 min), as the register seed does.
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
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

const NAV_DIALOG = { role: 'dialog' as const, name: 'Navigation' };

async function openNav(page: Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name })).toBeVisible();
}

// Every sidebar destination the overlay must carry. `Advisor` shows because the
// e2e API boots with the advisor enabled (DISABLE_ADVISOR=false); `Admin` is
// omitted — the seeded user is not an admin.
const DESTINATIONS = [
  'Dashboard',
  'Advisor',
  'Positions',
  'Calculator',
  'Options',
  'Import',
  'Performance',
  'Accounting',
  'Accounts',
  'Brokerages',
  'Settings',
  'Changelog',
  'Docs',
] as const;

test.describe('mobile navigation', () => {
  test.skip(
    ({ isMobile }) => !isMobile,
    'Mobile-only: the navigation overlay replaces the desk rail below 768px (iPhone 13 project).',
  );

  let seed: SeededFixture;

  test.beforeAll(async ({ request }, testInfo) => {
    // The desktop projects skip every test here; do not spend a seed on them.
    if (!(testInfo.project.use as { isMobile?: boolean }).isMobile) return;
    await ensureStackOrSkip(request);
    seed = await seedFixture(request);
  });

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('the desk rail is hidden and the menu control is visible', async ({ page }) => {
    await loginAs(page, seed.email);

    // The control that opens navigation is present.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();

    // The persistent rail is display:none below 768px, so its pin control and
    // its Log out button are out of the accessibility tree, and no navigation
    // overlay exists until the control is used.
    await expect(page.getByRole('button', { name: /sidebar/i })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeHidden();
    await expect(page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name })).toBeHidden();
  });

  test('focus moves inside the overlay on open', async ({ page }) => {
    await loginAs(page, seed.email);
    await openNav(page);

    const dialog = page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name });
    const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(focusInside, 'focus is trapped inside the navigation overlay').toBe(true);
  });

  test('Escape closes the overlay and returns focus to the control', async ({ page }) => {
    await loginAs(page, seed.email);
    await openNav(page);

    await page.keyboard.press('Escape');
    await expect(page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  });

  test('a backdrop tap closes the overlay and returns focus to the control', async ({ page }) => {
    await loginAs(page, seed.email);
    await openNav(page);

    // The overlay drawer is 256px wide, so the backdrop is exposed on the right
    // at this viewport. Tap it outside the panel to dismiss.
    const vw = page.viewportSize()?.width ?? 390;
    await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: vw - 20, y: 150 } });

    await expect(page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  });

  test('a navigation link navigates and closes the overlay', async ({ page }) => {
    await loginAs(page, seed.email);
    await openNav(page);

    const dialog = page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name });
    await dialog.getByRole('link', { name: 'Positions', exact: true }).click();

    await expect(page).toHaveURL(/\/positions$/);
    await expect(dialog).toBeHidden();
  });

  test('every destination and Log out are reachable from the overlay', async ({ page }) => {
    await loginAs(page, seed.email);
    await openNav(page);

    const dialog = page.getByRole(NAV_DIALOG.role, { name: NAV_DIALOG.name });
    for (const name of DESTINATIONS) {
      await expect(dialog.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(dialog.getByRole('button', { name: 'Log out' })).toBeVisible();
  });
});

/**
 * Requirement 6.1/6.2 per-route pass (design C6/C7). Each case renders a touched
 * route at the iPhone 13 viewport and asserts the page does not scroll sideways
 * and every visible interactive target is at least 24px. Later tasks add their
 * routes to this block and share its one seed.
 */
test.describe('mobile responsive routes', () => {
  test.skip(
    ({ isMobile }) => !isMobile,
    'Mobile-only: the responsive route pass runs at the iPhone 13 viewport (Req 6.1, 6.2).',
  );

  let seed: SeededFixture;

  test.beforeAll(async ({ request }, testInfo) => {
    // The desktop projects skip every test here; do not spend a seed on them.
    if (!(testInfo.project.use as { isMobile?: boolean }).isMobile) return;
    await ensureStackOrSkip(request);
    seed = await seedFixture(request);
  });

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('the positions list fits the phone (Req 6.1, 6.2)', async ({ page }) => {
    await loginAs(page, seed.email);
    await page.goto('/positions');

    // Wait for the seeded open position's row before the phone-fit assertions, so
    // the table is on screen and not mid-render.
    await expect(page.getByRole('link', { name: seed.symbol })).toBeVisible();

    await expectNoHorizontalScroll(page);
    await expectTargetSizes(page);
  });

  test('the position detail page and its fills table fit the phone (Req 6.1, 6.2, 6.4, 7.1, 7.2)', async ({
    page,
  }) => {
    await loginAs(page, seed.email);
    await page.goto(`/positions/${seed.positionId}`);

    // Wait for the detail header and the seeded entry fill row before the
    // phone-fit assertions, so the header, summary and fills table are all on
    // screen and not mid-render.
    await expect(page.getByRole('heading', { name: seed.symbol })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'entry' })).toBeVisible();

    // Requirement 6.4 / design D14: the fills table may scroll inside its own
    // container, but the PAGE itself must never scroll sideways — Fees and
    // Notes must not be the thing that forces the page wide.
    await expectNoHorizontalScroll(page);
    await expectTargetSizes(page);

    // Requirement 7.1: a compact-register table reflows by dropping columns,
    // never by turning into stacked cards — Fees and Notes drop out of the
    // accessibility tree below 768px rather than surviving as relabelled cards.
    await expect(page.getByRole('columnheader', { name: 'Fees' })).toBeHidden();
    await expect(page.getByRole('columnheader', { name: 'Notes' })).toBeHidden();
  });

  test('the fill dialog fits the phone (Req 6.1, 6.2, 6.5)', async ({ page }) => {
    await loginAs(page, seed.email);
    await page.goto(`/positions/${seed.positionId}`);
    await expect(page.getByRole('heading', { name: seed.symbol })).toBeVisible();

    await page.getByRole('button', { name: 'Add Fill' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Fill' });
    await expect(dialog).toBeVisible();

    // Requirement 6.5: the dialog itself is never taller than the viewport.
    const innerHeight = await page.evaluate(() => window.innerHeight);
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox, 'fill dialog has a bounding box').not.toBeNull();
    expect(
      dialogBox!.height,
      `dialog height (${dialogBox!.height}) must not exceed viewport height (${innerHeight})`,
    ).toBeLessThanOrEqual(innerHeight);

    // Requirement 6.5: the submit control is reachable by scrolling inside the
    // dialog, not clipped past the viewport edge.
    const submit = dialog.getByRole('button', { name: 'Add', exact: true });
    await submit.scrollIntoViewIfNeeded();
    const submitBox = await submit.boundingBox();
    expect(submitBox, 'submit control has a bounding box').not.toBeNull();
    expect(
      submitBox!.y + submitBox!.height,
      `submit control bottom (${submitBox!.y + submitBox!.height}) must stay within the viewport (${innerHeight})`,
    ).toBeLessThanOrEqual(innerHeight);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Requirement 6.1, 6.2: the rest of the phone-fit pass, with the dialog open.
    await expectNoHorizontalScroll(page);
    await expectTargetSizes(page);
  });

  test('the dashboard stack fits the phone (Req 6.1, 6.2, 6.6, 6.9, 7.1, 7.2)', async ({
    page,
  }) => {
    await loginAs(page, seed.email);
    await page.goto('/dashboard');

    // Wait for the default widgets to render (Stats Summary, and the seeded
    // open position's row inside Open Positions) before the phone-fit
    // assertions, so the whole stack is on screen and not mid-render.
    await expect(page.getByRole('heading', { name: 'Stats Summary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open Positions' })).toBeVisible();
    await expect(page.getByRole('link', { name: seed.symbol })).toBeVisible();

    // Requirement 6.6: the dashboard's mobile stack renders each widget full
    // content width, with no page-level horizontal scroll — this is the
    // observable proof that a widget's table (Req 7.1) reflows or scrolls
    // inside its own container rather than forcing the page wide, and that no
    // widget's flex row escapes its column.
    await expectNoHorizontalScroll(page);
    // Requirement 6.2: every visible interactive target (including each
    // widget's row actions) is at least 24x24 CSS px.
    await expectTargetSizes(page);
  });

  test('the side drawer fits the phone across its tabs (Req 6.1, 6.2, 6.7)', async ({ page }) => {
    await loginAs(page, seed.email);
    await page.goto('/dashboard');

    // Wait for the dashboard shell before opening the drawer, so the toggle is
    // mounted and the page behind the drawer is not mid-render.
    await expect(page.getByRole('heading', { name: 'Stats Summary' })).toBeVisible();

    // Open the side drawer through its real toggle (DrawerToggle) and confirm
    // its mobile mode is open.
    await page.getByRole('button', { name: 'Open side drawer' }).click();
    const drawer = page.getByTestId('side-drawer');
    await expect(drawer).toHaveAttribute('data-state', 'open');

    // Requirement 6.7 / design C6 item 6: the drawer's mobile mode meets the
    // phone-fit checks on each of its four tabs. For each tab: select it,
    // confirm it is the active tab, wait for that tab's settled content, then
    // run both helpers over the whole page (the full-width drawer plus the
    // dashboard behind it) — proof the drawer never forces the page wide and
    // every tab's interactive targets are tappable.
    const tabCases = [
      { name: 'Open Positions', settled: /Cost Basis only/ },
      { name: 'Quick Stats', settled: null },
      { name: 'Options Pricing', settled: /Inputs reset when you leave this tab/ },
      { name: 'Recently Created', settled: /Sorted by creation date/ },
    ] as const;

    for (const { name, settled } of tabCases) {
      const tab = page.getByRole('tab', { name });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');

      if (settled) {
        await expect(drawer.getByText(settled)).toBeVisible();
      } else {
        // Quick Stats renders four skeleton values while its performance and
        // positions queries load; wait for the first real value instead.
        await expect(drawer.getByTestId('quick-stats-win-rate-value')).toBeVisible();
      }

      await expectNoHorizontalScroll(page);
      await expectTargetSizes(page);
    }
  });
});
