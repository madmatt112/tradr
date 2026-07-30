import 'gridstack/dist/gridstack.css';

import {
  GridStack,
  type GridItemHTMLElement,
  type GridStackOptions,
  type GridStackWidget,
} from 'gridstack';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { PerWidgetMinSize, type WidgetPlacement } from '@tradr/shared/schemas/dashboard';

import { GRID_COLUMNS, GRID_GAP_PX, GRID_MAX_ROWS, GRID_ROW_HEIGHT_PX } from '../grid.constants';
import { sortByYThenX } from '../layout';

import { WidgetCard, WIDGET_DRAG_CANCEL_CLASS, WIDGET_DRAG_HANDLE_CLASS } from './WidgetCard';

/** A gridstack widget descriptor that is guaranteed to carry its `id`. */
type IdentifiedGridWidget = GridStackWidget & { id: string };

/**
 * `WidgetPlacement[]` → gridstack widget descriptors.
 *
 * The two models already agree field for field — `x`/`y`/`w`/`h` are grid units
 * on both sides — so this only attaches the per-type minimums, which makes
 * gridstack refuse to shrink a widget past what `WidgetPlacementSchema` accepts
 * rather than letting the PUT 400.
 *
 * Exported and unit-tested directly: jsdom has no layout, so a gridstack drag
 * resolves every pixel delta to zero and cannot exercise this through the DOM.
 */
export function toGridWidgets(widgets: WidgetPlacement[]): IdentifiedGridWidget[] {
  return widgets.map((widget) => {
    const min = PerWidgetMinSize[widget.type];
    return {
      id: widget.id,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      minW: min.w,
      minH: min.h,
      // Mirrors the schema's `h <= GRID_MAX_ROWS`. A per-item cap, not a canvas
      // one — see `createGridOptions` on why `maxRow` is left unset.
      maxH: GRID_MAX_ROWS,
    };
  });
}

/**
 * gridstack nodes (as returned by `grid.save(false)`) → `WidgetPlacement[]`.
 *
 * A gridstack node carries geometry and nothing else we persist, so `type` and
 * `config` come from the matching widget. Nodes with no match are dropped: the
 * grid can still hold an entry for a widget that has just been removed, and a
 * placement with no `type` fails `WidgetPlacementSchema` on the write.
 *
 * Geometry is defaulted the way gridstack itself defaults it (`x`/`y` to 0,
 * `w`/`h` to 1) — it omits `w`/`h` from a node once they are 1.
 */
export function fromGridWidgets(
  nodes: GridStackWidget[],
  widgets: WidgetPlacement[],
): WidgetPlacement[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const next: WidgetPlacement[] = [];
  for (const node of nodes) {
    const widget = node.id === undefined ? undefined : byId.get(node.id);
    if (!widget) continue;
    next.push({ ...widget, x: node.x ?? 0, y: node.y ?? 0, w: node.w ?? 1, h: node.h ?? 1 });
  }
  return next;
}

/**
 * Seven handles, as the bespoke implementation had (Req 4.6.2), and there is
 * still deliberately no `n`: the whole header is the drag zone, and a
 * full-width resize strip along its top edge would swallow the start of every
 * drag. The two top corners are small enough to coexist with it.
 */
const RESIZE_HANDLES = 'e,se,s,sw,w,ne,nw';

/**
 * gridstack's `margin` is an inset applied to EACH SIDE of every item, so the
 * gutter a user sees between two neighbours is `2 * margin`. `GRID_GAP_PX` is
 * that visible gutter, so the option is half of it — 8, not 16. Passing 16
 * would render every gutter at 32px.
 */
const GRID_MARGIN_PX = GRID_GAP_PX / 2;

/**
 * gridstack's own built-in "never start a drag from here" list. Supplying
 * `cancel` REPLACES it rather than extending it, so it is repeated here.
 */
const DRAG_CANCEL_BUILTIN = 'input,textarea,button,select,option';

/**
 * Built fresh per grid, because `GridStack.init` MUTATES the options object it
 * is handed (it fills in defaults and splits `margin` into four sides). A
 * shared module constant would be rewritten by the first init and reused in
 * that state by the next — which a StrictMode double-mount guarantees there is.
 *
 * Exported so the unit tests assert the configuration rather than the pixels.
 */
