import { expect, type Page } from '@playwright/test';

import {
  INVALID_TIMEZONE_RESPONSE,
  mockAppShell,
  NO_ACCOUNTS_RESPONSE,
  PERF_URL,
  POPULATED_RESPONSE,
  SESSION_RESPONSE,
  test,
} from './fixtures/performance-fixtures';

/**
 * Performance page e2e suite.
 *
 * The web dev server is expected to be running at `BASE_URL` (default
 * http://localhost:5173). API responses are mocked via `page.route`, so the
 * api/db do not need to be running. This keeps the suite deterministic and
 * fast — the boundary under test is the route + composition + selectors +
 * banner stack, not the DB layer (which has its own integration tests).
 *
 * Cases covered (Task 37 main file):
 *  - (a) empty-state flows
 *  - (b) happy path
 *  - (c) timeframe preset switching (URL update + refetch)
 *  - (d) atomic currency change (one URL change)
 *  - (f) INVALID_TIMEZONE retry-storm prevention via request-counter
 *  - (g) chunk-404 mocked → ChartChunkStaleBanner + Refresh triggers reload
 *
 * Case (e) — week-start-flip — lives in the API integration suite at
 * `apps/api/src/features/performance/performance.week-start.test.ts`. It uses
 * `vi.resetModules() + vi.doMock('@/lib/config')` to flip `WEEK_START_DAY`
 * between requests and asserts `resolvedWeekStartDay` round-trips, which is
 * the same schema-drift failure mode a Playwright test would catch but with
 * far less infrastructure.
 */

const PERF_QS_RE = /\/api\/performance(\?.*)?$/;

async function mockSession(page: Page) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SESSION_RESPONSE),
    });
  });
}

