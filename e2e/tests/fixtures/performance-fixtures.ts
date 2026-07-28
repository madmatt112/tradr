import type { Page } from '@playwright/test';

/**
 * Static performance API fixtures used by the e2e specs. Kept in one place so
 * the empty-state, populated, and INVALID_TIMEZONE responses are consistent
 * across test files.
 *
 * Field names mirror the canonical Zod schemas in
 * `packages/shared/src/schemas/performance.ts` — keep these in sync.
 */

/**
 * Default search params for the `/performance` route. The route validates
 * `granularity / start / end` (and accepts optional `tz`) via
 * `PerformanceQuerySchema`, so a bare `page.goto('/performance')` triggers a
 * `SearchParamError` and the root error boundary renders. Tests should
 * navigate to `PERF_URL` instead.
 *
 * `end` is set well before the current date so the schema's
 * "end <= today + 1 day" refinement passes regardless of when the suite
 * runs (kept conservative; bump if the suite ages out).
 */
const DEFAULT_PARAMS = new URLSearchParams({
  granularity: 'month',
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-05-01T00:00:00.000Z',
  tz: 'UTC',
}).toString();
export const PERF_URL = `/performance?${DEFAULT_PARAMS}`;

export const POPULATED_RESPONSE = {
  resolvedTimezone: 'UTC',
  resolvedWeekStartDay: 0 as const,
  dataQuality: {
    timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
    historyExcluded: { total: 0, closed_at_null: 0 },
  },
  hasAnyAccounts: true,
  hasAnyClosedPositions: true,
  hasAnyClosedPositionsInSupportedCurrency: true,
  defaultCurrency: 'USD',
  currencies: [
    {
      code: 'USD',
      historyRange: {
        earliestClosedAt: '2025-01-01T00:00:00.000Z',
        mostRecentClosedAt: '2026-05-01T00:00:00.000Z',
        totalClosedPositions: 12,
      },
      series: [
        {
          bucketStart: '2026-04-01T00:00:00.000Z',
          netPnl: '120.00',
          grossPnl: '150.00',
          fees: '30.00',
          totalPositions: 4,
          wins: 3,
          losses: 1,
          breakevens: 0,
        },
      ],
      equityCurve: [{ bucketStart: '2026-04-01T00:00:00.000Z', cumulativeNetPnl: '120.00' }],
      stats: {
        totalPositions: 4,
        totalNetPnl: '120.00',
        winRate: 75.0,
        breakevenRate: 0.0,
        avgWin: '60.00',
        avgLoss: '-30.00',
        profitFactor: 4.0,
        largestWin: '80.00',
        largestLoss: '-30.00',
        hasWins: true,
        hasLosses: true,
      },
    },
    {
      code: 'EUR',
      historyRange: {
        earliestClosedAt: '2025-06-01T00:00:00.000Z',
        mostRecentClosedAt: '2026-04-15T00:00:00.000Z',
        totalClosedPositions: 4,
      },
      series: [
        {
          bucketStart: '2026-04-01T00:00:00.000Z',
          netPnl: '50.00',
          grossPnl: '60.00',
          fees: '10.00',
          totalPositions: 2,
          wins: 2,
          losses: 0,
          breakevens: 0,
        },
      ],
      equityCurve: [{ bucketStart: '2026-04-01T00:00:00.000Z', cumulativeNetPnl: '50.00' }],
      stats: {
        totalPositions: 2,
        totalNetPnl: '50.00',
        winRate: 100.0,
        breakevenRate: 0.0,
        avgWin: '25.00',
        avgLoss: null,
        profitFactor: null,
        largestWin: '30.00',
        largestLoss: null,
        hasWins: true,
        hasLosses: false,
      },
    },
  ],
};

export const NO_ACCOUNTS_RESPONSE = {
  resolvedTimezone: 'UTC',
  resolvedWeekStartDay: 0 as const,
  dataQuality: {
    timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
    historyExcluded: { total: 0, closed_at_null: 0 },
  },
  hasAnyAccounts: false,
  hasAnyClosedPositions: false,
  hasAnyClosedPositionsInSupportedCurrency: false,
  defaultCurrency: null,
  currencies: [],
};

export const INVALID_TIMEZONE_RESPONSE = {
  error: {
    code: 'INVALID_TIMEZONE',
    message: 'Timezone is not recognized.',
  },
};