export function createGridOptions(): GridStackOptions {
  return {
    column: GRID_COLUMNS,
    cellHeight: GRID_ROW_HEIGHT_PX,
    margin: GRID_MARGIN_PX,
    // Free placement: a widget dropped into empty space below the layout stays
    // where it was dropped instead of floating up to the first gap, while a
    // widget dropped onto another still pushes that one out of the way.
    // Overlap is never produced — the server rejects overlapping layouts
    // (`checkNoOverlap` in `PutDashboardLayoutRequestSchema`) and the write
    // would 400.
    float: true,
    handle: `.${WIDGET_DRAG_HANDLE_CLASS}`,
    // The header's overflow menu sits inside the drag zone; without this,
    // opening the menu would also arm a drag.
    draggable: { cancel: `${DRAG_CANCEL_BUILTIN},.${WIDGET_DRAG_CANCEL_CLASS}` },
    resizable: { handles: RESIZE_HANDLES },
    // gridstack hides the resize handles until hover; keep them visible, as the
    // previous grid did.
    alwaysShowResizeHandle: true,
    // `maxRow` is deliberately NOT set. The schema caps a widget's HEIGHT at
    // GRID_MAX_ROWS and leaves `y` unbounded; gridstack's `maxRow` is a
    // whole-canvas ceiling. Setting it would box free placement into 24 rows
    // total, and the default layout already reaches row 20 — leaving four rows
    // of headroom on a canvas meant to be open. The per-widget cap is expressed
    // as `maxH` on each item instead (`toGridWidgets`).
  };
}

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

interface WidgetPortalProps {
  grid: GridStack;
  /** The `.grid-stack-item-content` element gridstack created for this widget. */
  host: HTMLElement;
  widget: WidgetPlacement;
  onRemove: (id: string) => void;
  onUpdateConfig?: (widgetId: string, config: Record<string, unknown>) => void;
}

/**
 * One widget's React tree, rendered into the `.grid-stack-item-content` element
 * gridstack made for it.
 *
 * The portal IS the ownership boundary. gridstack owns `.grid-stack-item` and
 * its direct children — it creates them, positions them (inline `top`/`left`/
 * `width`/`height` plus `gs-*` attributes) and appends the resize handles as
 * siblings of the content div. React owns everything *inside*
 * `.grid-stack-item-content` and never touches the item element itself, so the
 * two never patch the same node.
 */
function WidgetPortal({
  grid,
  host,
  widget,
  onRemove,
  onUpdateConfig,
}: WidgetPortalProps): ReactElement {
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

  // The drag handle is rendered by this portal, so it does not exist yet when
  // gridstack wires the item up for drag & drop and its `handle` selector finds
  // nothing. Re-scan once the card is committed to the DOM.
  useEffect(() => {
    const item = host.parentElement;
    if (item) grid.refreshDragHandles(item);
  }, [grid, host]);

  return createPortal(
    <WidgetCard widget={widget} onRemove={onRemove} onUpdateConfig={boundUpdateConfig} draggable />,
    host,
    widget.id,
  );
}

const NO_HOSTS: ReadonlyMap<string, HTMLElement> = new Map();

/**
 * The gridstack canvas. Mounted only on a fine-pointer, ≥ md viewport — the
 * mobile fallback below renders no grid at all (Req 4.9).
 */
