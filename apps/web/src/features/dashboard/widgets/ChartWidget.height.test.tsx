// @vitest-environment jsdom
//
// The two chart widgets have to FIT the body they are given, and the body has
// to be worth fitting.
//
// Neither was true. `PerformanceBarChart` and `EquityCurveChart` both wrapped
// themselves in a hard-coded `h-[320px]`, and the widget body at the pinned
// default is 149px — so measured in chromium at 1440x900 the performance chart
// cut off 215px of itself (293px on the enforced free tier, where the boxed
// tier notice renders in the same body) and the equity curve 171px (249px).
// The whole x-axis and the bottom of every bar were simply not on screen.
// Nothing caught it: jsdom performs no layout, so every DOM assertion in the
// suite passed against a chart that was half out of view.
//
// Two properties are pinned here, because either one alone lets it back in:
//
//   1. STRUCTURE — the chart takes the height it is given and the widget hands
//      it the leftovers. This is the part that holds at ANY height, including
//      the shorter heights users can resize to and the ones already sitting in
//      saved layouts, which no default can reach.
//   2. ROOM — the pinned default leaves enough of that height for a chart worth
//      looking at. Structure alone stops the clipping and can still leave a
//      55px plot with the data labels sitting on the date ticks, which is not a
//      fix.
//
// The pixel constants are measured off a real chromium render at 1440x900;
// jsdom cannot supply them.
//
// AND THAT IS THIS FILE'S CEILING. It is arithmetic over measured constants and
// class-name assertions — it can tell you the numbers add up, never that the
// browser agreed. The next defect walked straight through it: the container-
// sizing fix said `min-h-0`, which in the stacked mobile grid — where
// `WidgetCard` has no determinate height at all — resolved to a 0px chart and a
// 73px empty widget, on every touch device, with this file green.
//
// The measurement that can see that lives in `e2e/tests/dashboard-chart-height.spec.ts`
// and runs on both the `chromium` and `Mobile Chrome` projects. Anything about
// RENDERED height belongs there, not here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceResponse, WidgetPlacement } from '@tradr/shared';
import { DEFAULT_WIDGETS } from '@tradr/shared/constants/dashboard-defaults';
import {
  BODY_PADDING_PX,
  CARD_BORDER_PX,
  CARD_HEADER_PX,
  STACK_GAP_PX,
  TIMEFRAME_ROW_PX,
} from '@tradr/shared/constants/dashboard-geometry';
import { PerWidgetMinSize } from '@tradr/shared/schemas/dashboard';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { CHART_MIN_HEIGHT_PX } from '@/features/performance/chart.constants';
import { usePerformance } from '@/features/performance/hooks/usePerformance';

import { GRID_GAP_PX, GRID_ROW_HEIGHT_PX } from '../grid.constants';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/accounting/hooks/useDisplayCurrency', () => ({
  useDisplayCurrencyQuery: vi.fn(),
}));
vi.mock('@/features/performance/hooks/usePerformance', () => ({
  usePerformance: vi.fn(),
}));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => 'America/New_York',
}));
// `purchasable: true` is the taller of the two notice states — it carries the
// upgrade CTA, which sets the compact row's height.
vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: { purchasable: true } }),
}));
vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
// ResponsiveContainer measures via ResizeObserver, which never fires in jsdom.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

import EquityCurveWidget from './EquityCurveWidget';
import PerformanceChartWidget from './PerformanceChartWidget';

type PerformanceResult = ReturnType<typeof usePerformance>;
type DisplayCurrencyResult = ReturnType<typeof useDisplayCurrencyQuery>;

// ---------------------------------------------------------------------------
// Measured in chromium at 1440x900 against the real components and built CSS.
//
// The chrome figures are IMPORTED, not restated. `PerWidgetMinSize` is derived
// from the same ones (a chart widget's minimum height is its chart's floor plus
// its chrome, in rows), so a local copy here would let the arithmetic this file
// pins and the bound the grid enforces disagree.
// ---------------------------------------------------------------------------

/**
 * The compact TierWindowNotice: one line of text-xs beside an h-6 upgrade CTA.
 * The boxed Alert the Performance page uses is 66px, and these widgets ask for
 * the compact form for the same reason StatsSummaryWidget does — the notice
 * comes out of the chart's share of a fixed body.
 */
const NOTICE_PX = 24;
/**
 * The floor a dashboard chart is held to. The Performance page gives the equity
 * curve 320px; three-quarters of that is the least this widget may offer and
 * still be a chart rather than a strip. Below it the y-axis falls to three ticks
 * and the signed data labels start colliding with the date ticks — at the 105px
 * the old h=6 default left, they overlapped outright.
 *
 * The same number the charts now enforce for themselves as `CHART_MIN_HEIGHT_PX`
 * — imported rather than restated, so the default height and the chart's own
 * floor cannot drift apart.
 */
