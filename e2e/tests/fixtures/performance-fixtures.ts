import { test as base, expect, type Page } from '@playwright/test';

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
 *   - GET  /accounts                (DemoBanner → useDemoAccount → useAccounts)
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
 *
 * It FAILS CLOSED: anything under `/api/` that neither this helper nor the spec
 * answers hits the backstop registered below and fails the test by name. See
 * `failOnUnstubbedRequest`. Specs must import `test` from this module for that
 * to hold — the teardown half of the check is a fixture on it.
 *
 * One way to defeat it, worth knowing: a spec handler that calls
 * `route.continue()` for the requests it does not want. `continue()` abandons
 * the handler chain and goes to the real network, so those requests never reach
 * the backstop and fail open to a 401 and the /login bounce all over again. Use
 * `route.fallback()`, which hands the request to the next matching handler —
 * this helper's stubs, and failing those, the backstop.
 */
/**
 * The default dashboard layout a freshly-registered user receives from the
 * server — six widgets on a 12-column grid, including `account-balances` which
 * renders `CrossCurrencyTotal`. Stable ids so the grid is deterministic across
 * runs.
 *
 * Mirrors `DEFAULT_WIDGETS` (packages/shared/src/constants/dashboard-defaults.ts),
 * which is the source of truth — this package deliberately depends on no
 * product code, so the geometry is copied and has to be re-copied when that
 * file changes.
 *
 * It had already drifted: the copy below carried the pre-40px-unit values
 * (`stats-summary` at h:1, under the h:2 minimum its own type declares, and
 * six-column charts), so every spec leaning on the app shell rendered a layout
 * no user has ever been served.
 */
const DEFAULT_DASHBOARD_LAYOUT = {
  widgets: [
    { id: '00000000-0000-4000-8000-000000000001', type: 'stats-summary', x: 0, y: 0, w: 12, h: 6 },
    {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'performance-chart',
      x: 0,
      y: 6,
      w: 8,
      h: 12,
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      type: 'account-balances',
      x: 8,
      y: 6,
      w: 4,
      h: 12,
    },
    { id: '00000000-0000-4000-8000-000000000004', type: 'equity-curve', x: 0, y: 18, w: 8, h: 12 },
    {
      id: '00000000-0000-4000-8000-000000000005',
      type: 'position-sizing',
      x: 8,
      y: 18,
      w: 4,
      h: 12,
    },
    {
      id: '00000000-0000-4000-8000-000000000006',
      type: 'open-positions',
      x: 0,
      y: 30,
      w: 12,
      h: 6,
    },
  ],
  theme: 'light',
  updatedAt: null,
};

/**
 * Every unstubbed request the backstop saw, per page. Read by the `test`
 * exported below in teardown — see `failOnUnstubbedRequest`.
 */
const unstubbedRequests = new WeakMap<Page, string[]>();

/**
 * The backstop that makes the list below a CONTRACT rather than a best effort.
 *
 * Registered first, so Playwright — which matches handlers in reverse
 * registration order — reaches it only when neither `mockAppShell` nor the spec
 * answered the request. The request is never answered at all, so it cannot 401
 * and cannot trip the redirect to /login.
 *
 * That inversion is the point. Unstubbed used to mean a 401, a global redirect,
 * and a spec that quietly went on testing the login page — an assertion about
 * the PRESENCE of something still passes there, so the suite stayed green while
 * testing nothing. Four separate debugging rounds on this branch started that
 * way, each ending in one more stub; a fifth (`/api/symbols/quote-config`) was
 * masked until the login bounce was removed. Adding stubs never fixed it,
 * because the next author always reached a different endpoint. Failing closed
 * does: the cost of a missing stub is now one named error at the request that
 * needed it, paid by whoever mounts the new surface.
 *
 * The violation is reported TWICE, because one report alone is not enough:
 *
 *  1. It throws. Playwright surfaces a throw from a route handler as a test
 *     error naming the method and path, which points straight at the missing
 *     stub — but ONLY while the test is awaiting something. A request the app
 *     fires after the spec's last await (a debounce, a deferred widget fetch)
 *     throws into nothing and the test passes, silently, which is the very
 *     failure this backstop exists to end. Measured: a stray request issued
 *     50ms after the last await was dropped entirely.
 *  2. It records the violation first. The `test` exported below waits out a
 *     settle window and then asserts that record is empty, so the verdict does
 *     not depend on anything having been awaited when the throw fired. The
 *     throw names the request the moment it happens; the recorded list is what
 *     survives if nothing was listening.
 */