function DashboardGridCanvas({
  widgets,
  onRemove,
  scheduleLayoutWrite,
  onUpdateConfig,
}: DashboardGridProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState<GridStack | null>(null);
  /**
   * Portal targets, by widget id. State rather than a ref because the elements
   * only exist once the sync effect below has created them, which is one commit
   * later than the render that asked for them.
   */
  const [contentHosts, setContentHosts] = useState<ReadonlyMap<string, HTMLElement>>(NO_HOSTS);

  // gridstack reports geometry only, so `type` and `config` are read back from
  // here when a gesture completes. Refs because the gridstack callbacks are
  // registered once, at init, and would otherwise close over a stale render.
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const scheduleLayoutWriteRef = useRef(scheduleLayoutWrite);
  scheduleLayoutWriteRef.current = scheduleLayoutWrite;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const instance = GridStack.init(createGridOptions(), root);
    if (!instance) return;

    /**
     * The ONLY write path. `dragstop` and `resizestop` fire exactly once per
     * completed gesture, after gridstack has written the settled geometry back
     * to its engine — including any neighbour the gesture pushed.
     *
     * Nothing else writes. `added` and `change` also fire while the grid is
     * being populated (init, and every `addWidget` in the sync effect below),
     * so a write from there would PUT on every single dashboard visit.
     */
    const commit = (): void => {
      const nodes = instance.save(false, false, (node, saved) => {
        // `save` drops `w`/`h` from a node whenever they equal 1 OR the item's
        // own `minW`/`minH` — which every widget sitting at its minimum does.
        // Put them back, or the placement we persist silently shrinks to 1x1.
        saved.w = node.w;
        saved.h = node.h;
      }) as GridStackWidget[];
      scheduleLayoutWriteRef.current(fromGridWidgets(nodes, widgetsRef.current));
    };
    instance.on('dragstop', commit);
    instance.on('resizestop', commit);
    setGrid(instance);

    return () => {
      instance.offAll();
      // gridstack created every `.grid-stack-item`, so gridstack removes them…
      instance.removeAll(true, false);
      // …but not the root element: React owns that one.
      instance.destroy(false);
      setGrid(null);
      setContentHosts(NO_HOSTS);
    };
  }, []);

  // Reconcile gridstack with the persisted layout: add widgets that appeared,
  // remove widgets that went, and push geometry back only where it actually
  // differs. After a gesture the route echoes our own placements back as
  // `widgets`, so the common case is a no-op; a failed PUT rolls the query
  // cache back and this is what returns the widget to where it was.
  useEffect(() => {
    if (!grid) return;
    const desired = toGridWidgets(widgets);
    const desiredIds = new Set(desired.map((widget) => widget.id));

    const existing = new Map<string, GridItemHTMLElement>();
    for (const el of grid.getGridItems()) {
      const id = el.gridstackNode?.id;
      if (id !== undefined) existing.set(id, el);
    }

    let membershipChanged = false;
    grid.batchUpdate();
    try {
      for (const [id, el] of existing) {
        if (desiredIds.has(id)) continue;
        grid.removeWidget(el, true, false);
        existing.delete(id);
        membershipChanged = true;
      }
      for (const widget of desired) {
        const el = existing.get(widget.id);
        if (!el) {
          // No `content`: gridstack 13 escapes that string, and the content is
          // React's anyway. It only has to create the empty item + content divs.
          const created = grid.addWidget(widget);
          if (created) {
            created.setAttribute('data-widget-id', widget.id);
            existing.set(widget.id, created);
            membershipChanged = true;
          }
          continue;
        }
        const node = el.gridstackNode;
        if (
          node &&
          (node.x !== widget.x || node.y !== widget.y || node.w !== widget.w || node.h !== widget.h)
        ) {
          grid.update(el, { x: widget.x, y: widget.y, w: widget.w, h: widget.h });
        }
      }
    } finally {
      grid.batchUpdate(false);
    }

    // Only re-render the portals when the item elements themselves changed.
    if (!membershipChanged) return;
    const hosts = new Map<string, HTMLElement>();
    for (const [id, el] of existing) {
      const content = el.querySelector<HTMLElement>('.grid-stack-item-content');
      if (content) hosts.set(id, content);
    }
    setContentHosts(hosts);
  }, [grid, widgets]);

  return (
    <div data-grid-mode="grid" className="w-full">
      <div ref={rootRef} className="grid-stack" />
      {grid
        ? widgets.map((widget) => {
            const host = contentHosts.get(widget.id);
            if (!host) return null;
            return (
              <WidgetPortal
                key={widget.id}
                grid={grid}
                host={host}
                widget={widget}
                onRemove={onRemove}
                onUpdateConfig={onUpdateConfig}
              />
            );
          })
        : null}
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

  const sortedForMobile = useMemo(() => sortByYThenX(widgets), [widgets]);

  // Mobile fallback (Req 4.9): single-column stack, drag/resize disabled and no
  // gridstack instance at all.
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
    <DashboardGridCanvas
      widgets={widgets}
      onRemove={onRemove}
      scheduleLayoutWrite={scheduleLayoutWrite}
      onUpdateConfig={onUpdateConfig}
    />
  );
}

export default DashboardGrid;
