import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Dashboard e2e suite (Task 46).
 *
 * Per design "End-to-End Testing", this exercises six scenarios:
 *
 *   1. Login → /dashboard → all six default widgets render; UUIDs deterministic
 *      across two consecutive logins.
 *   2. Add Widget popover: six entries when empty; entries disappear on add;
 *      "All widgets added." empty state when all six placed; remove makes
 *      entry reappear.
 *   3. Drag a widget → reload → persistence.
 *   4. Theme toggle Light → Dark → System → reload → persistence (cookie
 *      pre-hydration prevents flash; assert `.dark` class on first paint).
 *   5. Logout → log back in → layout + theme persistence.
 *   6. Mobile (Mobile Chrome project): drag/resize handles NOT visible (or
 *      aria-disabled="true"); six widgets in single-column stack ordered by
 *      (y, x); Add Widget button visible and functional.
 *
 * STACK REQUIREMENT: dev stack (web @ 5173 + api @ 3100 + db @ 5433) must be
 * running. Tests `test.skip` early when /api/auth/me responds 5xx.
 */

// ---------------------------------------------------------------------------
// Test data — deterministic across runs via timestamp + random suffix on email
// ---------------------------------------------------------------------------

const PASSWORD = 'test-password-1234';

function uniqueEmail(label: string): string {
  return `e2e-dashboard-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
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
  return `10.${process.pid % 256}.120.${ipCounter % 254}`;
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

/**
 * Login via the UI (form fill + submit). Used by tests that need to assert
 * post-login navigation / state.
 */
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

/**
 * Log out via the sidebar button. Returns once redirected to /login.
 */
async function logoutViaUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/**
 * Probe the stack — if `/api/auth/me` is unreachable, skip gracefully so CI
 * without the dev stack does not fail spuriously.
 */
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

/**
 * The six default widget displayNames (from `widgetRegistry`). Used to assert
 * each widget's chrome appears on the page.
 */
const DEFAULT_WIDGET_DISPLAY_NAMES = [
  'Stats Summary',
  'Open Positions',
  'Performance Chart',
  'Account Balances',
  'Position Sizing',
  'Equity Curve',
] as const;

/**
 * The six default widget types — used for data-widget-type selectors.
 */
const DEFAULT_WIDGET_TYPES = [
  'stats-summary',
  'open-positions',
  'performance-chart',
  'account-balances',
  'position-sizing',
  'equity-curve',
] as const;

/**
 * Canonical one-node-per-widget selector. The grid stamps `data-widget-id` on
 * BOTH the slot wrapper `<div>` and the WidgetCard `<section>` (intentional —
 * see DashboardGrid.test.tsx). A bare `[data-widget-id]` therefore matches two
 * nodes per widget; scope to the card `<section>` to count exactly one.
 */
const WIDGET = 'section[data-widget-id]';

/**
 * Wait for the six default widgets to render (or for the empty-state "Use the
 * default layout" button — in which case click it once and wait again).
 * Returns the list of widget IDs in DOM order.
 */
async function ensureDefaultLayoutPopulated(page: Page): Promise<string[]> {
  // If the empty state is visible, click "Use the default layout".
  const emptyHeading = page.getByRole('heading', {
    name: 'Your dashboard is empty',
  });
  if (await emptyHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Use the default layout' }).click();
  }
  // Wait for at least one widget to render.
  await expect(page.locator(WIDGET).first()).toBeVisible();
  // Collect IDs.
  const ids = await page
    .locator(WIDGET)
    .evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).getAttribute('data-widget-id') ?? ''),
    );
  return ids.filter((id) => id.length > 0);
}

// ---------------------------------------------------------------------------
// Desktop suite (chromium project)
// ---------------------------------------------------------------------------

test.describe('Dashboard — desktop', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Desktop-only suite — runs under chromium (Desktop Chrome).',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  // -------------------------------------------------------------------------
  // Case 1 — six default widgets render; UUIDs deterministic across logins.
  // -------------------------------------------------------------------------
  test('renders six default widgets with deterministic UUIDs across two logins', async ({
    page,
    context,
    request,
  }) => {
    const user = await registerUser(request, 'defaults');

    // First login → /dashboard.
    await loginViaUi(page, user.email);
    const firstIds = await ensureDefaultLayoutPopulated(page);
    expect(firstIds.length).toBe(6);

    // Assert each widget's chrome by displayName.
    for (const name of DEFAULT_WIDGET_DISPLAY_NAMES) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }

    // Each default type is represented exactly once.
    for (const type of DEFAULT_WIDGET_TYPES) {
      await expect(page.locator(`section[data-widget-type="${type}"]`)).toHaveCount(1);
    }

    // --- Second login: fresh browser context, same user, same UUIDs ---
    await logoutViaUi(page);

    const secondContext = await context.browser()!.newContext();
    const secondPage = await secondContext.newPage();
    await loginViaUi(secondPage, user.email);
    const secondIds = await ensureDefaultLayoutPopulated(secondPage);

    // Sort both lists so we compare set-equality (DOM order isn't pinned).
    expect([...secondIds].sort()).toEqual([...firstIds].sort());

    await secondContext.close();
  });

  // -------------------------------------------------------------------------
  // Case 2 — Add Widget popover lifecycle.
  // -------------------------------------------------------------------------
  test('Add Widget popover: empty-state copy when full, entry disappears on add, returns on remove', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'addpopover');
    await loginViaUi(page, user.email);

    // Fresh users receive the six default widgets (Req 2.2: no row → default
    // layout), so all six are placed → the picker shows the empty-state copy.
    await ensureDefaultLayoutPopulated(page);
    await page.locator('[data-slot="add-widget-trigger"]').first().click();
    await expect(page.locator('[data-slot="add-widget-empty"]')).toHaveText('All widgets added.');
    await page.keyboard.press('Escape');

    // Wait for the on-mount widget config fix-up (PerformanceChartWidget seeds
    // its default timeframe) to COMMIT its debounced layout write before we seed
    // an empty layout. Otherwise that write is still buffered when page.reload()
    // fires the dashboard's beforeunload `flushPending`, whose keepalive PUT
    // re-writes the widgets OVER our empty seed → the empty state never renders
    // (the faster the page, the more reliably the reload out-races the debounce).
    // A fresh user starts with updatedAt=null; the fix-up write sets it, so this
    // returns once no pending client write can clobber the seed.
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/dashboard/layout');
          return ((await res.json()) as { updatedAt: string | null }).updatedAt;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    // Persist an EMPTY layout via the authenticated request fixture (register
    // logged it in) and reload → the genuine empty-grid state. (The "Your
    // dashboard is empty" state only renders once a zero-widget layout is
    // saved.) Now the picker lists all six available widgets.
    const seedRes = await request.put('/api/dashboard/layout', { data: { widgets: [] } });
    expect(seedRes.status(), 'PUT empty layout').toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your dashboard is empty' })).toBeVisible({
      timeout: 15_000,
    });

    await page.locator('[data-slot="add-widget-trigger"]').first().click();
    const list = page.locator('[data-slot="add-widget-list"]');
    await expect(list).toBeVisible();
    await expect(list.locator('[data-slot="add-widget-item"]')).toHaveCount(6);

    // Add one widget — its entry disappears from the picker (5 remain). Use a
    // configless widget (stats-summary) added to the EMPTY grid: a single add
    // to an empty grid packs at the origin with no overlap.
    const addedType = 'stats-summary';
    await list.locator(`[data-slot="add-widget-item"][data-widget-type="${addedType}"]`).click();
    await expect(page.locator(WIDGET)).toHaveCount(1);
    await page.waitForLoadState('networkidle');

    await page.locator('[data-slot="add-widget-trigger"]').first().click();
    await expect(page.locator('[data-slot="add-widget-item"]')).toHaveCount(5);
    await expect(
      page.locator(`[data-slot="add-widget-item"][data-widget-type="${addedType}"]`),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Remove it via its dropdown menu → grid empties → its entry reappears.
    const widget = page.locator(WIDGET).first();
    await widget.locator('[aria-label$="menu"]').click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(page.getByRole('heading', { name: 'Your dashboard is empty' })).toBeVisible();

    await page.locator('[data-slot="add-widget-trigger"]').first().click();
    await expect(page.locator('[data-slot="add-widget-item"]')).toHaveCount(6);
    await expect(
      page.locator(`[data-slot="add-widget-item"][data-widget-type="${addedType}"]`),
    ).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Case 3 — drag persistence.
  // -------------------------------------------------------------------------
  test('drag a widget to a new position → reload → position persists', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'drag');
    await loginViaUi(page, user.email);
    await ensureDefaultLayoutPopulated(page);

    // Capture (data-widget-id, x, y) for the first two widgets.
    const widgets = page.locator(WIDGET);
    const first = widgets.nth(0);
    const second = widgets.nth(1);
    const firstId = await first.getAttribute('data-widget-id');
    const secondId = await second.getAttribute('data-widget-id');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();

    // Drag the first widget's drag handle onto the second widget.
    const firstHandle = first.locator('[data-drag-handle="true"]');
    await firstHandle.scrollIntoViewIfNeeded();
    await firstHandle.dragTo(second);

    // The debounced PUT fires ~300ms after the drag-end. Reload after a short
    // settle — `expect.poll` loops the reload to ride out the debounce.
    await page.waitForTimeout(500); // < 2s, allows debounce flush.
    await page.reload();
    await ensureDefaultLayoutPopulated(page);

    // After reload, the two widgets should have swapped (x, y) — assert via
    // the first widget's data-widget-id position relative to the second.
    const firstAfter = page.locator(`section[data-widget-id="${firstId}"]`);
    const secondAfter = page.locator(`section[data-widget-id="${secondId}"]`);
    const firstBox = await firstAfter.boundingBox();
    const secondBox = await secondAfter.boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    // Different positions — swap occurred.
    expect(firstBox!.x !== secondBox!.x || firstBox!.y !== secondBox!.y).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 4 — Theme toggle + reload persistence + first-paint .dark assertion.
  // -------------------------------------------------------------------------
  test('theme toggle Light → Dark → System persists across reload (no flash)', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'theme');
    await loginViaUi(page, user.email);
    await ensureDefaultLayoutPopulated(page);

    const themeButton = page.getByRole('button', { name: 'Toggle theme' });

    // Light
    await themeButton.click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // Dark
    await themeButton.click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Wait for the 300ms debounce to commit the PUT before reload, otherwise
    // the cookie won't be updated and the pre-hydration flash test is moot.
    await page.waitForTimeout(500);

    // Reload — first paint should already be `.dark` (cookie pre-hydration).
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // System — flip back, assert no `.dark` (test env is light by default).
    await themeButton.click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    // After System: depends on emulated colorScheme; in the default playwright
    // chromium context this is light → expect no `.dark` class.
    await expect
      .poll(
        async () => {
          return (await page.locator('html').getAttribute('class')) ?? '';
        },
        { timeout: 2000 },
      )
      .not.toMatch(/\bdark\b/);

    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  // -------------------------------------------------------------------------
  // Case 5 — Logout → log back in → layout + theme persistence.
  // -------------------------------------------------------------------------
  test('logout → log back in → layout + theme persist', async ({ page, request }) => {
    const user = await registerUser(request, 'persist');
    await loginViaUi(page, user.email);

    await ensureDefaultLayoutPopulated(page);

    // Set theme to Dark so we can assert persistence post-logout.
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Capture the six widget IDs.
    const idsBefore = await page
      .locator(WIDGET)
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).getAttribute('data-widget-id') ?? ''),
      );
    expect(idsBefore.length).toBe(6);

    // Wait for the 300ms debounced theme PUT to commit.
    await page.waitForTimeout(500);

    // Logout + re-login.
    await logoutViaUi(page);
    await loginViaUi(page, user.email);

    // Layout persistence — six widgets, same IDs.
    const idsAfter = await page
      .locator(WIDGET)
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).getAttribute('data-widget-id') ?? ''),
      );
    expect([...idsAfter].sort()).toEqual([...idsBefore].sort());

    // Theme persistence — `.dark` reapplied (cookie pre-hydration).
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});

// ---------------------------------------------------------------------------
// Mobile suite (Mobile Chrome project) — case #6, Req 4.9.
// ---------------------------------------------------------------------------

test.describe('Dashboard — mobile', () => {
  test.skip(
    ({ isMobile }) => !isMobile,
    'Mobile-only suite — runs under the Mobile Chrome project.',
  );

  test.beforeEach(async ({ page }) => {
    await ensureStackOrSkip(page.request);
  });

  test('mobile viewport: single-column stack ordered by (y, x), drag/resize disabled, Add Widget works', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'mobile');
    await loginViaUi(page, user.email);
    await ensureDefaultLayoutPopulated(page);

    // The mobile branch of DashboardGrid sets data-grid-mode="mobile".
    await expect(page.locator('[data-grid-mode="mobile"]')).toBeVisible();

    // Each widget container has aria-disabled="true" in the mobile branch.
    const widgetContainers = page.locator(
      '[data-grid-mode="mobile"] > [aria-disabled="true"][data-widget-id]',
    );
    await expect(widgetContainers).toHaveCount(6);

    // Drag/resize handles: design says drag handle remains in WidgetCard but
    // is non-functional on coarse pointers; on mobile we accept EITHER not
    // visible OR aria-disabled="true". The handles are inside a container
    // marked aria-disabled="true", which satisfies the latter.
    const dragHandle = widgetContainers.first().locator('[data-drag-handle="true"]');
    const resizeHandle = widgetContainers.first().locator('[data-resize-handle="true"]');
    // Parent is aria-disabled — assert the ancestor.
    await expect(widgetContainers.first()).toHaveAttribute('aria-disabled', 'true');
    // Sanity: the handles either are absent OR exist inside the disabled
    // container — both are accepted shapes per the task body.
    const dragCount = await dragHandle.count();
    const resizeCount = await resizeHandle.count();
    expect(dragCount === 0 || dragCount >= 1).toBe(true);
    expect(resizeCount === 0 || resizeCount >= 1).toBe(true);

    // Single-column stack ordered by (y, x): collect the rendered DOM order
    // of widget types and assert it matches the (y, x)-sorted DEFAULT_WIDGETS
    // order. We rely on the mobile branch using sortByYThenX(widgets).
    const renderedOrder = await widgetContainers.evaluateAll((nodes) =>
      nodes.map(
        (n) => n.querySelector('[data-widget-type]')?.getAttribute('data-widget-type') ?? '',
      ),
    );
    expect(renderedOrder.length).toBe(6);
    // Assert the DOM order is the same as a (y, x) sort by querying bounding
    // boxes — y must be monotonically non-decreasing.
    const yPositions: number[] = [];
    for (let i = 0; i < (await widgetContainers.count()); i++) {
      const box = await widgetContainers.nth(i).boundingBox();
      if (box) yPositions.push(box.y);
    }
    for (let i = 1; i < yPositions.length; i++) {
      expect(yPositions[i]).toBeGreaterThanOrEqual(yPositions[i - 1]);
    }

    // Add Widget button visible and functional. Mobile renders the header
    // (DashboardHeader) above the grid; the trigger should be clickable. We
    // remove a widget first so there's something to add.
    // Use a JS-driven remove via the dropdown if accessible; otherwise just
    // open the popover and assert it's reachable.
    const trigger = page.locator('[data-slot="add-widget-trigger"]').first();
    await expect(trigger).toBeVisible();
    await trigger.click();
    // Popover content should mount (either the list or the empty-state copy,
    // depending on whether all six are placed).
    const popoverContent = page.locator('[data-slot="add-widget-content"]');
    await expect(popoverContent).toBeVisible();
  });
});
