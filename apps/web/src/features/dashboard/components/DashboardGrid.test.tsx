// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Layout } from 'react-grid-layout';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PerWidgetMinSize, type WidgetPlacement } from '@tradr/shared/schemas/dashboard';

import { GRID_MAX_ROWS } from '../grid.constants';

import { DashboardGrid, GRID_CONFIG, fromGridLayout, toGridLayout } from './DashboardGrid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const W = (over: Partial<WidgetPlacement>): WidgetPlacement =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'stats-summary',
    x: 0,
    y: 0,
    w: 4,
    h: 2,
    ...over,
  }) as WidgetPlacement;

function mountIntoBody(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

// matchMedia spy. Tests set the active query → match map before rendering.
let matchMediaSpy: { mockRestore: () => void } | null = null;
function installMatchMediaSpy(matches: Record<string, boolean>): void {
  const spy = vi.spyOn(window, 'matchMedia');
  spy.mockImplementation(((q: string) => ({
    matches: matches[q] ?? false,
    media: q,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as (query: string) => MediaQueryList);
  matchMediaSpy = spy;
}

afterEach(() => {
  matchMediaSpy?.mockRestore();
  matchMediaSpy = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The two pure conversions. jsdom has no layout, so an RGL drag resolves every
// pixel delta to zero and cannot be driven through the DOM — these functions
// are where the real coverage of the grid's data model lives.
// ---------------------------------------------------------------------------

describe('toGridLayout', () => {
  it('maps id → i and carries the per-type minimums from PerWidgetMinSize', () => {
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({ id: 'b', type: 'position-sizing', x: 0, y: 2, w: 4, h: 6 }),
    ];
    expect(toGridLayout(widgets)).toEqual([
      {
        i: 'a',
        x: 0,
        y: 0,
        w: 12,
        h: 2,
        minW: PerWidgetMinSize['stats-summary'].w,
        minH: PerWidgetMinSize['stats-summary'].h,
        maxH: GRID_MAX_ROWS,
      },
      {
        i: 'b',
        x: 0,
        y: 2,
        w: 4,
        h: 6,
        minW: PerWidgetMinSize['position-sizing'].w,
        minH: PerWidgetMinSize['position-sizing'].h,
        maxH: GRID_MAX_ROWS,
      },
    ]);
  });

  it('caps height per widget rather than capping the canvas', () => {
    // The schema bounds `h` at GRID_MAX_ROWS and leaves `y` unbounded, so the
    // cap belongs on the item as `maxH`. Were it the grid's `maxRows`, RGL
    // would clamp `y <= maxRows - h` and box free placement into 24 rows —
    // with the default layout already reaching row 20.
    const widgets = Object.keys(PerWidgetMinSize).map((type, i) =>
      W({ id: `w${i}`, type: type as WidgetPlacement['type'] }),
    );
    for (const item of toGridLayout(widgets)) {
      expect(item.maxH).toBe(GRID_MAX_ROWS);
    }
    expect(GRID_CONFIG?.maxRows).toBeUndefined();
  });

  it('derives every minimum from PerWidgetMinSize rather than hard-coding one', () => {
    const widgets = Object.keys(PerWidgetMinSize).map((type, i) =>
      W({ id: `w${i}`, type: type as WidgetPlacement['type'], w: 12, h: 8 }),
    );
    for (const item of toGridLayout(widgets)) {
      const widget = widgets.find((candidate) => candidate.id === item.i)!;
      expect({ minW: item.minW, minH: item.minH }).toEqual({
        minW: PerWidgetMinSize[widget.type].w,
        minH: PerWidgetMinSize[widget.type].h,
      });
    }
  });
});

describe('fromGridLayout', () => {
  it('round-trips through toGridLayout preserving type and config', () => {
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 2,
        w: 8,
        h: 4,
        config: { timeframe: 'weekly' },
      }),
    ];
    expect(fromGridLayout(toGridLayout(widgets), widgets)).toEqual(widgets);
  });

  it('applies the geometry from the layout and keeps type and config from the widget', () => {
    const widgets: WidgetPlacement[] = [
      W({
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 2,
        w: 8,
        h: 4,
        config: { timeframe: 'weekly' },
      }),
    ];
    const moved: Layout = [{ i: 'b', x: 4, y: 9, w: 6, h: 5 }];
    expect(fromGridLayout(moved, widgets)).toEqual([
      {
        id: 'b',
        type: 'performance-chart',
        x: 4,
        y: 9,
        w: 6,
        h: 5,
        config: { timeframe: 'weekly' },
      },
    ]);
  });

  it('drops layout items with no matching widget', () => {
    // RGL's internal layout can still hold an entry for a widget that has just
    // been removed. A placement with no `type` fails WidgetPlacementSchema, so
    // the write would 400.
    const widgets: WidgetPlacement[] = [W({ id: 'a', type: 'stats-summary' })];
    const layout: Layout = [
      { i: 'a', x: 1, y: 1, w: 4, h: 2 },
      { i: 'gone', x: 0, y: 5, w: 4, h: 2 },
    ];
    const next = fromGridLayout(layout, widgets);
    expect(next.map((widget) => widget.id)).toEqual(['a']);
    expect(next[0]).toMatchObject({ x: 1, y: 1 });
  });
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

describe('DashboardGrid — grid mount', () => {
  it('renders one react-grid-layout item per widget and writes nothing on mount', () => {
    installMatchMediaSpy({});
    const scheduleLayoutWrite = vi.fn();
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({ id: 'b', type: 'performance-chart', x: 0, y: 2, w: 8, h: 4 }),
      W({ id: 'c', type: 'account-balances', x: 8, y: 2, w: 4, h: 4 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={scheduleLayoutWrite}
        />,
      );
    });

    expect(container.querySelector('[data-grid-mode="grid"]')).not.toBeNull();
    expect(container.querySelectorAll('.react-grid-item')).toHaveLength(3);
    // RGL calls onLayoutChange on mount; a write from there would PUT on every
    // dashboard visit.
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

describe('DashboardGrid — gesture completion is the only write path', () => {
  interface Captured {
    onDragStop?: (layout: Layout) => void;
    onResizeStop?: (layout: Layout) => void;
    onLayoutChange?: (layout: Layout) => void;
  }

  it('writes once per completed gesture and never from onLayoutChange', async () => {
    installMatchMediaSpy({});
    const captured: Captured = {};
    vi.resetModules();
    vi.doMock('react-grid-layout', async () => {
      const actual = await vi.importActual<typeof import('react-grid-layout')>('react-grid-layout');
      return {
        ...actual,
        // jsdom cannot drive an RGL drag (no layout → every delta is zero), so
        // capture the completion callbacks and invoke them directly.
        GridLayout: (props: Captured & { children?: React.ReactNode }) => {
          captured.onDragStop = props.onDragStop;
          captured.onResizeStop = props.onResizeStop;
          captured.onLayoutChange = props.onLayoutChange;
          return <div data-testid="grid-layout-mock">{props.children}</div>;
        },
      };
    });
    const mod = await import('./DashboardGrid');

    const scheduleLayoutWrite = vi.fn();
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 2,
        w: 8,
        h: 4,
        config: { timeframe: 'weekly' },
      }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <mod.DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={scheduleLayoutWrite}
        />,
      );
    });
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    const mountLayout: Layout = mod.toGridLayout(widgets);
    // The mount call, and any later prop-driven resync, must not write.
    act(() => {
      captured.onLayoutChange!(mountLayout);
    });
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    const dragged: Layout = [
      { i: 'a', x: 0, y: 4, w: 12, h: 2 },
      { i: 'b', x: 0, y: 6, w: 8, h: 4 },
    ];
    act(() => {
      captured.onDragStop!(dragged);
    });
    expect(scheduleLayoutWrite).toHaveBeenCalledTimes(1);
    expect(scheduleLayoutWrite.mock.calls[0][0]).toEqual([
      { id: 'a', type: 'stats-summary', x: 0, y: 4, w: 12, h: 2 },
      {
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 6,
        w: 8,
        h: 4,
        config: { timeframe: 'weekly' },
      },
    ]);

    // RGL follows every gesture with onLayoutChange (twice, in fact). It must
    // not turn one gesture into a second write.
    act(() => {
      captured.onLayoutChange!(dragged);
    });
    act(() => {
      captured.onLayoutChange!(dragged);
    });
    expect(scheduleLayoutWrite).toHaveBeenCalledTimes(1);

    const resized: Layout = [
      { i: 'a', x: 0, y: 4, w: 12, h: 3 },
      { i: 'b', x: 0, y: 7, w: 8, h: 4 },
    ];
    act(() => {
      captured.onResizeStop!(resized);
    });
    expect(scheduleLayoutWrite).toHaveBeenCalledTimes(2);
    expect(scheduleLayoutWrite.mock.calls[1][0]).toMatchObject([
      { id: 'a', h: 3 },
      { id: 'b', y: 7 },
    ]);

    act(() => {
      root.unmount();
    });
    container.remove();
    vi.doUnmock('react-grid-layout');
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// Mobile fallback (Req 4.9)
// ---------------------------------------------------------------------------

describe('DashboardGrid — mobile fallback', () => {
  it('renders a plain stack in (y, x) order with no drag or resize affordance', () => {
    installMatchMediaSpy({ '(max-width: 767px)': true });
    const scheduleLayoutWrite = vi.fn();
    const shuffled: WidgetPlacement[] = [
      W({ id: 'c', type: 'open-positions', x: 0, y: 2 }),
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0 }),
      W({ id: 'd', type: 'account-balances', x: 4, y: 2 }),
      W({ id: 'b', type: 'performance-chart', x: 6, y: 0 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={shuffled}
          onRemove={() => undefined}
          scheduleLayoutWrite={scheduleLayoutWrite}
        />,
      );
    });
    const wrapper = container.querySelector('[data-grid-mode="mobile"]');
    expect(wrapper).not.toBeNull();
    // Only inspect direct-child slot wrappers — WidgetCard internally also
    // stamps a data-widget-id on its <section>, which would double-count.
    const order = Array.from(wrapper!.children)
      .map((el) => el.getAttribute('data-widget-id'))
      .filter((id): id is string => id !== null);
    expect(order).toEqual(['a', 'b', 'c', 'd']);

    // No RGL, so no drag zone and no resize handles.
    expect(container.querySelectorAll('.react-grid-item')).toHaveLength(0);
    expect(container.querySelector('.react-resizable-handle')).toBeNull();
    expect(container.querySelector('[data-drag-zone="true"]')).toBeNull();
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
