import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Dashboard theme cross-tab sync (Task 46 — dashboard-theme-sync).
 *
 * Two-tab BroadcastChannel theme sync (design §K):
 *   - Tab A toggles to Dark.
 *   - Tab B applies the `.dark` class within ~1s without manual refocus.
 *
 * The receive-and-apply side of cross-tab sync is exclusively tested here —
 * jsdom's BroadcastChannel stub cannot deliver messages between hook
 * instances (per the design Unit Testing note), so this is the regression
 * surface for §K.
 *
 * STACK REQUIREMENT: dev stack (web + api + db) must be running.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-themesync-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
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
  // process.pid namespaces each Playwright worker process — the chromium +
  // Mobile Chrome projects re-run this spec in fresh workers that reset
  // ipCounter, so without it the low IPs replay and accumulate past the
  // /register limit (5 / 15 min). The distinct 3rd octet separates specs.
  return `10.${process.pid % 256}.122.${ipCounter % 254}`;
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

async function loginViaUi(page: Page, email: string): Promise<void> {
  // UI logins reach the API through the loopback Vite proxy, so without a unique
  // forwarded IP every spec's logins share ONE rate-limit bucket (login: 10 / 15
  // min) and the long single-worker run trips 429 → the app redirects to
  // /login?expired=true. Mirror the register pattern: a unique X-Forwarded-For
  // per login gives each its own bucket (TRUSTED_PROXIES=127.0.0.1).
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

// ---------------------------------------------------------------------------
// Two-tab BroadcastChannel theme sync test.
// ---------------------------------------------------------------------------

test.describe('Dashboard — cross-tab theme sync (BroadcastChannel)', () => {
  test.skip(({ isMobile }) => isMobile, 'Cross-tab theme sync is a multi-tab desktop scenario.');

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('Tab A toggles Dark → Tab B applies .dark via BroadcastChannel within ~1s', async ({
    page,
    context,
    request,
  }) => {
    // Register through the isolated `request` fixture (separate cookie jar) so
    // the browser context stays LOGGED OUT and `/login` renders the form for
    // loginViaUi. tabA's UI login then establishes the session on the shared
    // context; tabB inherits it for the BroadcastChannel assertion.
    const user = await registerUser(request, 'themesync');

    // Tab A — login, reach dashboard.
    const tabA = page;
    await loginViaUi(tabA, user.email);

    // Establish a known starting theme on Tab A — Light — so the test asserts
    // a deterministic flip rather than depending on the registration default.
    await tabA.getByRole('button', { name: 'Toggle theme' }).click();
    await tabA.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(tabA.locator('html')).not.toHaveClass(/dark/);
    // Allow the 300ms debounced PUT + broadcast to complete.
    await tabA.waitForTimeout(500);

    // Tab B — same context, separate page (shares session + BroadcastChannel).
    const tabB = await context.newPage();
    await tabB.goto('/dashboard');
    // Tab B should also be Light.
    await expect(tabB.locator('html')).not.toHaveClass(/dark/);

    // --- Tab A toggles Dark ---
    await tabA.bringToFront();
    await tabA.getByRole('button', { name: 'Toggle theme' }).click();
    await tabA.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(tabA.locator('html')).toHaveClass(/dark/);

    // --- Tab B receives the broadcast without manual refocus ---
    // DO NOT call tabB.bringToFront() — the test asserts BroadcastChannel
    // delivery, not focus-driven refetch.
    await expect
      .poll(async () => (await tabB.locator('html').getAttribute('class')) ?? '', {
        message: 'Tab B should apply .dark within ~1s via BroadcastChannel',
        timeout: 2000,
        intervals: [50, 100, 200, 250, 250, 250, 250, 250, 250, 250],
      })
      .toMatch(/\bdark\b/);

    await tabB.close();
  });
});
