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
    // The other four default widgets fetch too, and they are NOT app-shell
    // surface — `mockAppShell` covers the `_auth` layout, and nothing had ever
    // pointed it at /dashboard before this file. Unmocked they reach the real
    // API, which does not know the synthetic session, and a single 401 sends
    // the whole app to /login: the symptom is "chart not found" on the login
    // form, not an auth error.
    //
    // Neutral answers — neither widget is under test here, they only have to
    // stop 401ing.
    await page.route('**/api/dashboard/totals', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Account Balances → CrossCurrencyTotal.
        body: JSON.stringify({ displayCurrency: 'USD', total: '0.00' }),
      }),
    );
    await page.route(/\/api\/brokerages(\?.*)?$/, (route) =>
      // Open Positions → PositionList.
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
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
      expect(plotPx, 'the drawn plot fills the box it was given').toBe(chartPx);
    }
  });
});
