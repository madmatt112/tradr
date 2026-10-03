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
  const symbol = uniqueSymbol();
  const position = await createOpenPosition(req, account.id, symbol);
  await markOnboardingDone(req);
  return {
    email: user.email,
    userId: user.userId,
    accountId: account.id,
    positionId: position.id,
    symbol,
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
});
