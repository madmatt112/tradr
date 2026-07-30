import 'react-grid-layout/css/styles.css';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  GridLayout,
  noCompactor,
  useContainerWidth,
  type GridLayoutProps,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout';

import { PerWidgetMinSize, type WidgetPlacement } from '@tradr/shared/schemas/dashboard';

import { GRID_COLUMNS, GRID_GAP_PX, GRID_MAX_ROWS, GRID_ROW_HEIGHT_PX } from '../grid.constants';
import { sortByYThenX } from '../layout';

import { WidgetCard, WIDGET_DRAG_CANCEL_CLASS, WIDGET_DRAG_HANDLE_CLASS } from './WidgetCard';

/**
 * `WidgetPlacement[]` → react-grid-layout items.
 *
 * The two models already agree field for field — `x`/`y`/`w`/`h` are grid
 * units on both sides — so this only renames `id` to `i` and attaches the
 * per-type minimums, which makes RGL refuse to shrink a widget past what
 * `WidgetPlacementSchema` accepts rather than letting the PUT 400.
 *
 * Exported and unit-tested directly: jsdom has no layout, so an RGL drag
 * resolves every pixel delta to zero and cannot exercise this through the DOM.
 */
export function toGridLayout(widgets: WidgetPlacement[]): LayoutItem[] {
  return widgets.map((widget) => {
    const min = PerWidgetMinSize[widget.type];
    return {
      i: widget.id,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      minW: min.w,
      minH: min.h,
      // Mirrors the schema's `h <= GRID_MAX_ROWS`. A per-item cap, not a canvas
      // one — see GRID_CONFIG on why `maxRows` is left unset.
      maxH: GRID_MAX_ROWS,
    };
  });
}

/**
 * react-grid-layout items → `WidgetPlacement[]`.
 *
 * An RGL item carries geometry and nothing else, so `type` and `config` come
 * from the matching widget. Items with no match are dropped: RGL's internal
 * layout can still hold an entry for a widget that has just been removed, and
 * a placement with no `type` fails `WidgetPlacementSchema` on the write.
 */
export function fromGridLayout(layout: Layout, widgets: WidgetPlacement[]): WidgetPlacement[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const next: WidgetPlacement[] = [];
  for (const item of layout) {
    const widget = byId.get(item.i);
    if (!widget) continue;
    next.push({ ...widget, x: item.x, y: item.y, w: item.w, h: item.h });
  }
  return next;
}

/**
 * Free placement.
 *
 * RGL v2 replaced v1's `compactType` / `preventCollision` / `allowOverlap`
 * triple with a single `Compactor` object. `noCompactor` is
 * `{ type: null, allowOverlap: false }` with `preventCollision` left unset —
 * exactly v1's `compactType={null} preventCollision={false}
 * allowOverlap={false}`. So a widget dropped into empty space below the layout
 * stays where it was dropped instead of floating up, while a widget dropped
 * onto another still pushes that one out of the way.
 *
 * Overlap must never be allowed: the server rejects overlapping layouts
 * (`checkNoOverlap` in `PutDashboardLayoutRequestSchema`) and the write 400s.
 */
const COMPACTOR = noCompactor;

export const GRID_CONFIG: GridLayoutProps['gridConfig'] = {
  cols: GRID_COLUMNS,
  rowHeight: GRID_ROW_HEIGHT_PX,
  // `maxRows` is deliberately NOT set to GRID_MAX_ROWS. The schema caps a
  // widget's HEIGHT at 24 rows and leaves `y` unbounded; RGL's `maxRows` is a
  // whole-canvas ceiling that clamps `y <= maxRows - h`. Setting it would box
  // free placement into 24 rows total, and the default layout already reaches
  // row 20 — leaving four rows of headroom on a canvas meant to be open. The
  // per-widget cap is expressed as `maxH` on each item instead (toGridLayout).
  margin: [GRID_GAP_PX, GRID_GAP_PX],
  // RGL defaults container padding to `margin`, which would inset the whole
  // canvas by a gutter and break its alignment with the header above it.
  containerPadding: [0, 0],
};