async function failOnUnstubbedRequest(page: Page): Promise<void> {
  const seen: string[] = [];
  unstubbedRequests.set(page, seen);

  await page.route('**/api/**', (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    const violation = `${request.method()} ${pathname}${search}`;
    // Record BEFORE throwing: the throw may go nowhere, this cannot.
    seen.push(violation);
    throw new Error(
      `mockAppShell: unstubbed request ${violation}\n` +
        `Nothing answers it, so this test would otherwise have taken a 401 and been ` +
        `redirected to /login mid-run.\n` +
        `Fix: if the authenticated shell mounts this everywhere, add a stub to ` +
        `mockAppShell (e2e/tests/fixtures/performance-fixtures.ts). If it belongs to the ` +
        `route under test, register it in the spec AFTER the mockAppShell call.`,
    );
  });
}

/**
 * How long teardown lets the page keep talking before it reads the record.
 *
 * Teardown starts ~3ms after the test body's last await returns (measured), and
 * the app does not stop asking for things when the spec stops looking: the
 * dashboard grid re-persists its layout on a 300ms debounce, and a widget's
 * fetch can leave well after the assertion that mounted it passed. Without a
 * window, a stray request 50ms late was missed entirely — the test ended before
 * the browser had issued it, so there was nothing to record and nothing to
 * throw into either.
 *
 * 500ms clears the longest deferral the app shell has (the 300ms debounce) with
 * margin, paid once per test that installs the shell. It is a bound, not a
 * proof: a request the app defers longer than this is still beyond what a
 * per-test teardown can see. Widen it if a shell surface starts asking later.
 */
const UNSTUBBED_SETTLE_MS = 500;

/**
 * `test` for every spec that uses `mockAppShell` — plain Playwright `test` plus
 * an automatic teardown check that no request reached the backstop.
 *
 * It is a fixture rather than an `afterEach` each spec has to remember, because
 * remembering is exactly what fails: the whole point of the backstop is that
 * the NEXT author, mounting a surface nobody has thought of yet, gets told. A
 * check they have to opt into is one they can leave out.
 *
 * Specs import `test` from here and keep importing `expect` from
 * `@playwright/test`.
 */
