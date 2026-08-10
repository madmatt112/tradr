import { expect, test, type Page } from '@playwright/test';

import { mockAppShell, SESSION_RESPONSE } from './fixtures/performance-fixtures';

/**
 * Rendered height of the two dashboard chart widgets, on BOTH grid paths.
 *
 * This file exists because every other test of this behaviour is blind to it.
 * `ChartWidget.height.test.tsx` does arithmetic over measured constants, the
 * rest of the dashboard suite asserts elements are PRESENT, and jsdom performs
 * no layout at all — so a chart can be clipped in half, or collapsed to
 * literally zero pixels, and the whole suite stays green. That has now shipped
 * twice: first `h-[320px]` inside a 149px body (215px and 171px cut off), then
 * the container-sized replacement, which resolves to 0px in the mobile stack
 * where nothing above it has a determinate height.
 *
 * So this measures. `clientHeight` of the chart box and the overflow of the
 * widget's scroll body are the two numbers that describe both defects:
 *
 *   - collapse  → chart box near 0 while the widget is a header-height strip
 *   - clipping  → the scroll body's content is taller than the body
 *
 * It runs unmodified under BOTH the `chromium` and `Mobile Chrome` projects,
 * which is the point: the two paths render different components
 * (`DashboardGridCanvas` vs the stacked fallback) and must agree on this.
 *
 * Fully mocked — no API or DB. Needs only the web server at `BASE_URL`.
 */

/**
 * The floor a chart is held to, in px. Mirrors `CHART_MIN_HEIGHT_PX`
 * (apps/web/src/features/performance/chart.constants.ts) and the `MIN_CHART_PX`
 * in `apps/web/src/features/dashboard/widgets/ChartWidget.height.test.tsx`.
 * This package deliberately imports no product code, so it is copied.
 *
 * Below it the y-axis falls to three ticks and the signed data labels start
 * colliding with the date ticks. On the grid the charts are well clear of it
 * (345px and 389px at the pinned default); in the stacked fallback, where the
 * card has no height to divide, it IS the height.
 */
const MIN_CHART_PX = 240;

/** One populated USD currency — enough for both charts to have a series. */
const POPULATED_DASHBOARD_RESPONSE = {
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
        earliestClosedAt: '2026-01-01T00:00:00.000Z',
        mostRecentClosedAt: '2026-06-01T00:00:00.000Z',
        totalClosedPositions: 12,
      },
      series: [
        {
          bucketStart: '2026-04-01T00:00:00.000Z',
          netPnl: '1180.25',
          grossPnl: '1210.25',
          fees: '30.00',
          totalPositions: 4,
          wins: 3,
          losses: 1,
          breakevens: 0,
        },
        {
          bucketStart: '2026-05-01T00:00:00.000Z',
          netPnl: '-420.50',
          grossPnl: '-400.50',
          fees: '20.00',
          totalPositions: 3,
          wins: 1,
          losses: 2,
          breakevens: 0,
        },
      ],
      equityCurve: [
        { bucketStart: '2026-04-01T00:00:00.000Z', cumulativeNetPnl: '1180.25' },
        { bucketStart: '2026-05-01T00:00:00.000Z', cumulativeNetPnl: '759.75' },
      ],
      stats: {
        totalPositions: 7,
        totalNetPnl: '759.75',
        winRate: 57.14,
        breakevenRate: 0,
        avgWin: '393.42',
        avgLoss: '-210.25',
        profitFactor: 2.8,
        largestWin: '600.00',
        largestLoss: '-300.00',
        hasWins: true,
        hasLosses: true,
      },
    },
  ],
};

