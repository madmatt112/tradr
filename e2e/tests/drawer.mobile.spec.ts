import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Side-drawer E2E — mobile case (side-drawer Task 18, v4-5 split).
 *
 * This file is scoped to the `iphone-13` Playwright project via
 * `testMatch: /drawer\.mobile\.spec\.ts/` in playwright.config.ts. Default
 * desktop projects ignore this file via `testIgnore`. Running the body-lock
 * assertion (`document.body.style.position === 'fixed'`) on a desktop
 * viewport would fail — body-scroll-lock only engages below the md
 * breakpoint (per design v4-6).
 *
 * STACK REQUIREMENT: dev stack (web + api + db) must be running.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-drawer-mobile-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * A unique, non-loopback IP per register call. The auth `/register` route is
 * rate-limited per client IP; the harness sets `TRUSTED_PROXIES=127.0.0.1`
 * (playwright.config.ts), so the limiter keys off this forwarded IP rather than
 * the shared loopback socket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // process.pid namespaces each Playwright worker process — fresh workers reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.118.${ipCounter % 254}`;
}

interface SeededUser {
  email: string;
  userId: string;
}

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

async function loginAs(page: Page, creds: { email: string; password: string }): Promise<void> {
  // UI logins reach the API through the loopback Vite proxy, so without a unique
  // forwarded IP every spec's logins share ONE rate-limit bucket (login: 10 / 15
  // min) and the long single-worker run trips 429 → the app redirects to
  // /login?expired=true. Mirror the register pattern: a unique X-Forwarded-For
  // per login gives each its own bucket (TRUSTED_PROXIES=127.0.0.1).
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': uniqueIp() });
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
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

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /open side drawer/i }).click();
  await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
}

// -----------------------------------------------------------------------------
// Case 4 — Mobile flow: backdrop, Escape, body-scroll-lock with scroll
// restoration (per v4-6).
// -----------------------------------------------------------------------------
test.describe('drawer mobile', () => {
  test('case 4 — mobile drawer: backdrop, Escape, body lock + scroll restore', async ({
    page,
    request,
  }) => {
    await ensureStackOrSkip(page.request);
    // Register through the isolated `request` fixture (its own cookie jar) so
    // the browser context stays LOGGED OUT — register's auto-session cookie
    // would otherwise redirect `/login` to the dashboard before loginAs can
    // fill the form. Mirrors drawer.spec.ts's beforeAll register pattern.
    const user = await registerUser(request, 'flow');
    await loginAs(page, { email: user.email, password: PASSWORD });

    // 1) Backdrop click closes the drawer (its onClick={close} dismiss handler).
    // On mobile (< 768px) the drawer is full-width (100vw) per the design's
    // breakpoint table, so the panel (z-40) fully occludes the backdrop (z-30)
    // — no backdrop region is pointer-reachable, and a normal .click() is
    // intercepted by the panel. The backdrop-dismiss affordance is genuinely
    // wired (and pointer-reachable on the 768–1023px range, where the drawer is
    // 360px and the backdrop is exposed); dispatch the click directly to verify
    // the handler without the impossible-on-full-width actionability check.
    await openDrawer(page);
    await expect(page.getByTestId('drawer-backdrop')).toBeVisible();
    await page.getByTestId('drawer-backdrop').dispatchEvent('click');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');

    // 2) Escape closes the drawer.
    await openDrawer(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');

    // 3) Body-scroll-lock with scroll restoration (per v4-6).
    // Scroll the page to 200 BEFORE opening; assert the body lock captures
    // the scroll offset and restores it on close. (200, not 250: removing the
    // old 48px drawer top bar shortened the page, and 250 now overshoots the
    // maximum scroll offset at this viewport — the intent is any non-zero
    // offset, captured and restored exactly.)
    await page.evaluate(() => window.scrollTo(0, 200));
    // The lock reads scrollY at open-time, so the scroll must have settled.
    await expect.poll(async () => page.evaluate(() => window.scrollY), { timeout: 2000 }).toBe(200);

    // Open via dispatchEvent (NOT .click()): the mobile DrawerToggle is inline
    // at the top of <main> (not sticky), so a real click would auto-scroll the
    // off-screen toggle into view and reset scrollY to 0 — the body lock would
    // then capture 0 instead of 200. Dispatching the click fires the toggle's
    // onClick without moving the scroll position.
    await page.getByRole('button', { name: /open side drawer/i }).dispatchEvent('click');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
    expect(await page.evaluate(() => document.body.style.position)).toBe('fixed');
    expect(await page.evaluate(() => document.body.style.top)).toBe('-200px');

    // Close drawer — body lock releases, browser restores scroll position.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');
    await expect.poll(async () => page.evaluate(() => window.scrollY), { timeout: 2000 }).toBe(200);
  });
});