/**
 * Minimal session-bootstrap response so the auth layout renders.
 *
 * Mirrors `apps/api/src/features/auth/auth.route.ts` `/auth/me` which returns
 * `{ id, email, isAdmin }` at the TOP LEVEL (not wrapped in `{ user }`). The
 * web `useAuth` hook does `api.get<User>('/auth/me')` and reads fields
 * directly from the response.
 */
export const SESSION_RESPONSE = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'e2e@example.com',
  isAdmin: false,
};

/**
 * Neutralize the global authenticated app shell so a route-under-test renders
 * in isolation.
 *
 * The `_auth` layout mounts the Sidebar, the always-on SideDrawer (all tabs
 * mount regardless of open state), and the theme-sync hook on EVERY
 * authenticated route. Together they eagerly fetch a set of endpoints that have
 * nothing to do with the route under test:
 *
 *   - GET  /dashboard/layout        (Sidebar ThemeToggle → useAppTheme → useDashboardLayout)
 *   - GET  /dashboard/theme         (useAppTheme boot reconciliation)
 *   - POST /dashboard/theme-cookie  (useAppTheme boot reconciliation)
 *   - GET  /changelog/releases      (Sidebar new-updates badge)
 *   - GET  /positions[?status=open] (SideDrawer Open Positions / Recently Created tabs)
 *   - GET  /performance?…           (SideDrawer Quick Stats tab → usePerformance)
 *   - GET  /users/me/display-currency (SideDrawer Quick Stats tab)
 *
 * The fully-mocked specs (performance, ledger-balances) provide a synthetic
 * `/auth/me` session but do NOT serve these shell endpoints, so they fall
 * through to the real API, which answers 401 for the mock-only session. A
 * single 401 trips the api client's global redirect to `/login`
 * (apps/web/src/lib/api.ts), unmounting the page mid-test.
 *
 * Register this FIRST in `beforeEach`; any per-test mock registered afterwards
 * takes precedence (Playwright matches routes in reverse registration order),
 * so a spec is free to override `/performance` (the boundary under test) or
 * `/users/me/display-currency` (ledger-balances) with its own handler.
 */
/**
 * The default dashboard layout a freshly-registered user receives from the
 * server. Mirrors `DEFAULT_WIDGETS` (packages/shared/constants/dashboard-defaults.ts)
 * — six widgets on a 12-column grid, including `account-balances` which renders
 * `CrossCurrencyTotal`. Stable ids so the grid is deterministic across runs.
 */
const DEFAULT_DASHBOARD_LAYOUT = {
  widgets: [
    { id: '00000000-0000-4000-8000-000000000001', type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 },
    {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'performance-chart',
      x: 0,
      y: 1,
      w: 6,
      h: 2,
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      type: 'account-balances',
      x: 6,
      y: 1,
      w: 6,
      h: 2,
    },
    { id: '00000000-0000-4000-8000-000000000004', type: 'equity-curve', x: 0, y: 3, w: 6, h: 2 },
    { id: '00000000-0000-4000-8000-000000000005', type: 'position-sizing', x: 6, y: 3, w: 6, h: 3 },
    { id: '00000000-0000-4000-8000-000000000006', type: 'open-positions', x: 0, y: 6, w: 12, h: 2 },
  ],
  theme: 'light',
  updatedAt: null,
};

export async function mockAppShell(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/dashboard/layout', (route) =>
    route.fulfill(json(DEFAULT_DASHBOARD_LAYOUT)),
  );
  await page.route('**/api/dashboard/theme-cookie', (route) => route.fulfill(json({})));
  await page.route('**/api/dashboard/theme', (route) => route.fulfill(json({ theme: 'light' })));
  await page.route('**/api/changelog/releases', (route) =>
    route.fulfill(json({ releases: [], lastViewedAt: '1970-01-01T00:00:00.000Z' })),
  );
  await page.route(/\/api\/positions(\?.*)?$/, (route) => route.fulfill(json([])));
  await page.route('**/api/users/me/display-currency', (route) =>
    route.fulfill(json({ currency: 'USD' })),
  );
  // Quick Stats tab fetches /performance; the route-under-test mock (registered
  // later by the performance specs) overrides this benign empty default.
  await page.route(/\/api\/performance(\?.*)?$/, (route) =>
    route.fulfill(json(NO_ACCOUNTS_RESPONSE)),
  );
}
