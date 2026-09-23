import { expect, type Page, type TestInfo } from '@playwright/test';

import {
  DEFAULT_DASHBOARD_LAYOUT,
  mockAppShell,
  POPULATED_DASHBOARD_RESPONSE,
  SESSION_RESPONSE,
  test,
} from './fixtures/performance-fixtures';

/**
 * Every default widget fits its default height at 1440x900 on the grid path —
 * `scrollHeight - clientHeight = 0` for each widget's scroll body (Req 2.1-2.3,
 * 3.5, 4.4, 5.3).
 *
 * `dashboard-chart-height.spec.ts` measures the two chart widgets' plot height;
 * this measures the OVERFLOW of the box `WidgetCard` scrolls, which is a
 * different defect. The body is `overflow-auto`
 * (`apps/web/src/features/dashboard/components/WidgetCard.tsx:127`), so a table,
 * a balance total, or a calculator form that is one row too tall is hidden
 * behind a nested scrollbar rather than visibly overflowing — the `d-d3fa3f52`
 * criterion, which is now MEASURED against a rendered page here rather than
 * computed from constants in a jsdom test.
 *
 * Fully mocked on `mockAppShell` — no API or DB, only the web server at
 * `BASE_URL`. Chromium only: the grid path (`data-grid-mode="grid"`) is what
 * these heights are pinned to; the mobile stack is not resizable and has no
 * height to divide.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * The selector that proves a widget has painted its real content, so a clip
 * read before the query resolves cannot pass as a fit. Mirrors the `dashboard`
 * readiness selectors of `e2e/tests/docs-screenshots.spec.ts:235-242`, with two
 * adaptations that capture never needs because it only meets the seeded,
 * populated dashboard:
 *
 *  - `open-positions` is measured EMPTY (Case 1) as well as full (Case 2). Both
 *    states — and only the resolved body, never the header — carry an `<a>` (the
 *    "New position" link, or the row links and "View all N"), so the anchor is
 *    the one signal common to both. docs uses `table tbody tr`, which the empty
 *    state has not got.
 *  - `position-sizing` is off the default dashboard (docs drops its selector,
 *    Req 5.5); here it is added from a stored layout (Case 4) and its content is
 *    the calculator `<form>`.
 */
const READY_SELECTOR: Record<string, string> = {
  'stats-summary': 'dl',
  'performance-chart': '[data-testid="performance-bar-chart"]',
  'equity-curve': '[data-testid="equity-curve-chart"]',
  'account-balances': 'ul li',
  'open-positions': 'a',
  'position-sizing': 'form',
};

/** The five widgets of the default layout, measured whole in Cases 1 and 2. */
const DEFAULT_TYPES = [
  'stats-summary',
  'performance-chart',
  'equity-curve',
  'account-balances',
  'open-positions',
] as const;

/**
 * Scroll overflow of a widget's body in px: `scrollHeight - clientHeight` of the
 * section's only child `<div>`, the `overflow-auto` box every widget is wrapped
 * in. Always >= 0 (scrollHeight is never below clientHeight); a positive number
 * is content the user can only reach through a nested scrollbar. Waits on the
 * widget's readiness selector first, so the body is measured with its content in
 * place rather than mid-Suspense.
 */
async function clippedPx(page: Page, type: string): Promise<number> {
  await page
    .locator(`section[data-widget-type="${type}"] ${READY_SELECTOR[type]}`)
    .first()
    .waitFor({ state: 'attached' });
  return page
    .locator(`section[data-widget-type="${type}"] > div`)
    .evaluate((el) => el.scrollHeight - el.clientHeight);
}

/**
 * Assert a widget fits — 0 px clipped — and annotate the measurement, in the
 * pattern of `dashboard-chart-height.spec.ts`. Polls rather than reads once:
 * gridstack sizes the item on mount and the widget's query resolves after, so a
 * single read can catch the body a frame before it settles. A body that STAYS
 * clipped never reaches 0 and the poll fails with the standing overflow.
 */