interface ChartMetrics {
  /** `clientHeight` of the chart's outer box. */
  chartPx: number;
  /**
   * Rendered height of the recharts `<svg>` — the plot the user actually sees.
   *
   * Measured SEPARATELY from the box, and not as a formality. Recharts sizes
   * its surface from what `ResponsiveContainer` observes, which is not always
   * the box: an intermediate version of this fix gave the box a 240px floor and
   * left the svg at 0, because a percentage height does not resolve against a
   * parent whose height came from `min-height`. The box looked right and the
   * widget was still blank.
   */
  plotPx: number;
  /** `clientHeight` of the whole widget card. */
  cardPx: number;
  /**
   * How much of the widget body's content does not fit in it, in px. The body
   * is `overflow-auto`, so a positive number is content the user cannot see
   * without discovering a nested scroller.
   */
  clippedPx: number;
}

/**
 * Measure a chart widget in the live layout.
 *
 * Walks up from the chart to the nearest scrolling ancestor inside the card
 * rather than matching a class name, so it keeps working if WidgetCard's
 * utility classes are rewritten.
 */
async function measure(page: Page, type: string, chartTestId: string): Promise<ChartMetrics> {
  const chart = page.locator(`section[data-widget-type="${type}"] [data-testid="${chartTestId}"]`);
  await expect(chart, `${type} renders its chart`).toBeAttached();
  // Recharts paints after its ResizeObserver reports, which is a frame or two
  // behind the element existing — so wait for the surface rather than sleeping.
  // Deliberately non-fatal: a collapsed chart never draws one at all, and that
  // is a finding for the assertions below to report with numbers, not a bare
  // "waiting for locator" timeout that says nothing about what went wrong.
  await chart
    .locator('svg.recharts-surface')
    .waitFor({ state: 'attached', timeout: 5_000 })
    .catch(() => undefined);
  return chart.evaluate((el) => {
    const card = el.closest('section[data-widget-type]');
    let scroller: HTMLElement | null = null;
    for (let node = el.parentElement; node && node !== card; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scroller = node;
        break;
      }
    }
    const svg = el.querySelector('svg.recharts-surface');
    return {
      chartPx: el.clientHeight,
      plotPx: svg ? Math.round(svg.getBoundingClientRect().height) : 0,
      cardPx: card ? card.clientHeight : 0,
      clippedPx: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0,
    };
  });
}

