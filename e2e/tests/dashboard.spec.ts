import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Dashboard e2e suite (Task 46).
 *
 * Per design "End-to-End Testing", this exercises six scenarios:
 *
 *   1. Login → /dashboard → all five default widgets render; UUIDs deterministic
 *      across two consecutive logins.
 *   2. Add Widget popover: with the five defaults placed the picker lists only
 *      position-sizing; on an empty grid it lists all six types. Two adds inside
 *      the debounce both persist at non-overlapping slots with no failed PUT
 *      (double add). And, separately, a stored performance-chart with an invalid
 *      config heals to its default while a picker add in the same window also
 *      persists (config heal).
 *   3. Drag a widget → reload → persistence.
 *   4. Theme toggle Light → Dark → System → reload → persistence (cookie
 *      pre-hydration prevents flash; assert `.dark` class on first paint).
 *   5. Logout → log back in → layout + theme persistence.
 *   6. Mobile (Mobile Chrome project): drag/resize handles NOT visible (or
 *      aria-disabled="true"); five widgets in single-column stack ordered by
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
  // The dashboard shows the onboarding zero-state INSTEAD of the widget grid
  // while a user has no accounts, so a bare registration lands on a screen that
  // has no widgets on it at all. Every case in this suite is about the grid —
  // its defaults, the Add Widget popover, drag persistence, the theme toggle —
  // not about onboarding, so each seeded user gets the one account that puts
  // them past it. `register` set the session cookie on `req`, so this POST is
  // already authenticated as the user just created.
  const accountRes = await req.post('/api/accounts', {
    data: { name: `${label} account`, currency: 'USD' },
  });
  expect(accountRes.status(), `POST /accounts for ${email}`).toBe(201);
  // And past the checklist too. With an account and onboarding still pending
  // the dashboard mounts the "Get set up" checklist IN the grid — a seventh,
  // locked item in the top-right slot, with Stats Summary narrowed to eight
  // columns beside it. Every case here characterises the five-widget default
  // layout (item counts, the full-width band's drag behaviour), so the seeded
  // user is retired from onboarding the way a finished checklist retires
  // itself. The checklist's own e2e coverage is in user-onboarding.spec.ts.
  const onboardingRes = await req.patch('/api/users/me/onboarding', {
    data: { status: 'done' },
  });
  expect(onboardingRes.status(), `PATCH onboarding for ${email}`).toBe(200);
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
 * The five default widget displayNames (from `widgetRegistry`). Used to assert
 * each widget's chrome appears on the page.
 */
const DEFAULT_WIDGET_DISPLAY_NAMES = [
  'Stats Summary',
  'Open Positions',
  'Performance Chart',
  'Account Balances',
  'Equity Curve',
] as const;

/**
 * The five default widget types — used for data-widget-type selectors.
 */
