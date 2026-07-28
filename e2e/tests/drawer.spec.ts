import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Side-drawer E2E — desktop cases (side-drawer Task 18, v4-5 split).
 *
 * The mobile case (case 4) lives in `drawer.mobile.spec.ts` and runs ONLY
 * under the `iphone-13` Playwright project. This file runs under default
 * desktop projects and is skipped on the `iphone-13` project via the
 * `playwright.config.ts` testIgnore rule.
 *
 * All 6 cases share a single seeded user fixture (registered in beforeAll)
 * and run in `test.describe.serial` so case 2's seed (one open position) is
 * visible to subsequent cases that need a symbol on the Open Positions tab.
 *
 * STACK REQUIREMENT: dev stack (web + api + db) must be running. Tests
 * `test.skip` early when /api/auth/me responds 5xx or is unreachable.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-drawer-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

function uniqueSymbol(): string {
  // crypto.randomUUID is available in Node 19+. Playwright's runtime is Node
  // 18+ for current Playwright releases; fall back to Date.now() entropy.
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return `TEST-DRAWER-${uuid.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
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
  return `10.${process.pid % 256}.117.${ipCounter % 254}`;
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

async function createAccount(
  req: APIRequestContext,
  name: string,
  currency: string,
): Promise<{ id: string }> {
  const res = await req.post('/api/accounts', { data: { name, currency } });
  expect(res.status(), `POST /accounts ${currency}`).toBe(201);
  return (await res.json()) as { id: string };
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

test.describe.serial('drawer', () => {
  // Single seeded user shared across all 6 cases (per v4-7: tests own their
  // seed). Case 7 (logout) registers a SECOND user (user B) for its
  // cross-user assertion.
  let userA: SeededUser;
  let userB: SeededUser;
  let accountId: string;
  let seededSymbol: string;

  test.beforeAll(async ({ request }) => {
    await ensureStackOrSkip(request);
    userA = await registerUser(request, 'user-a');
    // Register user B up front (per task line 769: if fixtures don't exist,
    // beforeAll registers both users before any case runs).
    userB = await registerUser(request, 'user-b');
  });

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Case 1 — Desktop happy flow: open drawer, tab through all 4 tabs.
  // -------------------------------------------------------------------------
  test('case 1 — desktop happy flow: switches through all 4 tabs', async ({ page }) => {
    await loginAs(page, { email: userA.email, password: PASSWORD });

    // Account + seed BEFORE opening the drawer (case 2 reuses this seed; we
    // run case 1 first per describe.serial, but case 1 needs a symbol to
    // assert visibility on the Open Positions tab — so seed here too and
    // share via the suite-scoped `seededSymbol`).
    const account = await createAccount(page.request, 'USD Account', 'USD');
    accountId = account.id;
    seededSymbol = uniqueSymbol();

    const posRes = await page.request.post('/api/positions', {
      data: {
        accountId,
        symbol: seededSymbol,
        side: 'long',
        assetType: 'stock',
      },
    });
    expect(posRes.status(), 'POST /positions').toBe(201);
    const position = (await posRes.json()) as { id: string };

    const entryRes = await page.request.post(`/api/positions/${position.id}/fills`, {
      data: {
        type: 'entry',
        price: '150.00',
        quantity: '10',
        fees: '1.00',
        filledAt: '2026-05-01T14:30:00.000Z',
      },
    });
    expect(entryRes.status(), 'POST entry fill').toBe(201);
    const openRes = await page.request.post(`/api/positions/${position.id}/open`, { data: {} });
    expect(openRes.status(), 'POST /positions/:id/open').toBe(200);

    await page.reload();
    await openDrawer(page);

    // --- Open Positions tab ---
    await page.getByRole('tab', { name: /open positions/i }).click();
    // Scope to the drawer: the dashboard's own Open Positions WIDGET also lists
    // this symbol, so an unscoped link query matches two nodes.
    await expect(
      page.getByTestId('side-drawer').getByRole('link', { name: new RegExp(seededSymbol) }),
    ).toBeVisible();
    // Per v4-4: focus pairs with role=tab AND data-state=active.
    await expect(page.locator(':focus')).toHaveAttribute('role', 'tab');
    await expect(page.locator(':focus')).toHaveAttribute('data-state', 'active');

    // --- Quick Stats tab ---
    await page.getByRole('tab', { name: /quick stats/i }).click();
    await expect(page.getByText('Win Rate')).toBeVisible();
    await expect(page.getByTestId('quick-stats-win-rate-value')).toBeVisible();

    // --- Options Pricing tab ---
    await page.getByRole('tab', { name: /options pricing/i }).click();
    await expect(page.getByLabel(/strike/i)).toBeVisible();

    // --- Recently Created tab ---
    await page.getByRole('tab', { name: /recently created/i }).click();
    await expect(page.getByText(/Drafted|Active:|Closed/).first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Case 2 — Test-owned seed: POST a fresh draft, transition to open via the
  // /open endpoint, assert the position's status === 'open' from the API
  // BEFORE reload, then assert the symbol appears in the drawer's Open
  // Positions tab via explicit visibility wait (v3-8).
  // -------------------------------------------------------------------------
  test('case 2 — test-owned seed appears in Open Positions after reload', async ({ page }) => {
    await loginAs(page, { email: userA.email, password: PASSWORD });

    const symbol = uniqueSymbol();
    const posRes = await page.request.post('/api/positions', {
      data: {
        accountId,
        symbol,
        side: 'long',
        assetType: 'stock',
      },
    });
    expect(posRes.status(), 'POST /positions').toBe(201);
    const position = (await posRes.json()) as { id: string };

    const fillRes = await page.request.post(`/api/positions/${position.id}/fills`, {
      data: {
        type: 'entry',
        price: '10.00',
        quantity: '100',
        fees: '0.00',
        filledAt: '2026-05-01T14:30:00.000Z',
      },
    });
    expect(fillRes.status(), 'POST entry fill').toBe(201);

    // The fills endpoint creates the fill but does not flip the position
    // status — `/open` is the explicit transition. Hit it and synchronously
    // assert the position is 'open' BEFORE reload (per v3-8: prove seed
    // state via the API, not via UI).
    const openRes = await page.request.post(`/api/positions/${position.id}/open`, { data: {} });
    expect(openRes.status(), 'POST /positions/:id/open').toBe(200);
    const openBody = (await openRes.json()) as { status: string };
    expect(openBody.status).toBe('open');

    await page.reload();
    await openDrawer(page);
    await page.getByRole('tab', { name: /open positions/i }).click();
    // Explicit visibility wait — robust to TanStack Query background
    // refetches (per v3-8; NOT networkidle, which stalls under staleTime: 0).
    // Scope to the drawer: the dashboard's Open Positions widget also lists it.
    await page
      .getByTestId('side-drawer')
      .getByRole('link', { name: new RegExp(symbol) })
      .waitFor({ state: 'visible', timeout: 10_000 });
  });

  // -------------------------------------------------------------------------
  // Case 3 — Persistence: open drawer, switch tab, reload, assert open + tab.
  // -------------------------------------------------------------------------
  test('case 3 — persists drawer open state + active tab across reload', async ({ page }) => {
    await loginAs(page, { email: userA.email, password: PASSWORD });
    await openDrawer(page);

    await page.getByRole('tab', { name: /quick stats/i }).click();
    await expect(page.getByText('Win Rate')).toBeVisible();

    await page.reload();

    await expect(page.getByTestId('side-drawer')).toHaveAttribute('data-state', 'open');
    await expect(page.getByRole('tab', { name: /quick stats/i })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  // -------------------------------------------------------------------------
  // Case 5 — Cross-tab: page B's data-storage-event-count increments when
  // page A switches tabs. Use context.newPage (NOT newContext — isolated
  // localStorage breaks cross-tab; per v3-11 / v4-16).
  // -------------------------------------------------------------------------
  test('case 5 — cross-tab storage events increment Page B counter', async ({ page }) => {
    await loginAs(page, { email: userA.email, password: PASSWORD });
    await openDrawer(page);

    const pageA = page;
    const context = pageA.context(); // v4-16: bind BrowserContext before newPage.
    const pageB = await context.newPage();
    await pageB.goto('/dashboard');
    // Page B must also have the drawer mounted to read the data-* attribute.
    await expect(pageB.getByTestId('side-drawer')).toBeVisible();

    const initialCount = Number(
      (await pageB.getByTestId('side-drawer').getAttribute('data-storage-event-count')) ?? '0',
    );

    // Per v4-15: Page A switches the active tab by clicking the tab strip.
    await pageA.getByRole('tab', { name: /quick stats/i }).click();

    await expect
      .poll(
        async () => {
          const value = await pageB
            .getByTestId('side-drawer')
            .getAttribute('data-storage-event-count');
          return Number(value ?? '0');
        },
        { timeout: 2000 },
      )
      .toBeGreaterThan(initialCount);

    // Page B's active tab is UNCHANGED — activeTab deltas are ignored
    // cross-tab per requirements v2-4.
    await expect(pageB.getByRole('tab', { name: /open positions/i })).toHaveAttribute(
      'data-state',
      'active',
    );

    // After reload, Page B's initializer reads localStorage and adopts Page
    // A's last write.
    await pageB.reload();
    await expect(pageB.getByRole('tab', { name: /quick stats/i })).toHaveAttribute(
      'data-state',
      'active',
    );

    await pageB.close();
  });

  // -------------------------------------------------------------------------
  // Case 6 — Reduced motion: emulateMedia, assert transition-duration is 0s.
  // -------------------------------------------------------------------------
  test('case 6 — reduced motion disables drawer transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAs(page, { email: userA.email, password: PASSWORD });
    await openDrawer(page);

    const transitionDuration = await page
      .locator('[data-testid="side-drawer"]')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    // The global prefers-reduced-motion block (index.css, visual-design spec)
    // collapses every transition to 0.01ms (≈0.00001s) — deliberately non-zero
    // so `transitionend` still fires — rather than a hard 0s. Assert the drawer
    // transition is effectively instant, not a real animated duration.
    const seconds = Number.parseFloat(transitionDuration);
    expect(Number.isNaN(seconds)).toBe(false);
    expect(seconds).toBeLessThanOrEqual(0.001);
  });

  // -------------------------------------------------------------------------
  // Case 7 — Cross-user logout: user A logs out → /login, localStorage
  // cleared, Page B's storage event count increments. Then user B logs in
  // fresh — no persisted state leaks from user A.
  // -------------------------------------------------------------------------
  test('case 7 — logout clears state + user B starts fresh', async ({
    page,
    context,
    isMobile,
  }) => {
    // Desktop-only: the logout control lives in the desktop Sidebar
    // (Sidebar.tsx), which is not surfaced on the mobile viewport, so the
    // logout button is unreachable there. Mobile drawer behavior is covered by
    // drawer.mobile.spec.ts; this mirrors the dashboard logout test, which is
    // already desktop-only.
    test.skip(Boolean(isMobile), 'desktop logout flow — Sidebar logout not on mobile viewport');
    await loginAs(page, { email: userA.email, password: PASSWORD });
    await openDrawer(page);
    await page.getByRole('tab', { name: /quick stats/i }).click();

    const pageA = page;
    const pageB = await context.newPage();
    await pageB.goto('/dashboard');
    await expect(pageB.getByTestId('side-drawer')).toBeVisible();

    // Count storage events with a test-owned window listener rather than the
    // drawer's data-storage-event-count attribute. That attribute is React
    // state, and user A's logout kills Page B's session too: Page B's next
    // auth/me refetch 401s and bounces the route tree, remounting SideDrawer
    // and resetting the attribute to 0 mid-poll (trace-verified — the count
    // reached 1, then the remount wiped it). The window object survives that
    // SPA remount, so events counted here can't be lost.
    await pageB.evaluate(() => {
      const w = window as { __drawerStorageEvents?: number };
      w.__drawerStorageEvents = 0;
      window.addEventListener('storage', (e) => {
        if (e.key === 'tradr_drawer_state') {
          w.__drawerStorageEvents = (w.__drawerStorageEvents ?? 0) + 1;
        }
      });
    });

    await pageA.getByRole('button', { name: /log ?out/i }).click();

    // Per v4-10: post-logout URL is /login (verified in useAuth.ts:40).
    await expect(pageA).toHaveURL(/\/login$/);
    expect(await pageA.evaluate(() => localStorage.getItem('tradr_drawer_state'))).toBeNull();

    // Page B should see at least one storage event from the localStorage
    // clear (v2-18: Safari batches storage events, so use >= 1). The listener
    // predates the logout click and its count survives remounts, so the only
    // wait here is cross-tab event delivery itself.
    await expect
      .poll(
        () =>
          pageB.evaluate(
            () => (window as { __drawerStorageEvents?: number }).__drawerStorageEvents ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);

    await pageB.close();

    // User-B re-login (per v4-11): clear cookies, log in as user B, assert
    // drawer is closed and no persisted state from user A.
    await pageA.context().clearCookies();
    await loginAs(pageA, { email: userB.email, password: PASSWORD });
    expect(await pageA.evaluate(() => localStorage.getItem('tradr_drawer_state'))).toBeNull();
    await expect(pageA.getByTestId('side-drawer')).toHaveAttribute('data-state', 'closed');
  });
});