test.describe('Dashboard chart widgets — rendered height', () => {
  test.beforeEach(async ({ page }) => {
    await mockAppShell(page);
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SESSION_RESPONSE),
      }),
    );
    // Registered after `mockAppShell`, so it wins: the shell's default is the
    // no-accounts response, which renders no chart at all.
    await page.route(/\/api\/performance(\?.*)?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(POPULATED_DASHBOARD_RESPONSE),
      }),
    );
  });

  test('both charts are drawn at a legible height and nothing is cut off', async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.goto('/dashboard');

    // Both grid paths stamp `data-grid-mode`; assert which one is under test so
    // a failure names the path rather than leaving it to be inferred.
    await expect(page.locator(`[data-grid-mode="${isMobile ? 'mobile' : 'grid'}"]`)).toBeVisible();

    const cases = [
      { type: 'performance-chart', testId: 'performance-bar-chart' },
      { type: 'equity-curve', testId: 'equity-curve-chart' },
    ] as const;

    for (const { type, testId } of cases) {
      const { chartPx, plotPx, cardPx, clippedPx } = await measure(page, type, testId);
      testInfo.annotations.push({
        type: 'measured',
        description: `${type}: plot ${plotPx}px in a ${chartPx}px box, card ${cardPx}px, clipped ${clippedPx}px`,
      });

      // The collapse. A chart sized to its container renders at 0px whenever
      // nothing above it has a determinate height — which is exactly the
      // stacked fallback, where the card is content-sized. A zero-height
      // ResponsiveContainer draws nothing at all: the widget is an empty strip.
      expect(
        chartPx,
        `${type}'s chart box is ${chartPx}px inside a ${cardPx}px card — under ` +
          `the ${MIN_CHART_PX}px floor. A container-sized chart needs either a ` +
          `determinate parent or a floor of its own`,
      ).toBeGreaterThanOrEqual(MIN_CHART_PX);

      // …and the plot has to be drawn at that size, not merely have room for it.
      // These are two different failures: recharts measures its own container,
      // so a box the right size with a min-height-derived height still yields a
      // 0px surface.
      expect(
        plotPx,
        `${type} draws a ${plotPx}px plot inside a ${chartPx}px box. The box is ` +
          `not the chart — ResponsiveContainer has to be able to MEASURE a ` +
          `height, and a percentage against an auto parent is not one`,
      ).toBeGreaterThanOrEqual(MIN_CHART_PX);

      // The clipping. The widget body scrolls, so content taller than it is
      // hidden rather than visibly overflowing — which is how a hard-coded
      // 320px chart in a 149px body went unnoticed.
      expect(
        clippedPx,
        `${type} overflows its widget body by ${clippedPx}px, so that much of ` +
          `the chart is off-screen unless the user finds the nested scroller`,
      ).toBe(0);

      // The chart cannot be taller than the card that holds it.
      expect(chartPx).toBeLessThanOrEqual(cardPx);
    }
  });

  test('on the grid the charts take the whole height the widget gives them', async ({
    page,
    isMobile,
  }, testInfo) => {
    test.skip(isMobile, 'Grid-only — the stacked fallback has no height to divide.');

    await page.goto('/dashboard');
    await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();

    for (const { type, testId } of [
      { type: 'performance-chart', testId: 'performance-bar-chart' },
      { type: 'equity-curve', testId: 'equity-curve-chart' },
    ] as const) {
      const { chartPx, plotPx, cardPx } = await measure(page, type, testId);
      testInfo.annotations.push({
        type: 'measured',
        description: `${type}: plot ${plotPx}px of a ${cardPx}px card`,
      });

      // Strictly above the floor, not sitting on it: on the grid the widget has
      // a real height and the chart is supposed to consume what the toolbar and
      // the notice leave. Pinning a fixed height instead — the original defect —
      // lands the chart exactly on some constant regardless of the card.
      expect(
        plotPx,
        `${type} draws ${plotPx}px in a ${cardPx}px card. On the grid the chart ` +
          `takes the leftover height; landing on the ${MIN_CHART_PX}px floor ` +
          `means it stopped sizing to its container`,
      ).toBeGreaterThan(MIN_CHART_PX);
      // Fills the box, within a pixel. NOT `toBe(chartPx)`: the box is measured
      // with `clientHeight` (an integer) and the svg off a bounding rect (a
      // float), so a fractional layout height rounds the two apart for reasons
      // that have nothing to do with this behaviour. A whole pixel of slack
      // still catches every real failure — the ones that matter are 0px, or the
      // 40-200px of a chart that stopped sizing to its container.
      expect(
        Math.abs(plotPx - chartPx),
        `${type} draws ${plotPx}px inside a ${chartPx}px box — the plot should ` +
          `fill the box it was given`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The same measurement across the RANGE of heights a user can resize to.
 *
 * The floor that stopped the mobile collapse bought it with an overflow: a chart
 * that will not shrink below `MIN_CHART_PX` inside a widget body that scrolls is
 * clipped again the moment the widget is made shorter than the chart plus its
 * chrome — and because the scrollbar takes no layout space, that is visually
 * identical to the original defect. Measured at the old h=4 minimum: 203px of
 * the performance chart and 159px of the equity curve simply not on screen.
 *
 * So the per-type minimum in `PerWidgetMinSize` rose to cover it, and this is
 * what holds it there. Each case serves a saved layout at a chosen height and
 * measures what the browser drew — including one BELOW the minimum, which a
 * layout saved before the minimum rose can still contain.
 */
test.describe('Dashboard chart widgets — across the resize range', () => {
  /**
   * `PerWidgetMinSize` for the two chart widgets, in grid rows. Copied, like
   * `MIN_CHART_PX` above — this package imports no product code.
   *
   * Derived there from the chart's floor plus the widget's chrome; if that
   * derivation changes, these change with it and the `below the minimum` case is
   * what fails first.
   */
  const MIN_ROWS = { 'performance-chart': 11, 'equity-curve': 9 } as const;

  /**
   * A saved layout holding just the two charts, each at its own height, at the
   * minimum WIDTH (w=4). Narrow on purpose: the performance chart's timeframe
   * strip wraps to two rows below about 350px of widget, so the wide form would
   * not exercise the case the height bound has to cover.
   */
  function layoutAt(rows: { 'performance-chart': number; 'equity-curve': number }) {
    return {
      widgets: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          type: 'performance-chart',
          x: 0,
          y: 0,
          w: 4,
          h: rows['performance-chart'],
        },
        {
          id: '00000000-0000-4000-8000-000000000004',
          type: 'equity-curve',
          x: 0,
          y: rows['performance-chart'],
          w: 4,
          h: rows['equity-curve'],
        },
      ],
      theme: 'light',
      updatedAt: null,
    };
  }

  const CASES = [
    // Below the minimum — unreachable by resizing, but a layout SAVED before the
    // minimum rose still holds it, and the read path returns saved geometry
    // untouched. gridstack clamps `h` up to the item's `minH` on add, so this
    // has to render like the minimum rather than clip.
    {
      label: 'below the minimum (a layout saved before it rose)',
      rows: { 'performance-chart': 4, 'equity-curve': 4 },
    },
    { label: 'at the minimum', rows: MIN_ROWS },
    // In between. The equity curve has room for one (9 → 12); the performance
    // chart's minimum is one row under its default, so its "in between" is
    // above the default instead.
    {
      label: 'between the minimum and the cap',
      rows: { 'performance-chart': 16, 'equity-curve': 10 },
    },
    // The pinned default — both chart bands are 12 rows in DEFAULT_WIDGETS.
    { label: 'at the pinned default', rows: { 'performance-chart': 12, 'equity-curve': 12 } },
  ] as const;

  for (const { label, rows } of CASES) {
    test(`nothing is cut off ${label}`, async ({ page, isMobile }, testInfo) => {
      test.skip(isMobile, 'Grid-only — the stacked fallback is not resizable.');

      await mockAppShell(page);
      await page.route('**/api/auth/me', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(SESSION_RESPONSE),
        }),
      );
      await page.route(/\/api\/performance(\?.*)?$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(POPULATED_DASHBOARD_RESPONSE),
        }),
      );
      // Registered after `mockAppShell`, so it wins.
      await page.route('**/api/dashboard/layout', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(layoutAt(rows)),
        }),
      );

      await page.goto('/dashboard');
      await expect(page.locator('[data-grid-mode="grid"]')).toBeVisible();

      for (const { type, testId } of [
        { type: 'performance-chart', testId: 'performance-bar-chart' },
        { type: 'equity-curve', testId: 'equity-curve-chart' },
      ] as const) {
        const h = rows[type];
        const { chartPx, plotPx, cardPx, clippedPx } = await measure(page, type, testId);
        testInfo.annotations.push({
          type: 'measured',
          description: `${type} at h=${h}: plot ${plotPx}px in a ${chartPx}px box, card ${cardPx}px, clipped ${clippedPx}px`,
        });

        expect(
          clippedPx,
          `${type} at h=${h} overflows its widget body by ${clippedPx}px. The ` +
            `chart will not draw below ${MIN_CHART_PX}px and the body scrolls, so ` +
            `that much of it is off-screen with no scrollbar to say so — raise ` +
            `PerWidgetMinSize['${type}'] (it is derived; check chartWidgetMinRows)`,
        ).toBe(0);

        // The plot is still drawn, at the floor or better — a widget that fits
        // because its chart collapsed is not a pass.
        expect(
          plotPx,
          `${type} at h=${h} draws a ${plotPx}px plot in a ${cardPx}px card`,
        ).toBeGreaterThanOrEqual(MIN_CHART_PX);
      }
    });
  }
});