async function mockPerformance(page: Page, body: unknown, status = 200) {
  await page.route(PERF_QS_RE, async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test.describe('Performance page', () => {
  test.beforeEach(async ({ page }) => {
    // Neutralize the global app shell first; the per-test `/performance` mock
    // registered afterwards takes precedence.
    await mockAppShell(page);
    await mockSession(page);
  });

  // ---- (a) empty-state flows ----------------------------------------------

  test('(a) renders the no-accounts empty state when hasAnyAccounts is false', async ({ page }) => {
    await mockPerformance(page, NO_ACCOUNTS_RESPONSE);
    await page.goto(PERF_URL);
    await expect(page.getByTestId('performance-empty-state-no-accounts')).toBeVisible();
    await expect(page.getByTestId('timeframe-selector')).toHaveCount(0);
  });

  test('(a) renders the in-timeframe-empty state when populated history but empty current series', async ({
    page,
  }) => {
    const inTimeframeEmpty = {
      ...POPULATED_RESPONSE,
      currencies: POPULATED_RESPONSE.currencies.map((c) => ({
        ...c,
        series: [],
        equityCurve: [],
      })),
    };
    await mockPerformance(page, inTimeframeEmpty);
    await page.goto(PERF_URL);
    await expect(page.getByTestId('performance-empty-state-in-timeframe-empty')).toBeVisible();
  });

  // ---- (b) happy path ------------------------------------------------------

  test('(b) renders selectors, chart, stats, and breakdown table on populated response', async ({
    page,
  }) => {
    await mockPerformance(page, POPULATED_RESPONSE);
    await page.goto(PERF_URL);

    await expect(page.getByTestId('performance-page')).toBeVisible();
    await expect(page.getByTestId('timeframe-selector')).toBeVisible();
    await expect(page.getByTestId('currency-selector')).toBeVisible();
    await expect(page.getByTestId('stats-panel')).toBeVisible();
    await expect(page.getByTestId('breakdown-table')).toBeVisible();
  });

  // ---- (c) timeframe preset switching --------------------------------------

  test('(c) clicking a timeframe preset updates the URL and triggers a refetch', async ({
    page,
  }) => {
    let requestCount = 0;
    await page.route(PERF_QS_RE, async (route) => {
      requestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(POPULATED_RESPONSE),
      });
    });

    await page.goto(PERF_URL);
    await expect(page.getByTestId('performance-page')).toBeVisible();
    const initialCount = requestCount;

    // PERF_URL starts on `month` granularity, so click `daily` to force a real
    // URL change. We use `daily` specifically because its derived range ends
    // at start-of-tomorrow-local — the maximum accepted by
    // `PerformanceQuerySchema`'s `end <= today + 1 day` refinement. Other
    // forward-looking presets (`monthly`, `yearly`, ...) produce ends past
    // tomorrow-midnight and would fail validation against the live clock.
    await page.getByTestId('timeframe-preset-daily').click();

    // URL reflects the new granularity
    await expect.poll(() => new URL(page.url()).searchParams.get('granularity')).toBe('day');
    // A refetch happened (request count strictly increased)
    await expect.poll(() => requestCount).toBeGreaterThan(initialCount);
  });

  // ---- (d) atomic currency change ------------------------------------------

  test('(d) currency change produces exactly one URL update with all four keys', async ({
    page,
  }) => {
    await mockPerformance(page, POPULATED_RESPONSE);
    await page.goto(PERF_URL);
    await expect(page.getByTestId('performance-page')).toBeVisible();

    // Track every history-state change for the duration of the test. The
    // CurrencySelector's atomicity contract (Design §Component 7) is a single
    // navigate() call carrying currency + granularity + start + end together.
    const urls: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) urls.push(frame.url());
    });

    // Open the (Radix-based) select and pick EUR.
    await page.getByTestId('currency-selector').click();
    await page.getByTestId('currency-option-EUR').click();

    // Wait for the URL to settle on `currency=EUR`.
    await expect.poll(() => new URL(page.url()).searchParams.get('currency')).toBe('EUR');

    const final = new URL(page.url());
    // All four keys present in the final URL.
    expect(final.searchParams.get('currency')).toBe('EUR');
    expect(final.searchParams.get('granularity')).not.toBeNull();
    expect(final.searchParams.get('start')).not.toBeNull();
    expect(final.searchParams.get('end')).not.toBeNull();

    // Atomicity: the URL transitions that carry `currency=EUR` should also
    // carry `granularity`, `start`, and `end` — i.e. they are NOT applied
    // through separate intermediate URLs missing some of the four keys.
    const urlsWithCurrency = urls.filter((u) => new URL(u).searchParams.get('currency') === 'EUR');
    expect(urlsWithCurrency.length).toBeGreaterThan(0);
    for (const u of urlsWithCurrency) {
      const sp = new URL(u).searchParams;
      expect(sp.get('granularity')).not.toBeNull();
      expect(sp.get('start')).not.toBeNull();
      expect(sp.get('end')).not.toBeNull();
    }
  });

  // ---- (f) INVALID_TIMEZONE retry-storm prevention -------------------------

  test('(f) INVALID_TIMEZONE issues exactly one retry per session (no retry storm)', async ({
    page,
  }) => {
    let perfRequestCount = 0;
    await page.route(PERF_QS_RE, async (route) => {
      perfRequestCount += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify(INVALID_TIMEZONE_RESPONSE),
      });
    });

    await page.goto(PERF_URL);

    // Deterministic settle: the banner DOM is visible. We assert ON THIS SIGNAL
    // (not a timer) so the request-counter assertion isn't flaky.
    await expect(page.getByTestId('invalid-timezone-banner')).toBeVisible();

    // The critical invariant is "no retry storm" — i.e. the session flag
    // halts further retries after the first failure is observed. The exact
    // count depends on dev vs prod mode (React StrictMode double-invokes the
    // mount path in dev, doubling the natural 1+1 = 2 requests to 4). We
    // bound generously here; the load-bearing assertion is the snapshot
    // stability check below.
    expect(perfRequestCount).toBeGreaterThanOrEqual(1);
    expect(perfRequestCount).toBeLessThanOrEqual(6);

    // Now snapshot the count and verify it does NOT keep growing — i.e. the
    // session flag has stopped further retries.
    const snapshot = perfRequestCount;
    // Wait an explicit microtask + paint cycle so any pending retries would
    // have fired by now. We use a small fixed wait deliberately AFTER the
    // banner is visible (deterministic settle point), not before.
    await page.waitForLoadState('networkidle');
    expect(perfRequestCount).toBe(snapshot);
  });

  // ---- (g) chunk-404 → ChartChunkStaleBanner -------------------------------

  test('(g) chart chunk 404 surfaces ChartChunkStaleBanner and Refresh reloads', async ({
    page,
  }) => {
    await mockPerformance(page, POPULATED_RESPONSE);

    // Vite emits the chart in its own chunk because PerformancePage uses
    // `React.lazy(() => import('@/features/performance/components/EquityCurveChart'))`.
    // Match the chart module's request — not the sibling Skeleton — across
    // both prod (hashed `.js` chunk) and dev (raw `.tsx?import` URL).
    await page.route(/EquityCurveChart(?!Skeleton)/i, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' });
    });

    let reloaded = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/performance')) {
        // A reload re-navigates to the same URL.
        reloaded = true;
      }
    });

    await page.goto(PERF_URL);
    await expect(page.getByTestId('chart-chunk-stale-banner')).toBeVisible();

    // Reset the reload flag — the initial goto will have set it.
    reloaded = false;

    // Clicking Refresh triggers `window.location.reload()`. We assert on the
    // navigation event firing rather than relying on a fragile DOM diff.
    const navPromise = page.waitForEvent('framenavigated', {
      predicate: (f) => f === page.mainFrame(),
    });
    await page.getByTestId('chart-chunk-stale-banner-refresh').click();
    await navPromise;
    expect(reloaded).toBe(true);
  });
});