const MIN_CHART_PX = CHART_MIN_HEIGHT_PX;

/**
 * Body height of a widget spanning `h` rows, in px — what `body.clientHeight`
 * reports. A widget spanning `h` rows is `40h` of canvas less the 16px gridstack
 * takes out of the cell, and WidgetCard spends its border and header out of that
 * before its scroll body sees a pixel.
 */
function bodyPxAt(h: number): number {
  return GRID_ROW_HEIGHT_PX * h - GRID_GAP_PX - CARD_BORDER_PX - CARD_HEADER_PX;
}

/** The pinned default body height, in px. */
function pinnedBodyPx(type: 'performance-chart' | 'equity-curve'): { h: number; bodyPx: number } {
  const pinned = DEFAULT_WIDGETS.find((w) => w.type === type);
  const h = pinned?.h ?? 0;
  return { h, bodyPx: bodyPxAt(h) };
}

/** What each widget stacks above its chart, in px. */
const TOOLBAR_PX = {
  'performance-chart': TIMEFRAME_ROW_PX + STACK_GAP_PX,
  'equity-curve': 0,
} as const;

function mockPerformance({ clamped }: { clamped: boolean }): void {
  vi.mocked(usePerformance).mockReturnValue({
    data: {
      currencies: [
        {
          code: 'USD',
          series: [
            { bucketStart: '2026-06-01T00:00:00.000Z', netPnl: '1180.25' },
            { bucketStart: '2026-07-01T00:00:00.000Z', netPnl: '-420.50' },
          ],
          equityCurve: [
            { bucketStart: '2026-06-01T00:00:00.000Z', cumulativeNetPnl: '1180.25' },
            { bucketStart: '2026-07-01T00:00:00.000Z', cumulativeNetPnl: '759.75' },
          ],
          historyRange: {
            earliestClosedAt: '2026-02-02T00:00:00.000Z',
            mostRecentClosedAt: '2026-07-30T00:00:00.000Z',
            totalClosedPositions: 10,
          },
        },
      ],
      ...(clamped
        ? {
            tierWindow: {
              clamped: true,
              effectiveStart: '2026-02-01T00:00:00.000Z',
              lookbackMonths: 6,
            },
          }
        : {}),
    } as unknown as PerformanceResponse,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as PerformanceResult);
}

const PLACEMENT: WidgetPlacement = {
  id: '00000000-0000-4000-8000-000000000002',
  type: 'performance-chart',
  x: 0,
  y: 6,
  w: 8,
  h: 12,
  config: { timeframe: 'monthly' },
};

function mount(which: 'performance-chart' | 'equity-curve'): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      which === 'performance-chart' ? (
        <PerformanceChartWidget placement={PLACEMENT} onUpdateConfig={() => undefined} />
      ) : (
        <EquityCurveWidget />
      ),
    );
  });
  return { container, root };
}

beforeEach(() => {
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
  } as unknown as DisplayCurrencyResult);
  mockPerformance({ clamped: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chart widgets size to the body they are given', () => {
  it.each([
    ['performance-chart', 'performance-bar-chart'],
    ['equity-curve', 'equity-curve-chart'],
  ] as const)('%s fills its column instead of naming a height', (which, testId) => {
    const { container, root } = mount(which);
    const column = container.firstElementChild;
    const chart = container.querySelector(`[data-testid="${testId}"]`);
    act(() => {
      root.unmount();
    });
    container.remove();

    expect(chart, 'the populated widget renders its chart').not.toBeNull();

    // The column has to BE the body, or `flex-1` below has nothing to divide.
    expect(
      column?.className,
      `${which}'s column must be h-full — without it the chart sizes to its ` +
        `content and overflows the widget body again`,
    ).toContain('h-full');

    // `flex-1` takes what the notice and any toolbar leave.
    expect(chart?.className, `${which}'s chart must take the leftover height (flex-1)`).toContain(
      'flex-1',
    );

    // …and it must NOT carry `min-h-0`. That is the second defect, in one class:
    // a flex item's `min-height: auto` is its min-content height, which the
    // chart supplies as CHART_MIN_HEIGHT_PX, and `min-h-0` throws that floor
    // away. Where the parent has a height to divide, the two are
    // indistinguishable — the chart gets 345px either way. Where it does not,
    // which is every touch device (the stacked grid renders WidgetCard with no
    // determinate height), "shrink as far as you like" means zero: both charts
    // rendered at 0px and the equity curve widget was a 73px empty strip.
    expect(
      chart?.className,
      `${which}'s chart must not zero out its own floor with min-h-0 — in the ` +
        `mobile stack there is no height to divide and it collapses to 0px`,
    ).not.toMatch(/(^|\s)min-h-0(\s|$)/);

    // A fixed pixel height is the original defect. It clips at every container
    // height that is not exactly that number, including every saved layout. (A
    // `min-h-*` floor is a different thing and is allowed — hence the anchor.)
    expect(
      chart?.className,
      `${which}'s chart must not pin a pixel height — that is what clipped it`,
    ).not.toMatch(/(^|\s)h-\[\d+px\]/);
  });
});