const DRAG_CONFIG: GridLayoutProps['dragConfig'] = {
  enabled: true,
  handle: `.${WIDGET_DRAG_HANDLE_CLASS}`,
  // RGL already prepends `.react-resizable-handle`; this adds the header's
  // overflow menu, so opening the menu never arms a drag.
  cancel: `.${WIDGET_DRAG_CANCEL_CLASS}`,
};

/**
 * Seven handles, as the bespoke implementation had (Req 4.6.2), and there is
 * still deliberately no `n`: the whole header is the drag zone, and a
 * full-width resize strip along its top edge would swallow the start of every
 * drag. The two top corners are small enough to coexist with it.
 */
const RESIZE_CONFIG: GridLayoutProps['resizeConfig'] = {
  enabled: true,
  handles: ['s', 'w', 'e', 'sw', 'se', 'nw', 'ne'],
};

export interface DashboardGridProps {
  widgets: WidgetPlacement[];
  onRemove: (id: string) => void;
  /**
   * Called with the next `widgets[]` after a drag-end or resize-end. The route
   * is expected to debounce the persistence write (300ms).
   */
  scheduleLayoutWrite: (next: WidgetPlacement[]) => void;
  /**
   * Per-widget config update (e.g. PerformanceChartWidget timeframe change).
   * The route merges the partial config into the matching widget and schedules
   * a debounced layout write.
   */
  onUpdateConfig?: (widgetId: string, config: Record<string, unknown>) => void;
}

interface MediaState {
  isMobile: boolean;
  hasFinePointer: boolean;
}

function readMediaState(): MediaState {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { isMobile: false, hasFinePointer: true };
  }
  const belowMd = window.matchMedia('(max-width: 767px)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const anyFine = window.matchMedia('(any-pointer: fine)').matches;
  return {
    isMobile: belowMd || coarse,
    hasFinePointer: anyFine,
  };
}

interface WidgetGridCellProps {
  widget: WidgetPlacement;
  onRemove: (id: string) => void;
  onUpdateConfig?: (widgetId: string, config: Record<string, unknown>) => void;
  /** RGL clones each child to inject these; they must land on the DOM node. */
  ref?: React.Ref<HTMLDivElement>;
  className?: string;
  style?: React.CSSProperties;
  /** RGL/react-resizable append the resize handles here. */
  children?: React.ReactNode;
}

/**
 * One grid item. RGL positions this element itself — it clones the child to
 * attach `.react-grid-item`, the transform/size style, the drag ref and the
 * resize handles — so the cell's only job is to pass those through and render
 * the card.
 */
function WidgetGridCell({
  widget,
  onRemove,
  onUpdateConfig,
  ref,
  className,
  style,
  children,
}: WidgetGridCellProps): ReactElement {
  // Stable identity per widget. A widget's config fix-up effect (§K) lists its
  // `onUpdateConfig` in its dependency array, so an inline arrow here re-runs
  // that effect on EVERY render of the grid — each one re-queueing a layout
  // write and extending the window in which a pending write can clobber an
  // unrelated edit.
  const boundUpdateConfig = useMemo(
    () =>
      onUpdateConfig
        ? (config: Record<string, unknown>) => onUpdateConfig(widget.id, config)
        : undefined,
    [onUpdateConfig, widget.id],
  );

  return (
    <div ref={ref} className={className} style={style} data-widget-id={widget.id}>
      <WidgetCard
        widget={widget}
        onRemove={onRemove}
        onUpdateConfig={boundUpdateConfig}
        draggable
      />
      {children}
    </div>
  );
}