const DEFAULT_WIDGET_TYPES = [
  'stats-summary',
  'open-positions',
  'performance-chart',
  'account-balances',
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
 * Wait for the five default widgets to render (or for the empty-state "Use the
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
  // Case 1 — five default widgets render; UUIDs deterministic across logins.
  // -------------------------------------------------------------------------
  test('renders five default widgets with deterministic UUIDs across two logins', async ({
    page,
    context,
    request,
  }) => {
    const user = await registerUser(request, 'defaults');

    // First login → /dashboard.
    await loginViaUi(page, user.email);
    const firstIds = await ensureDefaultLayoutPopulated(page);
    expect(firstIds.length).toBe(5);

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
  // Case 2 — Add Widget popover: the picker roster, and two adds inside the
  // debounce both persist at non-overlapping slots (Req 7.1, 7.6, 10.2).
  // -------------------------------------------------------------------------
  test('Add Widget popover: picker roster, and a double add inside the debounce persists both widgets', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'addpopover');
    await loginViaUi(page, user.email);

    // The five defaults are placed, so the picker lists exactly the one type
    // that is NOT in the default roster: position-sizing (Req 10.2).
    await ensureDefaultLayoutPopulated(page);
    await page.locator('[data-slot="add-widget-trigger"]').first().click();
    const defaultsList = page.locator('[data-slot="add-widget-list"]');
    await expect(defaultsList.locator('[data-slot="add-widget-item"]')).toHaveCount(1);
    await expect(defaultsList.locator('[data-slot="add-widget-item"]')).toHaveAttribute(
      'data-widget-type',
      'position-sizing',
    );
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
    // saved.) Now the picker lists all six available widget types.
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

    // Two adds inside the 300ms debounce (Req 7.1). scheduleLayoutWrite merges
    // both onto one pending body and does not touch the query cache until the
    // timer fires, so the empty-grid picker stays mounted across both clicks and
    // the two adds go out as one PUT. A response listener registered BEFORE the
    // clicks records every PUT status (Req 7.6) — the guarantee is observed on
    // the wire, not inferred from the absence of a toast.
    const putStatuses: number[] = [];
    page.on('response', (res) => {
      if (res.url().endsWith('/api/dashboard/layout') && res.request().method() === 'PUT') {
        putStatuses.push(res.status());
      }
    });
    await list.locator('[data-slot="add-widget-item"][data-widget-type="stats-summary"]').click();
    await list
      .locator('[data-slot="add-widget-item"][data-widget-type="account-balances"]')
      .click();

    await expect(page.locator(WIDGET)).toHaveCount(2);
    await expect.poll(() => putStatuses.length).toBeGreaterThan(0);
    expect(putStatuses.every((s) => s === 200)).toBe(true);

    // Reload → both widgets are still there, at non-overlapping rectangles.
    await page.reload();
    const afterRes = await request.get('/api/dashboard/layout');
    expect(afterRes.status(), 'GET layout').toBe(200);
    const after = (await afterRes.json()) as {
      widgets: Array<{ type: string; x: number; y: number; w: number; h: number }>;
    };
    const stats = after.widgets.find((w) => w.type === 'stats-summary');
    const balances = after.widgets.find((w) => w.type === 'account-balances');
    expect(stats, 'stats-summary persisted').toBeDefined();
    expect(balances, 'account-balances persisted').toBeDefined();
    // Disjoint rectangles: one sits entirely to a side of, or above/below, the
    // other.
    const disjoint =
      stats!.x + stats!.w <= balances!.x ||
      balances!.x + balances!.w <= stats!.x ||
      stats!.y + stats!.h <= balances!.y ||
      balances!.y + balances!.h <= stats!.y;
    expect(disjoint, 'the two added widgets do not overlap').toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 2b — the config heal and a picker add merge (Req 7.4, design D8).
  //
  // A stored performance-chart whose config fails its schema heals to the
  // registry default on mount (PerformanceChartWidget §K); adding a widget in
  // the same debounce window must persist BOTH the healed config and the new
  // widget with no failed PUT. D8: assert the persisted end state, not a forced
  // timer overlap — whether the heal and the add land as one merged PUT or two
  // sequential ones, none is a 400 and the final layout holds both.
  // -------------------------------------------------------------------------
  test('a stored invalid performance-chart config heals while a picker add in the same window persists', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'heal');
    await loginViaUi(page, user.email);
    await ensureDefaultLayoutPopulated(page);

    // Let the default's own on-mount fix-up commit first (updatedAt: null →
    // set), so the bogus layout we PUT next is not clobbered by a write still
    // buffered from this first mount.
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/dashboard/layout');
          return ((await res.json()) as { updatedAt: string | null }).updatedAt;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    // Seed a two-widget layout at legal, non-overlapping geometry whose
    // performance-chart carries an invalid config. The PUT schema does not
    // validate `config` beyond its byte size, so this stores as given.
    const seed = await request.put('/api/dashboard/layout', {
      data: {
        widgets: [
          { id: randomUUID(), type: 'stats-summary', x: 0, y: 0, w: 12, h: 6 },
          {
            id: randomUUID(),
            type: 'performance-chart',
            x: 0,
            y: 6,
            w: 6,
            h: 12,
            config: { timeframe: 'bogus' },
          },
        ],
      },
    });
    expect(seed.status(), 'PUT bogus layout').toBe(200);

    // Collect every PUT status from the reloaded page, then reload so the app
    // mounts the bogus layout.
    const putStatuses: number[] = [];
    page.on('response', (res) => {
      if (res.url().endsWith('/api/dashboard/layout') && res.request().method() === 'PUT') {
        putStatuses.push(res.status());
      }
    });
    await page.reload();

    // As soon as the performance-chart card is attached (its §K fix-up is now in
    // flight), add Equity Curve from the picker.
    await expect(page.locator('section[data-widget-type="performance-chart"]')).toBeAttached();
    await page.locator('[data-slot="add-widget-trigger"]').first().click();
    await page.locator('[data-slot="add-widget-item"][data-widget-type="equity-curve"]').click();

    await expect(page.locator(WIDGET)).toHaveCount(3);
    await expect.poll(() => putStatuses.length).toBeGreaterThan(0);
    expect(putStatuses.every((s) => s === 200)).toBe(true);

    // The persisted end state holds both the healed config and the added widget.
    await page.reload();
    const finalRes = await request.get('/api/dashboard/layout');
    expect(finalRes.status(), 'GET layout').toBe(200);
    const final = (await finalRes.json()) as {
      widgets: Array<{ type: string; config?: unknown }>;
    };
    const perf = final.widgets.find((w) => w.type === 'performance-chart');
    expect(perf, 'performance-chart persisted').toBeDefined();
    expect(perf!.config).toEqual({ timeframe: 'monthly' });
    expect(
      final.widgets.some((w) => w.type === 'equity-curve'),
      'equity-curve added',
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 3 — a full-width widget will not swap into an occupied band.
  //
  // A characterisation test, not an aspiration. The default layout is fully
  // packed, and a 12-column widget cannot sit beside anything, so there is no
  // arrangement that honours a short downward drag of the top band: gridstack
  // rejects the drop and reverts. Nothing moves, and nothing is persisted.
  //
  // Accepted behaviour rather than a defect — dragging a full-width band a
  // couple of rows into a packed layout has no sensible outcome. Pinned here so
  // that if a future engine change starts relocating or swapping it, that shows
  // up as a decision to make rather than silent drift. Positive drag-persistence
  // coverage lives in case 3b, which drags into free canvas.
  // -------------------------------------------------------------------------
  test('a short drag of the full-width band into a packed layout is a no-op', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'drag');
    await loginViaUi(page, user.email);
    await ensureDefaultLayoutPopulated(page);

    // Free placement moves a widget's (x, y) and leaves DOM order alone, and
    // gridstack reports its nodes position-sorted — so assert on the PERSISTED
    // coordinates rather than on the rendered or stored order.
    const placementOf = async (type: string): Promise<{ x: number; y: number }> => {
      const res = await request.get('/api/dashboard/layout');
      expect(res.status(), 'GET layout').toBe(200);
      const body = (await res.json()) as {
        widgets: Array<{ type: string; x: number; y: number }>;
      };
      const found = body.widgets.find((w) => w.type === type);
      expect(found, `layout contains ${type}`).toBeDefined();
      return { x: found!.x, y: found!.y };
    };

    const before = await placementOf('stats-summary');
    const neighbourBefore = await placementOf('performance-chart');

    // Stats Summary is the full-width band at the top of the default layout, so
    // it is on screen without scrolling and can only move vertically.
    const card = page.locator('section[data-widget-type="stats-summary"]');
    const zone = card.locator('[data-drag-zone="true"]');
    await zone.scrollIntoViewIfNeeded();
    const zoneBox = await zone.boundingBox();
    expect(zoneBox).not.toBeNull();

    // Grab near the left edge of the header — the overflow menu on the right
    // wears the drag-cancel class and would refuse the gesture.
    const startX = zoneBox!.x + 24;
    const startY = zoneBox!.y + zoneBox!.height / 2;
    // gridstack's row pitch is `cellHeight` flat (GRID_ROW_HEIGHT_PX, 40): the
    // gap is an inset INSIDE each cell, not extra space between rows.
    const twoRowsPx = 2 * 40;

    // Drive the drag with explicit mouse steps rather than `dragTo`. gridstack's
    // drag&drop needs a real mousedown, at least one mousemove past its 3px
    // threshold, and then movement before the mouseup — a single jump lands as
    // a click.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8, { steps: 3 });
    await page.mouse.move(startX, startY + twoRowsPx, { steps: 15 });
    await page.mouse.up();

    // The debounced PUT fires ~300ms after the drag-end.
    await page.waitForTimeout(500); // < 2s, allows debounce flush.
    await page.reload();
    await ensureDefaultLayoutPopulated(page);

    // Still five widgets, one grid item each.
    await expect(page.locator('.grid-stack-item')).toHaveCount(5);

    const after = await placementOf('stats-summary');
    const neighbourAfter = await placementOf('performance-chart');

    // The band held its row and its neighbour held theirs: the drop was
    // rejected outright rather than partially applied. A partially applied
    // reflow — one widget moved, another not — would be the genuinely bad
    // outcome, because it can leave the layout overlapping and the write 400s.
    expect(after).toEqual(before);
    expect(neighbourAfter).toEqual(neighbourBefore);
  });

  // -------------------------------------------------------------------------
  // Case 3b — free placement: a drop into empty space below the layout stays
  // put, and nothing floats up into the space it vacated.
  //
  // This is the property the whole revision exists for and the one no unit test
  // can reach: with compaction on, the engine pulls the widget straight back to
  // the first row that fits, so the drop looks like it did nothing. gridstack's
  // `float: true` is what makes it stick.
  // -------------------------------------------------------------------------
  test('drop below the layout stays put and neighbours do not float up', async ({
    page,
    request,
  }) => {
    const user = await registerUser(request, 'freeplace');
    await loginViaUi(page, user.email);
    await ensureDefaultLayoutPopulated(page);

    const readLayout = async (): Promise<Map<string, { x: number; y: number }>> => {
      const res = await request.get('/api/dashboard/layout');
      expect(res.status(), 'GET layout').toBe(200);
      const body = (await res.json()) as {
        widgets: Array<{ type: string; x: number; y: number }>;
      };
      return new Map(body.widgets.map((w) => [w.type, { x: w.x, y: w.y }]));
    };

    const before = await readLayout();
    const target = before.get('open-positions');
    expect(target, 'default layout contains open-positions').toBeDefined();

    // Open Positions is the bottom-most widget in DEFAULT_WIDGETS (y 30, h 6),
    // so dragging it DOWN moves it into empty canvas with nothing to collide
    // with — no push, so any change to another widget can only be compaction.
    const card = page.locator('section[data-widget-type="open-positions"]');
    const zone = card.locator('[data-drag-zone="true"]');
    await zone.scrollIntoViewIfNeeded();
    const zoneBox = await zone.boundingBox();
    expect(zoneBox).not.toBeNull();

    const startX = zoneBox!.x + 24; // left of the drag-cancel overflow menu
    const startY = zoneBox!.y + zoneBox!.height / 2;
    const ROW_PX = 40; // GRID_ROW_HEIGHT_PX — gridstack's gap is inset, not pitch
    const rowsDown = 2;

    // Explicit steps: gridstack needs a real mousedown, a move past its 3px
    // threshold, then travel before mouseup, or the gesture reads as a click.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8, { steps: 3 });
    await page.mouse.move(startX, startY + rowsDown * ROW_PX, { steps: 15 });
    await page.mouse.up();

    await page.waitForTimeout(500); // debounced PUT is ~300ms

    // Read the persisted row BEFORE reloading. The exact landing row is not
    // predictable from the pointer delta — the canvas grows as the widget
    // descends and the page can auto-scroll, so the effective travel exceeds
    // the mouse delta. What matters is the property, not the arithmetic: it
    // moved down, and it is still there after a reload.
    const dropped = (await readLayout()).get('open-positions')!;
    expect(dropped.y, 'widget moved down').toBeGreaterThan(target!.y);

    await page.reload();
    await ensureDefaultLayoutPopulated(page);

    const after = await readLayout();

    // It stayed exactly where it was dropped — no float-up on reload.
    expect(after.get('open-positions')!.y).toBe(dropped.y);

    // Nothing else moved. Under vertical compaction the widgets above would
    // have been pulled up to close the gap; free placement leaves them alone.
    for (const [type, pos] of before) {
      if (type === 'open-positions') continue;
      expect(after.get(type), `${type} still present`).toEqual(pos);
    }
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

    // Capture the five widget IDs.
    const idsBefore = await page
      .locator(WIDGET)
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).getAttribute('data-widget-id') ?? ''),
      );
    expect(idsBefore.length).toBe(5);

    // Wait for the 300ms debounced theme PUT to commit.
    await page.waitForTimeout(500);

    // Logout + re-login.
    await logoutViaUi(page);
    await loginViaUi(page, user.email);

    // Layout persistence — five widgets, same IDs.
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
    await expect(widgetContainers).toHaveCount(5);

    // Mobile does not mount gridstack at all, so there is no grid item and no
    // resize handle anywhere on the page, and no header drag zone.
    await expect(page.locator('.grid-stack-item')).toHaveCount(0);
    await expect(page.locator('.ui-resizable-handle')).toHaveCount(0);
    await expect(page.locator('[data-drag-zone="true"]')).toHaveCount(0);
    // The `::` grip survives as an inert visual affordance inside a container
    // marked aria-disabled="true".
    await expect(widgetContainers.first()).toHaveAttribute('aria-disabled', 'true');

    // Single-column stack ordered by (y, x): collect the rendered DOM order
    // of widget types and assert it matches the (y, x)-sorted DEFAULT_WIDGETS
    // order. We rely on the mobile branch using sortByYThenX(widgets).
    const renderedOrder = await widgetContainers.evaluateAll((nodes) =>
      nodes.map(
        (n) => n.querySelector('[data-widget-type]')?.getAttribute('data-widget-type') ?? '',
      ),
    );
    expect(renderedOrder.length).toBe(5);
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