async function expectFits(page: Page, type: string, testInfo: TestInfo, label = ''): Promise<void> {
  await expect
    .poll(() => clippedPx(page, type), {
      timeout: 10_000,
      message: `${type}${label} clips its scroll body — that much content is off-screen behind a nested scrollbar`,
    })
    .toBe(0);
  const clipped = await clippedPx(page, type);
  testInfo.annotations.push({
    type: 'measured',
    description: `${type}${label}: clipped ${clipped}px`,
  });
}

/** A single-currency USD account, `PositionListItem`'s sibling for the list. */
function usdAccount(i: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
    userId: '00000000-0000-0000-0000-000000000001',
    name: `Account ${i}`,
    currency: 'USD',
    timezone: 'UTC',
    brokerageId: null,
    brokerageName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    balance: '10000.00',
    // cash / positionValue split (ledger-balances Req 10): a non-zero position
    // value makes the widget render the second, denser line per account, so the
    // cap is measured against the tallest single-currency row.
    cash: '8000.00',
    positionValue: '2000.00',
  };
}

/**
 * An open position shaped like `PositionListItemSchema`
 * (`packages/shared/src/schemas/position.ts:162-201`) — every field the widget
 * and its row actions read. `updatedAt` is distinct per index so the widget's
 * "five most recent" sort is deterministic.
 */
function openPosition(i: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
    userId: '00000000-0000-0000-0000-000000000001',
    accountId: '00000000-0000-4000-8000-0000000000a1',
    symbol: `SYM${i}`,
    side: 'long',
    assetType: 'stock',
    status: 'open',
    notes: null,
    openedAt: '2026-05-01T00:00:00.000Z',
    closedAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: new Date(Date.UTC(2026, 5, 1, 0, i, 0)).toISOString(),
    accountName: 'Main',
    accountCurrency: 'USD',
    accountTimezone: 'UTC',
    realizedPnl: null,
    returnPercentage: null,
    avgEntryPrice: 100,
    avgExitPrice: null,
    totalEntryQuantity: 10,
    totalExitQuantity: 0,
    brokerageName: null,
    grossPnl: null,
    brokerageFees: 0,
    netPnl: null,
    targetPrice: null,
    stopLoss: null,
    targetRR: null,
    actualRR: null,
    openUnits: 10,
    closedUnits: 0,
    openCostBasis: 1000,
  };
}