export function DashboardGrid({
  widgets,
  onRemove,
  scheduleLayoutWrite,
  onUpdateConfig,
}: DashboardGridProps): ReactElement {
  const [media, setMedia] = useState<MediaState>(() => readMediaState());

  // RGL v2 dropped the `WidthProvider` HOC from the package entry point in
  // favour of this hook, which owns the ResizeObserver. Attaching its ref to
  // the wrapper is what makes the grid reflow when the sidebar collapses or
  // the window resizes (Req 4.12).
  const { width, containerRef } = useContainerWidth();

  // Local echo of the persisted layout. `scheduleLayoutWrite` debounces the
  // PUT by 300ms and the query cache only updates once that fires, so without
  // this the widget would snap back to its old cell for a third of a second
  // after every drop. Server responses and error rollbacks both arrive as a
  // new `widgets` prop, which resets the echo.
  const [localWidgets, setLocalWidgets] = useState<WidgetPlacement[]>(widgets);
  useEffect(() => {
    setLocalWidgets(widgets);
  }, [widgets]);

  // RGL's callbacks are memoised against their own deps, so they can outlive a
  // render of this component; read the echo through a ref rather than a
  // closure to keep `type` and `config` current.
  const localWidgetsRef = useRef(localWidgets);
  localWidgetsRef.current = localWidgets;

  // Re-read media state on changes. Listen on the three queries we care about.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const queries = ['(max-width: 767px)', '(pointer: coarse)', '(any-pointer: fine)'];
    const handlers: Array<{ mql: MediaQueryList; fn: () => void }> = [];
    for (const q of queries) {
      const mql = window.matchMedia(q);
      const fn = (): void => setMedia(readMediaState());
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', fn);
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(fn);
      }
      handlers.push({ mql, fn });
    }
    return () => {
      for (const { mql, fn } of handlers) {
        if (typeof mql.removeEventListener === 'function') {
          mql.removeEventListener('change', fn);
        } else if (typeof mql.removeListener === 'function') {
          mql.removeListener(fn);
        }
      }
    };
  }, []);

  const gridLayout = useMemo(() => toGridLayout(localWidgets), [localWidgets]);
  const sortedForMobile = useMemo(() => sortByYThenX(localWidgets), [localWidgets]);

  /**
   * Armed by a completed gesture, consumed by the next `onLayoutChange`.
   *
   * RGL calls `onLayoutChange` on mount — its internal layout never
   * deep-equals the `layout` prop it was handed, because it fills in per-item
   * defaults first — so an unguarded write from there would PUT on every
   * single dashboard visit.
   */
  const gestureCompletedRef = useRef(false);

  // The write path. `onDragStop` / `onResizeStop` each fire exactly once per
  // gesture, with the final layout, and before `onLayoutChange` — so this is
  // one write per gesture, and none for a mount or a prop-driven resync.
  const commitLayout = useCallback(
    (layout: Layout): void => {
      gestureCompletedRef.current = true;
      const next = fromGridLayout(layout, localWidgetsRef.current);
      setLocalWidgets(next);
      scheduleLayoutWrite(next);
    },
    [scheduleLayoutWrite],
  );

  // Never writes — it only re-syncs the echo with any correction RGL applied
  // on top of the committed layout, and only when a gesture actually happened.
  const handleLayoutChange = useCallback((layout: Layout): void => {
    if (!gestureCompletedRef.current) return;
    gestureCompletedRef.current = false;
    setLocalWidgets(fromGridLayout(layout, localWidgetsRef.current));
  }, []);

  // Mobile fallback (Req 4.9): single-column stack, drag/resize disabled.
  if (media.isMobile) {
    return (
      <div className="flex w-full flex-col gap-4" data-grid-mode="mobile">
        <span id="dashboard-grid-mobile-instructions" className="sr-only">
          Reorder requires a pointer-fine device
        </span>
        {sortedForMobile.map((widget) => (
          <div
            key={widget.id}
            aria-disabled="true"
            aria-describedby="dashboard-grid-mobile-instructions"
            data-widget-id={widget.id}
            className="w-full"
          >
            <WidgetCard
              widget={widget}
              onRemove={onRemove}
              onUpdateConfig={
                onUpdateConfig ? (config) => onUpdateConfig(widget.id, config) : undefined
              }
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} data-grid-mode="grid" className="w-full">
      <GridLayout
        width={width}
        layout={gridLayout}
        gridConfig={GRID_CONFIG}
        dragConfig={DRAG_CONFIG}
        resizeConfig={RESIZE_CONFIG}
        compactor={COMPACTOR}
        onLayoutChange={handleLayoutChange}
        onDragStop={commitLayout}
        onResizeStop={commitLayout}
      >
        {localWidgets.map((widget) => (
          <WidgetGridCell
            key={widget.id}
            widget={widget}
            onRemove={onRemove}
            onUpdateConfig={onUpdateConfig}
          />
        ))}
      </GridLayout>
    </div>
  );
}

export default DashboardGrid;
