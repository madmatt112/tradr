// @vitest-environment jsdom
//
// The pinned default height has to fit what this widget actually renders.
//
// It did not. Stats Summary shipped at h=2 — a 64px card with a 24px scroll
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

beforeEach(() => {
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
  } as unknown as DisplayCurrencyResult);
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
    } as unknown as PerformanceResponse,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as PerformanceResult);
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

    const pinned = DEFAULT_WIDGETS.find((w) => w.type === 'stats-summary');
    const h = pinned?.h ?? 0;
    // A widget spanning `h` rows is `40h` of canvas less the 16px gridstack
    // takes out of the cell, and WidgetCard spends its border and header out of
    // that before its scroll body sees a pixel. At h=5 this comes to 133, which
    // is what the browser reports for `body.clientHeight`.
    const bodyPx = GRID_ROW_HEIGHT_PX * h - GRID_GAP_PX - CARD_BORDER_PX - CARD_HEADER_PX;

    expect(
      bodyPx,
      `stats-summary is pinned to h=${h} (${bodyPx}px of body) but its ${tiles} tiles ` +
        `need ${contentPx}px — raise the height in DEFAULT_WIDGETS`,
    ).toBeGreaterThanOrEqual(contentPx);
  });
});