test.describe('Dashboard widgets — default height fit', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Grid path only — the mobile stack is not resizable and has no height to divide.',
  );

  test.beforeEach(async ({ page }) => {
    await mockAppShell(page);
    // Registered after `mockAppShell`, so they win over its shell defaults.
    await page.route('**/api/auth/me', (route) => route.fulfill(json(SESSION_RESPONSE)));
    await page.route(/\/api\/performance(\?.*)?$/, (route) =>
      route.fulfill(json(POPULATED_DASHBOARD_RESPONSE)),
    );
    // The chromium project's device default is not 1440x900 (Req 2.3).
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('default layout with zero open positions and one account fits every widget', async ({
    page,
  }, testInfo) => {
    await page.route(/\/api\/accounts(\?.*)?$/, (route) => route.fulfill(json([usdAccount(1)])));
    // The shell default already answers `/api/positions` with `[]`; naming it
    // here states the case rather than leaning on that.
    await page.route(/\/api\/positions(\?.*)?$/, (route) => route.fulfill(json([])));

    await page.goto('/dashboard');
    await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();

    // The empty Open Positions keeps its "New position" link (Req 3.3).
    await expect(
      page.locator('section[data-widget-type="open-positions"]').getByRole('link', {
        name: 'New position',
      }),
    ).toBeVisible();

    for (const type of DEFAULT_TYPES) {
      await expectFits(page, type, testInfo);
    }
  });

  test('default layout with fifty open positions fits every widget and summarises', async ({
    page,
  }, testInfo) => {
    await page.route(/\/api\/accounts(\?.*)?$/, (route) => route.fulfill(json([usdAccount(1)])));
    const positions = Array.from({ length: 50 }, (_, i) => openPosition(i + 1));
    await page.route(/\/api\/positions(\?.*)?$/, (route) => route.fulfill(json(positions)));

    await page.goto('/dashboard');
    await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();

    // At most five rows, and the count spills into the link (Req 3.5).
    await expect(
      page.locator('section[data-widget-type="open-positions"] table tbody tr'),
    ).toHaveCount(5);
    await expect(
      page.locator('section[data-widget-type="open-positions"]').getByRole('link', {
        name: 'View all 50 open positions',
      }),
    ).toBeVisible();

    for (const type of DEFAULT_TYPES) {
      await expectFits(page, type, testInfo);
    }
  });

  test('account balances with seven accounts fits, capped, with total and link', async ({
    page,
  }, testInfo) => {
    const accounts = Array.from({ length: 7 }, (_, i) => usdAccount(i + 1));
    await page.route(/\/api\/accounts(\?.*)?$/, (route) => route.fulfill(json(accounts)));
    // A missing pair drives the banner (Req 4 keeps it unchanged); the widget
    // still has to fit the cap, the banner, the total and the link at 0 px.
    await page.route('**/api/dashboard/totals', (route) =>
      route.fulfill(
        json({
          displayCurrency: 'USD',
          total: '70000.00',
          missingPairs: [{ baseCurrency: 'EUR', quoteCurrency: 'USD' }],
        }),
      ),
    );

    await page.goto('/dashboard');
    await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();

    // Four rows shown (the cap), the total, and the count in the link (Req 4.4).
    await expect(page.locator('section[data-widget-type="account-balances"] ul li')).toHaveCount(4);
    await expect(
      page.locator('section[data-widget-type="account-balances"]').getByText('Total'),
    ).toBeVisible();
    await expect(
      page.locator('section[data-widget-type="account-balances"]').getByRole('link', {
        name: 'View all 7 accounts',
      }),
    ).toBeVisible();

    await expectFits(page, 'account-balances', testInfo);
  });

  test('position sizing fits its whole form at the picker default and its minimum width', async ({
    page,
  }, testInfo) => {
    // The default five widgets end at row 30; Position Sizing sits below them.
    // A mutable layout so the reload serves the narrower placement.
    let layout: unknown = layoutWithPositionSizing(4);
    await page.route('**/api/dashboard/layout', (route) => route.fulfill(json(layout)));

    await page.goto('/dashboard');
    await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();
    await expect(page.locator('section[data-widget-type="position-sizing"] form')).toBeAttached();
    await expectFits(page, 'position-sizing', testInfo, ' at w=4');

    // The narrowest the form is allowed (min w=3): still two columns at a 1440px
    // viewport (`md:grid-cols-2` is a viewport breakpoint, not a widget one).
    layout = layoutWithPositionSizing(3);
    await page.reload();
    await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();
    await expect(page.locator('section[data-widget-type="position-sizing"] form')).toBeAttached();
    await expectFits(page, 'position-sizing', testInfo, ' at w=3');
  });
});

/**
 * The five-widget default plus a Position Sizing widget below it at width `w`,
 * 24 rows tall — the fitted height `PerWidgetMinSize['position-sizing'].h` now
 * pins. `y=30` clears the default widgets (they end there), so no reconcile
 * moves it.
 */
function layoutWithPositionSizing(w: number) {
  return {
    ...DEFAULT_DASHBOARD_LAYOUT,
    widgets: [
      ...DEFAULT_DASHBOARD_LAYOUT.widgets,
      {
        id: '00000000-0000-4000-8000-000000000005',
        type: 'position-sizing',
        x: 0,
        y: 30,
        w,
        h: 24,
      },
    ],
  };
}
