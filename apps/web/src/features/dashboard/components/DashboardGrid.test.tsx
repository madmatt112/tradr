// @vitest-environment jsdom
import type { GridHTMLElement, GridItemHTMLElement, GridStack, GridStackWidget } from 'gridstack';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PerWidgetMinSize, type WidgetPlacement } from '@tradr/shared/schemas/dashboard';

import { GRID_COLUMNS, GRID_GAP_PX, GRID_MAX_ROWS, GRID_ROW_HEIGHT_PX } from '../grid.constants';

import { createGridOptions, DashboardGrid, fromGridWidgets, toGridWidgets } from './DashboardGrid';
import { WIDGET_DRAG_CANCEL_CLASS, WIDGET_DRAG_HANDLE_CLASS } from './WidgetCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The performance chart's minimum height, in rows — read, not written out.
 *
 * It is DERIVED (from the height its chart needs plus the widget's chrome), so a
 * literal would go stale, and gridstack does not merely reject a shorter item:
 * `addWidget` clamps `h` UP to `minH` and pushes whatever it now collides with.
 * A fixture below the minimum therefore fails on geometry nobody wrote.
 */
const PERF_MIN_H = PerWidgetMinSize['performance-chart'].h;

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
// The two pure conversions. jsdom has no layout, so a gridstack drag resolves
// every pixel delta to zero and cannot be driven through the DOM — these
// functions are where the real coverage of the grid's data model lives.
// ---------------------------------------------------------------------------

describe('toGridWidgets', () => {
  it('carries the id and the per-type minimums from PerWidgetMinSize', () => {
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({ id: 'b', type: 'position-sizing', x: 0, y: 2, w: 4, h: 6 }),
    ];
    expect(toGridWidgets(widgets)).toEqual([
      {
        id: 'a',
        x: 0,
        y: 0,
        w: 12,
        h: 2,
        minW: PerWidgetMinSize['stats-summary'].w,
        minH: PerWidgetMinSize['stats-summary'].h,
        maxH: GRID_MAX_ROWS,
      },
      {
        id: 'b',
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
    // cap belongs on the item as `maxH`. Were it the grid's `maxRow`, gridstack
    // would box free placement into 24 rows total — and the default layout is
    // 36 rows tall. That the grid does not set `maxRow` is asserted
    // against the options it is built with, below.
    const widgets = Object.keys(PerWidgetMinSize).map((type, i) =>
      W({ id: `w${i}`, type: type as WidgetPlacement['type'] }),
    );
    for (const item of toGridWidgets(widgets)) {
      expect(item.maxH).toBe(GRID_MAX_ROWS);
    }
  });

  it('derives every minimum from PerWidgetMinSize rather than hard-coding one', () => {
    const widgets = Object.keys(PerWidgetMinSize).map((type, i) =>
      W({ id: `w${i}`, type: type as WidgetPlacement['type'], w: 12, h: 8 }),
    );
    for (const item of toGridWidgets(widgets)) {
      const widget = widgets.find((candidate) => candidate.id === item.id)!;
      expect({ minW: item.minW, minH: item.minH }).toEqual({
        minW: PerWidgetMinSize[widget.type].w,
        minH: PerWidgetMinSize[widget.type].h,
      });
    }
  });
});

describe('fromGridWidgets', () => {
  it('round-trips through toGridWidgets preserving type and config', () => {
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 2,
        w: 8,
        h: PERF_MIN_H,
        config: { timeframe: 'weekly' },
      }),
    ];
    expect(fromGridWidgets(toGridWidgets(widgets), widgets)).toEqual(widgets);
  });

  it('applies the geometry from the node and keeps type and config from the widget', () => {
    const widgets: WidgetPlacement[] = [
      W({
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 2,
        w: 8,
        h: PERF_MIN_H,
        config: { timeframe: 'weekly' },
      }),
    ];
    const moved: GridStackWidget[] = [{ id: 'b', x: 4, y: 9, w: 6, h: 5 }];
    expect(fromGridWidgets(moved, widgets)).toEqual([
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

  it("defaults the geometry gridstack omits (it drops `w`/`h` once they're 1)", () => {
    const widgets: WidgetPlacement[] = [W({ id: 'a', type: 'stats-summary' })];
    expect(fromGridWidgets([{ id: 'a', x: 3 }], widgets)).toEqual([
      { id: 'a', type: 'stats-summary', x: 3, y: 0, w: 1, h: 1 },
    ]);
  });

  it('drops nodes with no matching widget', () => {
    // The grid can still hold a node for a widget that has just been removed.
    // A placement with no `type` fails WidgetPlacementSchema, so the write
    // would 400.
    const widgets: WidgetPlacement[] = [W({ id: 'a', type: 'stats-summary' })];
    const nodes: GridStackWidget[] = [
      { id: 'a', x: 1, y: 1, w: 4, h: 2 },
      { id: 'gone', x: 0, y: 5, w: 4, h: 2 },
    ];
    const next = fromGridWidgets(nodes, widgets);
    expect(next.map((widget) => widget.id)).toEqual(['a']);
    expect(next[0]).toMatchObject({ x: 1, y: 1 });
  });
});

// ---------------------------------------------------------------------------
// Grid configuration
// ---------------------------------------------------------------------------

describe('createGridOptions', () => {
  it('configures free placement and leaves maxRow unset', () => {
    const opts = createGridOptions();
    expect(opts).toMatchObject({
      column: GRID_COLUMNS,
      cellHeight: GRID_ROW_HEIGHT_PX,
      // gridstack insets EACH SIDE of an item by `margin`, so the gutter a user
      // sees between two neighbours is twice this.
      margin: GRID_GAP_PX / 2,
      float: true,
      handle: `.${WIDGET_DRAG_HANDLE_CLASS}`,
      resizable: { handles: 'e,se,s,sw,w,ne,nw' },
    });
    // Supplying `cancel` replaces gridstack's built-in skip list, so the
    // defaults must still be there alongside the widget's own cancel class.
    expect(opts.draggable?.cancel).toContain(`.${WIDGET_DRAG_CANCEL_CLASS}`);
    expect(opts.draggable?.cancel).toContain('button');
    // A whole-canvas ceiling would clamp free placement to 24 rows; the
    // per-widget height cap lives on each item as `maxH` instead.
    expect(opts.maxRow).toBeUndefined();
  });

  it('hands out a fresh object each call — GridStack.init mutates what it is given', () => {
    expect(createGridOptions()).not.toBe(createGridOptions());
  });
});

// ---------------------------------------------------------------------------
// Mount + write path
// ---------------------------------------------------------------------------

/**
 * gridstack does NOT dispatch its drag/resize callbacks as DOM events (only
 * `added`/`removed`/`change` are real CustomEvents); `on('dragstop', …)` stores
 * the callback in an internal registry that `triggerEvent` invokes directly.
 * jsdom has no layout, so a real pointer drag resolves to a zero-pixel delta —
 * reaching into that registry is the only way to exercise the completion path.
 */
function fireGesture(grid: GridStack, name: 'dragstop' | 'resizestop', el: HTMLElement): void {
  const handlers = (
    grid as unknown as {
      _gsEventHandler: Record<string, ((event: Event, el: HTMLElement) => void) | undefined>;
    }
  )._gsEventHandler;
  handlers[name]?.(new Event(name), el);
}

function gridOf(container: HTMLElement): GridStack {
  const root = container.querySelector('.grid-stack') as GridHTMLElement | null;
  expect(root?.gridstack).toBeDefined();
  return root!.gridstack!;
}

function itemOf(grid: GridStack, id: string): GridItemHTMLElement {
  const el = grid.getGridItems().find((candidate) => candidate.gridstackNode?.id === id);
  expect(el, `grid item ${id}`).toBeDefined();
  return el!;
}

describe('DashboardGrid — grid mount', () => {
  it('renders one gridstack item per widget and writes nothing on mount', () => {
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
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(3);
    // Each card is portalled into the item gridstack made for it.
    expect(
      container.querySelectorAll('.grid-stack-item-content > section[data-widget-id]'),
    ).toHaveLength(3);
    // gridstack fires `added` and `change` while the grid is populated; a write
    // from there would PUT on every dashboard visit.
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('survives a StrictMode double-mount with no duplicate items', () => {
    // main.tsx renders under StrictMode, which mounts → tears down → re-mounts.
    // gridstack owns the item elements, so a cleanup that left them behind
    // would leave the second init adopting six ghosts.
    installMatchMediaSpy({});
    const scheduleLayoutWrite = vi.fn();
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({ id: 'b', type: 'performance-chart', x: 0, y: 2, w: 8, h: 4 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <StrictMode>
          <DashboardGrid
            widgets={widgets}
            onRemove={() => undefined}
            scheduleLayoutWrite={scheduleLayoutWrite}
          />
        </StrictMode>,
      );
    });

    expect(container.querySelectorAll('.grid-stack')).toHaveLength(1);
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(2);
    expect(
      container.querySelectorAll('.grid-stack-item-content > section[data-widget-id]'),
    ).toHaveLength(2);
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('adds and removes items as the persisted widget set changes, still without writing', () => {
    installMatchMediaSpy({});
    const scheduleLayoutWrite = vi.fn();
    const a = W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 });
    const b = W({ id: 'b', type: 'performance-chart', x: 0, y: 2, w: 8, h: 4 });
    const { container, root } = mountIntoBody();
    const render = (widgets: WidgetPlacement[]): void => {
      act(() => {
        root.render(
          <DashboardGrid
            widgets={widgets}
            onRemove={() => undefined}
            scheduleLayoutWrite={scheduleLayoutWrite}
          />,
        );
      });
    };

    render([a]);
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(1);

    render([a, b]);
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(2);

    render([b]);
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(1);
    expect(container.querySelectorAll('.grid-stack-item-content > section')).toHaveLength(1);
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('grows a saved widget that predates its minimum up to it', () => {
    // No default can reach an existing layout. A user who shrank their
    // performance chart to the old h=4 minimum — or had one doubled into that
    // by migration 0021 — still has h=4 in the database, below what the chart
    // needs, and the read path returns saved geometry untouched.
    //
    // gridstack is what reaches them: `addWidget` clamps `h` up to the item's
    // `minH` (and pushes anything it now collides with), so the widget RENDERS
    // at the safe height instead of hiding the bottom of its chart. The stale
    // row in the database is rewritten by the first completed gesture.
    installMatchMediaSpy({});
    const scheduleLayoutWrite = vi.fn();
    const legacy = [W({ id: 'b', type: 'performance-chart', x: 0, y: 0, w: 8, h: 4 })];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={legacy}
          onRemove={() => undefined}
          scheduleLayoutWrite={scheduleLayoutWrite}
        />,
      );
    });

    expect(itemOf(gridOf(container), 'b').gridstackNode?.h).toBe(PERF_MIN_H);
    // …and still no write on mount: the repair is not a reason to PUT on every
    // dashboard visit.
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('DashboardGrid — gesture completion is the only write path', () => {
  it('writes once per completed gesture, never from a programmatic move', () => {
    installMatchMediaSpy({});
    const scheduleLayoutWrite = vi.fn();
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 }),
      W({
        id: 'b',
        type: 'performance-chart',
        x: 0,
        y: 2,
        w: 8,
        h: PERF_MIN_H,
        config: { timeframe: 'weekly' },
      }),
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
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    const grid = gridOf(container);
    const itemA = itemOf(grid, 'a');

    // Move into empty canvas below everything — nothing to push, so the result
    // is unambiguous. The move alone must not write. (Geometry is passed whole:
    // `update` defaults any side it is not given rather than keeping it, so a
    // partial `{x, y}` would silently reset `w`/`h` to 1.)
    const emptyRow = 2 + PERF_MIN_H;
    grid.update(itemA, { x: 0, y: emptyRow, w: 12, h: 2 });
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    fireGesture(grid, 'dragstop', itemA);
    expect(scheduleLayoutWrite).toHaveBeenCalledTimes(1);
    const dragged = scheduleLayoutWrite.mock.calls[0][0] as WidgetPlacement[];
    expect(dragged).toHaveLength(2);
    // `type` and `config` are not gridstack's to hold — they come back off the
    // widget the node matches.
    //
    // `h: 2` also pins a gridstack gotcha: `save()` DELETES `h` from a node
    // when it equals 1 or the item's own `minH`, and stats-summary's minH IS 2.
    // Taken at face value the placement would persist as 1 row tall.
    expect(dragged.find((widget) => widget.id === 'a')).toEqual({
      id: 'a',
      type: 'stats-summary',
      x: 0,
      y: emptyRow,
      w: 12,
      h: 2,
    });
    expect(dragged.find((widget) => widget.id === 'b')).toEqual({
      id: 'b',
      type: 'performance-chart',
      x: 0,
      y: 2,
      w: 8,
      h: PERF_MIN_H,
      config: { timeframe: 'weekly' },
    });

    // Shrink to exactly PerWidgetMinSize['performance-chart'] — the other half
    // of the same gotcha, where `save()` would drop BOTH `w` and `h`.
    grid.update(itemOf(grid, 'b'), { x: 0, y: 2, w: 4, h: PERF_MIN_H });
    fireGesture(grid, 'resizestop', itemOf(grid, 'b'));
    expect(scheduleLayoutWrite).toHaveBeenCalledTimes(2);
    const resized = scheduleLayoutWrite.mock.calls[1][0] as WidgetPlacement[];
    expect(resized.find((widget) => widget.id === 'b')).toMatchObject({ w: 4, h: PERF_MIN_H });

    act(() => {
      root.unmount();
    });
    container.remove();
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

    // No gridstack instance, so no drag zone and no resize handles.
    expect(container.querySelectorAll('.grid-stack')).toHaveLength(0);
    expect(container.querySelectorAll('.grid-stack-item')).toHaveLength(0);
    expect(container.querySelector('.ui-resizable-handle')).toBeNull();
    expect(container.querySelector('[data-drag-zone="true"]')).toBeNull();
    expect(scheduleLayoutWrite).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
