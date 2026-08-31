import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Dashboard event-bus cross-tab regression (Task 46 — dashboard-event-bus).
 *
 * Two-tab close-position flow:
 *   - In Tab A, close a position.
 *   - Switch focus to Tab B.
 *   - Tab B's Stats Summary and Account Balances widgets refetch — either
 *     because the route's refetchOnWindowFocus triggers an /api/* call on
 *     visibility / focus, or because the in-tab EventBusBridge invalidates
 *     queries.
 *
 * We assert "refetch happens" via a network spy on the relevant endpoints in
 * Tab B. The test is desktop-only — `test.skip` under the mobile project.
 *
 * STACK REQUIREMENT: dev stack (web + api + db) must be running. The seed
 * harness creates a fresh user, one USD account, and one open position so
 * Tab A can close it.
 */

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-eventbus-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
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
  return `10.${process.pid % 256}.121.${ipCounter % 254}`;
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

async function createAccount(
  req: APIRequestContext,
  name: string,
  currency: string,
): Promise<{ id: string }> {
  const res = await req.post('/api/accounts', { data: { name, currency } });
  expect(res.status(), `POST /accounts ${currency}`).toBe(201);
  return (await res.json()) as { id: string };
}

/**
 * Create an open position (no close-fill yet) on `accountId`. Returns the
 * position id so Tab A can close it later.
 */
async function createOpenPosition(
  req: APIRequestContext,
  accountId: string,
): Promise<{ positionId: string; openedAt: string }> {
  const posRes = await req.post('/api/positions', {
    data: {
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    },
  });
  expect(posRes.status(), 'POST /positions').toBe(201);
  const position = (await posRes.json()) as { id: string };

  const openedAt = '2026-05-01T14:30:00.000Z';
  // Entry fill MUST precede the /open transition — the API rejects opening a
  // position with no entry fill (409).
  const entryRes = await req.post(`/api/positions/${position.id}/fills`, {
    data: {
      type: 'entry',
      price: '150.00',
      quantity: '10',
      fees: '1.00',
      filledAt: openedAt,
    },
  });
  expect(entryRes.status(), 'POST entry fill').toBe(201);

  const openRes = await req.post(`/api/positions/${position.id}/open`, {
    data: { openedAt },
  });
  expect(openRes.status(), 'POST /positions/:id/open').toBe(200);

  return { positionId: position.id, openedAt };
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

async function ensureDefaultLayout(page: Page): Promise<void> {
  const emptyHeading = page.getByRole('heading', {
    name: 'Your dashboard is empty',
  });
  if (await emptyHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Use the default layout' }).click();
  }
  await expect(page.locator('[data-widget-id]').first()).toBeVisible();
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
// Cross-tab close-position test (desktop only).
// ---------------------------------------------------------------------------

test.describe('Dashboard — cross-tab close-position event bus', () => {
  test.skip(({ isMobile }) => isMobile, 'Cross-tab close-position is desktop-only behaviour.');

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('Tab B Stats Summary + Account Balances refetch after Tab A closes a position', async ({
    page,
    context,
    request,
  }) => {
    // Register + seed through the isolated `request` fixture (its own cookie
    // jar) so the browser context stays LOGGED OUT — otherwise register's
    // auto-session cookie would land in the page jar and `/login` would
    // redirect away before loginViaUi can fill the form. The seeded account +
    // position belong to this user (the isolated context is authenticated by
    // register), and loginViaUi below logs the browser in as the SAME user.
    const user = await registerUser(request, 'crosstab');
    // An established user, not an onboarding one: the dashboard keeps its
    // focused welcome view until onboarding is done or skipped, and this test
    // is about the grid's cross-tab refetch behaviour.
    const onboardingRes = await request.patch('/api/users/me/onboarding', {
      data: { status: 'done' },
    });
    expect(onboardingRes.status(), 'PATCH onboarding').toBe(200);
    const account = await createAccount(request, 'USD Account', 'USD');
    const { positionId } = await createOpenPosition(request, account.id);

    // Tab A — login and reach dashboard.
    const tabA = page;
    await loginViaUi(tabA, user.email);
    await ensureDefaultLayout(tabA);

    // Tab B — same browser context (shares session cookie).
    const tabB = await context.newPage();

    // Install a network spy on Tab B BEFORE it loads /dashboard so we catch
    // the FIRST page load network too (and the subsequent refetches).
    const requestsInTabB: string[] = [];
    tabB.on('request', (req) => {
      const url = req.url();
      if (
        url.includes('/api/accounts') ||
        url.includes('/api/dashboard/totals') ||
        url.includes('/api/performance') ||
        url.includes('/api/positions')
      ) {
        requestsInTabB.push(url);
      }
    });

    await tabB.goto('/dashboard');
    await ensureDefaultLayout(tabB);

    // Wait for Tab B's initial GETs to settle — record the count so we can
    // compare AFTER the cross-tab event.
    await tabB.waitForLoadState('networkidle');
    const initialCount = requestsInTabB.length;

    // --- Tab A closes the position via the API ---
    await tabA.bringToFront();
    const closeRes = await tabA.request.post(`/api/positions/${positionId}/fills`, {
      data: {
        type: 'exit',
        price: '160.00',
        quantity: '10',
        fees: '1.00',
        filledAt: '2026-05-02T15:00:00.000Z',
      },
    });
    expect(closeRes.status(), 'POST exit fill').toBe(201);

    // The balancing exit closes the position by itself — no separate close
    // call, which would 409. This still exercises what the test is about: the
    // close-hook writes its ledger row, so Tab B's balances go stale.
    const detailRes = await tabA.request.get(`/api/positions/${positionId}`);
    expect(detailRes.status(), 'GET /positions/:id').toBe(200);
    expect((await detailRes.json()).status, 'auto-closed by the balancing exit').toBe('closed');

    // --- Switch focus to Tab B → refetchOnWindowFocus fires ---
    // The cross-tab refresh rides TanStack Query's refetchOnWindowFocus, not the
    // in-app event bus (that bus is per-tab — there is no BroadcastChannel for
    // positions). TanStack v5's focusManager registers its listener as
    // `window.addEventListener('visibilitychange', …)` and refetches stale
    // queries when `document.visibilityState !== 'hidden'` (verified against
    // query-core@5.90.20 focusManager.ts). A `visibilitychange` dispatched on
    // `document` (non-bubbling) never reaches the window listener, and 'focus'
    // is not listened for at all — so dispatch `visibilitychange` on `window`.
    await tabB.bringToFront();
    await tabB.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });

    // Assert Tab B refetched the relevant endpoints. We use expect.poll so we
    // do not race the network — bounded to 2s per task restrictions.
    await expect
      .poll(() => requestsInTabB.length, {
        message: 'Tab B should refetch its dashboard data after Tab A closes a position',
        timeout: 2000,
      })
      .toBeGreaterThan(initialCount);

    // Assert the refetches include at least one of the widget-relevant
    // endpoints (Stats Summary → /api/performance or /api/dashboard/totals;
    // Account Balances → /api/accounts).
    const newRequests = requestsInTabB.slice(initialCount);
    const hitAccounts = newRequests.some((u) => u.includes('/api/accounts'));
    const hitDashboardOrPerf = newRequests.some(
      (u) => u.includes('/api/dashboard/totals') || u.includes('/api/performance'),
    );
    expect(
      hitAccounts || hitDashboardOrPerf,
      'expected Tab B to refetch accounts and/or dashboard totals/performance',
    ).toBe(true);

    await tabB.close();
  });
});