describe('the per-widget MINIMUM leaves the chart its floor', () => {
  // The default is not the size a user runs at — it is the size they start at.
  // Every height between the minimum and the cap is reachable by dragging a
  // resize handle, so the guarantee has to hold at the SHORTEST of them or it is
  // not a guarantee: the chart cannot shrink below CHART_MIN_HEIGHT_PX and the
  // body is `overflow-auto`, so a widget shorter than "floor + chrome" hides the
  // bottom of the chart behind a scroller that takes no layout space. Measured
  // in chromium at the old h=4 minimum: 203px of the performance chart and 159px
  // of the equity curve simply not on screen.
  it.each(['performance-chart', 'equity-curve'] as const)('%s', (which) => {
    const h = PerWidgetMinSize[which].h;
    const bodyPx = bodyPxAt(h);
    const chartPx = bodyPx - BODY_PADDING_PX - TOOLBAR_PX[which];

    expect(
      chartPx,
      `${which} may be resized down to h=${h} (${bodyPx}px of body), which ` +
        `leaves the chart ${chartPx}px — under the ${MIN_CHART_PX}px floor, so ` +
        `the chart overflows the body and is silently scrolled off. Raise the ` +
        `minimum in PerWidgetMinSize (it is derived — check chartWidgetMinRows)`,
    ).toBeGreaterThanOrEqual(MIN_CHART_PX);

    // …and not a row taller than it has to be. A minimum that over-reserves
    // takes vertical resizing away from the user for nothing, and at some point
    // meets the pinned default and removes it entirely.
    expect(
      bodyPxAt(h - 1) - BODY_PADDING_PX - TOOLBAR_PX[which],
      `${which}'s minimum h=${h} is one row taller than its content needs`,
    ).toBeLessThan(MIN_CHART_PX);
  });

  // The pinned default has to stay ABOVE the minimum, or "resize it shorter" is
  // not an operation the widget offers at all.
  it.each(['performance-chart', 'equity-curve'] as const)('%s can still be shrunk', (which) => {
    const { h } = pinnedBodyPx(which);
    expect(
      PerWidgetMinSize[which].h,
      `${which} is pinned to h=${h} and cannot be resized below ` +
        `h=${PerWidgetMinSize[which].h}`,
    ).toBeLessThan(h);
  });
});

describe('the pinned default leaves the chart a legible plot', () => {
  it.each([
    // The performance chart pays for its timeframe button row out of the same
    // body; the equity curve has no toolbar.
    ['performance-chart', TIMEFRAME_ROW_PX + STACK_GAP_PX],
    ['equity-curve', 0],
  ] as const)('%s, plain', (which, toolbarPx) => {
    const { h, bodyPx } = pinnedBodyPx(which);
    const chartPx = bodyPx - BODY_PADDING_PX - toolbarPx;

    expect(
      chartPx,
      `${which} is pinned to h=${h} (${bodyPx}px of body), leaving the chart ` +
        `${chartPx}px — under the ${MIN_CHART_PX}px floor. Raise the height in ` +
        `DEFAULT_WIDGETS`,
    ).toBeGreaterThanOrEqual(MIN_CHART_PX);
  });

  it.each([
    ['performance-chart', TIMEFRAME_ROW_PX + STACK_GAP_PX],
    ['equity-curve', 0],
  ] as const)('%s, with the free-tier window notice', (which, toolbarPx) => {
    // Assert the notice is really the compact one — NOTICE_PX measures that
    // form, and the boxed Alert is 66px.
    mockPerformance({ clamped: true });
    const { container, root } = mount(which);
    const notice = container.querySelector('[data-testid="tier-window-notice"]');
    const boxed = container.querySelector('[data-slot="alert"]');
    act(() => {
      root.unmount();
    });
    container.remove();

    expect(notice, 'a clamped response renders the tier window notice').not.toBeNull();
    expect(boxed, 'the notice renders compact in a pinned widget, not as a boxed Alert').toBeNull();

    const { h, bodyPx } = pinnedBodyPx(which);
    const chartPx = bodyPx - BODY_PADDING_PX - toolbarPx - NOTICE_PX - STACK_GAP_PX;

    expect(
      chartPx,
      `on the enforced free tier ${which} renders a ${NOTICE_PX}px notice above ` +
        `its chart, leaving ${chartPx}px at h=${h} — under the ${MIN_CHART_PX}px ` +
        `floor, so the free-tier user gets a strip instead of a chart`,
    ).toBeGreaterThanOrEqual(MIN_CHART_PX);
  });
});