export const test = base.extend<{ appShellContract: void }>({
  appShellContract: [
    async ({ page }, use) => {
      await use();

      // No record means the spec never installed the shell, so there is no
      // contract to check and no settle to pay for.
      const seen = unstubbedRequests.get(page);
      if (!seen) return;

      if (!page.isClosed()) await page.waitForTimeout(UNSTUBBED_SETTLE_MS);

      expect(
        seen,
        'mockAppShell: the app made requests nothing stubbed. Each one would have ' +
          '401d and bounced the spec to /login. Add a stub to mockAppShell ' +
          '(e2e/tests/fixtures/performance-fixtures.ts) if the authenticated shell ' +
          'mounts it everywhere, or register it in the spec AFTER the mockAppShell call.',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export async function mockAppShell(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // FIRST, so it is reached LAST — see the doc comment above.
  await failOnUnstubbedRequest(page);

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
  // Mounted by the settings Profile tab and by CalculatorForm (which the
  // dashboard's position-sizing widget embeds), so it is app-shell surface.
  //
  // Leaving it unmocked does NOT merely skip a fetch: the request falls through
  // to the real API, which does not recognise the mocked session, and the api
  // client's global 401 handler navigates the whole app to /login. The symptom
  // is an unrelated assertion failing on a page that silently became the login
  // (or previous) route.
  await page.route('**/api/users/me/buying-power-basis', (route) =>
    route.fulfill(json({ basis: 'cash' })),
  );
  // Read by the same CalculatorForm as the basis above, so it is app-shell
  // surface for the same reason and fails the same way unmocked — the
  // /login redirect, landing on whichever assertion runs next.
  //
  // `false` is the neutral answer, and it matches the shape of the real route
  // (symbols.handler.ts `quoteConfigHandler`): the platform quote provider is
  // unconfigured, so the pull-last-price affordance never paints and no spec
  // sees a control it was not written for.
  await page.route('**/api/symbols/quote-config', (route) =>
    route.fulfill(json({ stockQuoteConfigured: false })),
  );
  // The reporting timezone is read on every authenticated view — the auth
  // layout, the sidebar, and each P&L-bucketing surface — so it is app-shell
  // surface too, and unmocked it fails the same way the note above describes.
  //
  // `stored: true` is what keeps this a single GET: it tells the client the
  // user already has a zone on their row, so the one-time backfill does not
  // fire a PUT that would 401 against the mocked session.
  await page.route('**/api/users/me/timezone', (route) =>
    route.fulfill(json({ timezone: 'UTC', stored: true })),
  );
  // Quick Stats tab fetches /performance; the route-under-test mock (registered
  // later by the performance specs) overrides this benign empty default.
  await page.route(/\/api\/performance(\?.*)?$/, (route) =>
    route.fulfill(json(NO_ACCOUNTS_RESPONSE)),
  );
  // The /dashboard route reads the stored onboarding preference before it will
  // paint anything: it holds its loading skeleton until BOTH this and
  // /api/accounts have answered, and unmocked this one falls through to the real
  // API, 401s against the synthetic session and trips the global redirect to
  // /login described above.
  //
  // `done` is the honest answer for these specs' user. Their accounts, ledger
  // and P&L are seeded through the mocks, so they are an established user, not a
  // new one — the same state migration 0028 backfills for everyone who predates
  // the feature. It also keeps the zero-state gate and the activation checklist
  // out of the way entirely, so the dashboard these specs assert against is the
  // one they were written for.
  await page.route('**/api/users/me/onboarding', (route) =>
    route.fulfill(json({ status: 'done', coachMarksSeen: [] })),
  );
  // The sample-data notice is mounted in the AUTHENTICATED LAYOUT rather than on
  // the dashboard, so the accounts read behind it is now shell surface on every
  // authenticated route, not just the ones with an accounts-shaped page. The
  // list is the only thing that can answer "is any of this sample data", and the
  // banner has to be able to answer it wherever the figures are shown — so this
  // belongs here rather than being pushed back into the product.
  //
  // Empty is the neutral answer: no sample account, so the banner renders
  // nothing and no spec sees a surface it was not written for. Specs that need
  // real accounts (ledger-balances) register their own handler AFTER this one
  // and win, per the note above.
  //
  // Anchored on the collection so it does not swallow `/accounts/:id`,
  // `/accounts/demo` or `/accounts/writable`, which are separate handlers.
  await page.route(/\/api\/accounts(\?.*)?$/, (route) => route.fulfill(json([])));
  // The remaining two reads behind the DEFAULT DASHBOARD's six widgets:
  // `/dashboard/totals` for Account Balances (CrossCurrencyTotal) and
  // `/brokerages` for Open Positions (PositionList).
  //
  // They are shell surface for the same reason the rest of this list is. Any
  // spec that navigates to /dashboard mounts all six widgets whether or not it
  // is testing them.
  //
  // Neutral answers: a zero total and no brokerages, so neither widget paints a
  // surface a spec was not written for.
  await page.route('**/api/dashboard/totals', (route) =>
    route.fulfill(json({ displayCurrency: 'USD', total: '0.00' })),
  );
  await page.route(/\/api\/brokerages(\?.*)?$/, (route) => route.fulfill(json([])));
}
