// @vitest-environment jsdom
//
// The pinned default height has to fit what this widget actually renders.
//
// It did not. Stats Summary shipped at h=2 — a 64px card with a 13px scroll
// body — against 124px of populated tiles, so every figure was clipped and the
// panel read as a blank area. Nothing caught it: jsdom performs no layout, so
// the existing DOM assertions all passed against a widget whose content was
// entirely out of view, and the widget spent most of its life in the one-line
// "Close a position to see stats." empty state (it queried the current month
// only), which did fit.
//
// So this measures on paper instead, from constants read off a real chromium
// render at 1440x900, and derives the requirement from the tiles the component
// renders NOW rather than from a hardcoded total. Add a sixth tile and the grid
// gains a row and this fails; shrink the default height and this fails.
//
// The enforced free tier renders TierWindowNotice in the SAME body, so it gets
// its own case below. It is the reason the notice is `compact` there: boxed, it
// clipped 69px at h=5 and would still clip 29px at h=6.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceResponse } from '@tradr/shared';
import { DEFAULT_WIDGETS } from '@tradr/shared/constants/dashboard-defaults';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
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

import StatsSummaryWidget from './StatsSummaryWidget';

type PerformanceResult = ReturnType<typeof usePerformance>;
type DisplayCurrencyResult = ReturnType<typeof useDisplayCurrencyQuery>;

// ---------------------------------------------------------------------------
// Measured in chromium at 1440x900 against the seeded sample data, reading the
// live boxes off the rendered widget. These are the numbers jsdom cannot give.
// ---------------------------------------------------------------------------

/** `<header>` of WidgetCard: a text-sm title at px-3 py-2 over a 1px border. */
const CARD_HEADER_PX = 49;
/** WidgetCard's own `border`, top and bottom, inside the gridstack cell. */
const CARD_BORDER_PX = 2;
/** One tile: a text-sm `<dt>` (20px) above a font-medium `<dd>` (24px). */
const TILE_PX = 44;
/** `gap-y-3` between tile rows. */
const TILE_ROW_GAP_PX = 12;
/** `p-3` on WidgetCard's scroll body, top and bottom. */
const BODY_PADDING_PX = 24;
/**
 * The compact TierWindowNotice: one line of text-xs beside an h-6 upgrade CTA,
 * which is what sets the height. The boxed Alert the other surfaces use is 66px.
 */
const NOTICE_PX = 24;
/** `gap-3` between the notice and the tile grid in the widget's column stack. */
const NOTICE_GAP_PX = 12;
/**
 * `sm:grid-cols-3`. The grid mode this widget is pinned in only exists at
 * >=768px viewports (below that DashboardGrid drops to an unpinned, auto-height
 * mobile stack), so the 3-column track is the only one a pinned height meets.
 */
const TILE_COLUMNS = 3;

function mountPopulated(): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<StatsSummaryWidget />);
  });
  return { container, root };
}

/** The enforced free tier clamps the all-time window and sets `tierWindow`. */
function mockPerformance({ clamped }: { clamped: boolean }): void {
  vi.mocked(usePerformance).mockReturnValue({
    data: {
      currencies: [
        {
          code: 'USD',
          stats: {
            totalNetPnl: 12345.67,
            winRate: 0.62,
            avgWin: 1820.4,
            avgLoss: -640.25,
            profitFactor: 2.14,
            hasWins: true,
            hasLosses: true,
          },
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

/** The pinned default body height, in px — what `body.clientHeight` reports. */
function pinnedBodyPx(): { h: number; bodyPx: number } {
  const pinned = DEFAULT_WIDGETS.find((w) => w.type === 'stats-summary');
  const h = pinned?.h ?? 0;
  // A widget spanning `h` rows is `40h` of canvas less the 16px gridstack takes
  // out of the cell, and WidgetCard spends its border and header out of that
  // before its scroll body sees a pixel. At h=6 this comes to 173.
  return { h, bodyPx: GRID_ROW_HEIGHT_PX * h - GRID_GAP_PX - CARD_BORDER_PX - CARD_HEADER_PX };
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

describe('StatsSummaryWidget — the pinned default height fits the populated tiles', () => {
  it('gives the tile grid more body height than it needs', () => {
    const { container, root } = mountPopulated();
    const tiles = container.querySelectorAll('dl > div').length;
    act(() => {
      root.unmount();
    });
    container.remove();

    expect(tiles, 'the populated widget renders its tiles').toBeGreaterThan(0);

    const rows = Math.ceil(tiles / TILE_COLUMNS);
    const contentPx = rows * TILE_PX + (rows - 1) * TILE_ROW_GAP_PX + BODY_PADDING_PX;

    const { h, bodyPx } = pinnedBodyPx();

    expect(
      bodyPx,
      `stats-summary is pinned to h=${h} (${bodyPx}px of body) but its ${tiles} tiles ` +
        `need ${contentPx}px — raise the height in DEFAULT_WIDGETS`,
    ).toBeGreaterThanOrEqual(contentPx);
  });

  it('still fits once the free-tier window notice renders above the tiles', () => {
    mockPerformance({ clamped: true });
    const { container, root } = mountPopulated();
    const tiles = container.querySelectorAll('dl > div').length;
    const notice = container.querySelector('[data-testid="tier-window-notice"]');
    // The boxed Alert the performance page uses is 66px and does not fit here at
    // any legal row span; the widget asks for the one-line form instead. Assert
    // the shape, because NOTICE_PX below is a measurement of THAT form.
    const boxed = container.querySelector('[data-slot="alert"]');
    act(() => {
      root.unmount();
    });
    container.remove();

    expect(notice, 'a clamped response renders the tier window notice').not.toBeNull();
    expect(boxed, 'the notice renders compact in a pinned widget, not as a boxed Alert').toBeNull();
    expect(tiles, 'the populated widget still renders its tiles').toBeGreaterThan(0);

    const rows = Math.ceil(tiles / TILE_COLUMNS);
    const contentPx =
      rows * TILE_PX + (rows - 1) * TILE_ROW_GAP_PX + BODY_PADDING_PX + NOTICE_PX + NOTICE_GAP_PX;

    const { h, bodyPx } = pinnedBodyPx();

    expect(
      bodyPx,
      `on the enforced free tier stats-summary renders a ${NOTICE_PX}px notice above its ` +
        `${tiles} tiles, needing ${contentPx}px, but h=${h} gives the body ${bodyPx}px — ` +
        `the free-tier user sees a clipped widget`,
    ).toBeGreaterThanOrEqual(contentPx);
  });
});
