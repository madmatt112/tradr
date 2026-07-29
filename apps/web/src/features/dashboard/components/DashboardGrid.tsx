import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { WidgetPlacement } from '@tradr/shared';

import { GRID_COLUMNS, GRID_ROW_HEIGHT_PX } from '../grid.constants';
import { findFirstSlot, repackLayout, sortByYThenX } from '../layout';
import type { GridRect } from '../resize';
import { widgetRegistry } from '../widgets/registry';

import { WidgetCard } from './WidgetCard';

/**
 * Pure helper extracted for unit testing (Task 36.2 case 5 / v3-7 / v4-4).
 *
 * Moves `activeId` into `overId`'s place in reading order — top-to-bottom then
 * left-to-right — and re-packs the layout from that new order. Each widget
 * keeps its own `w`/`h`; only the cell origins move.
 *
 * Re-packing rather than swapping `(x, y)` outright is what keeps the result
 * overlap-free when the two widgets are different sizes. A bare position swap
 * of, say, a 12×1 widget and a 6×2 widget produces an overlapping layout,
 * which the server rejects (`checkNoOverlap` in
 * `PutDashboardLayoutRequestSchema`) and the client then rolls back. For
 * equal-sized widgets the two are the same operation — the pair trades slots.
 */
export function applyDragEnd(
  prev: WidgetPlacement[],
  activeId: string,
  overId: string,
): WidgetPlacement[] {
  if (activeId === overId) return prev;
  const ordered = sortByYThenX(prev);
  const from = ordered.findIndex((w) => w.id === activeId);
  const to = ordered.findIndex((w) => w.id === overId);
  if (from === -1 || to === -1) return prev;
  return repackLayout(arrayMove(ordered, from, to));
}

/**
 * Applies a new grid rect to one widget and reflows the rest around it
 * (Req 4.6.5).
 *
 * The resized widget is pinned at the rect the gesture resolved — position
 * included, since dragging a left edge or a top corner moves the origin as
 * well as the span — and every other widget is re-packed around it in reading
 * order. Growing therefore pushes neighbors down and along, and shrinking lets
 * them close the gap. Reflowing rather than clamping at the boundary is what
 * makes resize usable at all: a full 12-column layout leaves no free cell, so
 * a clamp-only rule blocks every outward drag.
 */
export function applyResize(
  prev: WidgetPlacement[],
  id: string,
  rect: GridRect,
): WidgetPlacement[] {
  const target = prev.find((w) => w.id === id);
  if (!target) return prev;
  if (target.x === rect.x && target.y === rect.y && target.w === rect.w && target.h === rect.h) {
    return prev;
  }
  const placed: WidgetPlacement[] = [{ ...target, ...rect }];
  for (const widget of sortByYThenX(prev.filter((w) => w.id !== id))) {
    const { x, y } = findFirstSlot(placed, { w: widget.w, h: widget.h });
    placed.push({ ...widget, x, y });
  }
  return placed;
}

/**
 * Builds the four dnd-kit announcement strings per Req 4.11.1.
 * Exported pure for unit testing — the strings are VERBATIM.
 */
export function buildAnnouncements(
  widgets: WidgetPlacement[],
  displayNameLookup: (type: WidgetPlacement['type']) => string,
): Announcements {
  const displayNameFor = (id: string | null): string => {
    if (!id) return '';
    const w = widgets.find((x) => x.id === id);
    if (!w) return '';
    return displayNameLookup(w.type);
  };
  const positionFor = (id: string | null): { x: number; y: number } => {
    if (!id) return { x: 0, y: 0 };
    const w = widgets.find((x) => x.id === id);
    if (!w) return { x: 0, y: 0 };
    return { x: w.x, y: w.y };
  };
  return {
    onDragStart: ({ active }) => {
      const name = displayNameFor(String(active.id));
      const { x, y } = positionFor(String(active.id));
      return `Picked up ${name} at column ${x}, row ${y}.`;
    },
    onDragOver: ({ active, over }) => {
      const name = displayNameFor(String(active.id));
      const overPos = positionFor(over ? String(over.id) : null);
      return `${name} is over column ${overPos.x}, row ${overPos.y}.`;
    },
    onDragEnd: ({ active, over }) => {
      const name = displayNameFor(String(active.id));
      const overPos = positionFor(over ? String(over.id) : String(active.id));
      return `${name} dropped at column ${overPos.x}, row ${overPos.y}.`;
    },
    onDragCancel: ({ active }) => {
      const name = displayNameFor(String(active.id));
      return `Picking up ${name} was cancelled.`;
    },
  };
}

export interface DashboardGridProps {
  widgets: WidgetPlacement[];
  onRemove: (id: string) => void;
  /**
   * Called with the next `widgets[]` after a drag-end or resize. The route is
   * expected to debounce the persistence write (300ms).
   */
  scheduleLayoutWrite: (next: WidgetPlacement[]) => void;
  /**
   * Per-widget config update (e.g. PerformanceChartWidget timeframe change).
   * The route merges the partial config into the matching widget and
   * schedules a debounced layout write.
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

/**
 * The empty cell outlines shown behind the widgets while a drag or resize is
 * in flight, so the 12-column grid the gesture snaps to is visible.
 *
 * Each cell is placed into a grid area so it lines up with the real,
 * content-sized rows, but is **absolutely positioned** so it takes no part in
 * track sizing. That distinction is load-bearing, not stylistic. As in-flow
 * items these were single-row spans, which gives every row track a finite
 * growth limit; without them the tracks that a multi-row widget spans have an
 * infinite growth limit, and CSS Grid distributes that widget's height across
 * its tracks differently in the two cases. A short widget sharing rows with a
 * tall neighbour therefore grew the instant edit mode turned on — measured at
 * 176px → 281px for an 8x2 beside a 3-row 430px widget, back to 176px once
 * absolutely positioned.
 *
 * That reflow also broke dropping: dnd-kit measures droppable rects when the
 * drag begins, so a layout that shifts as edit mode engages leaves every rect
 * stale and the drop resolves against the wrong geometry.
 *
 * Cells cover only rows the layout already occupies — a spare row would resize
 * the container mid-gesture and shift every drop target for the same reason.
 */
function GridBackdrop({ rows }: { rows: number }): ReactElement {
  return (
    <>
      {Array.from({ length: rows * GRID_COLUMNS }, (_, i) => (
        <div
          key={`backdrop-${i}`}
          aria-hidden="true"
          data-grid-backdrop-cell="true"
          className="pointer-events-none absolute inset-0 rounded-sm border border-dashed border-muted-foreground/35 bg-muted-foreground/[0.07]"
          style={{
            gridColumn: `${(i % GRID_COLUMNS) + 1} / span 1`,
            gridRow: `${Math.floor(i / GRID_COLUMNS) + 1} / span 1`,
          }}
        />
      ))}
    </>
  );
}

interface SortableWidgetCellProps {
  widget: WidgetPlacement;
  isDropTarget: boolean;
  onRemove: (id: string) => void;
  onResize: (id: string, rect: GridRect) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
  /** Fired the instant the drag zone is pressed, before dnd-kit activates. */
  onDragPress: () => void;
  onUpdateConfig?: (widgetId: string, config: Record<string, unknown>) => void;
}

/**
 * One grid cell. Owns the dnd-kit `useSortable` registration (Req 4.6.1 —
 * `useSortable` composes `useDraggable` + `useDroppable`) and threads the
 * activator props down into `<WidgetCard>`'s drag handle, which stays
 * presentational per design 9.3.
 *
 * The sortable `transform` is deliberately NOT applied to the cell. Widgets
 * have heterogeneous spans, so a live shuffle preview reflows unpredictably;
 * the `<DragOverlay>` snapshot plus a drop-target ring is the readable
 * feedback. The authoritative placement is computed once, on drop.
 */
function SortableWidgetCell({
  widget,
  isDropTarget,
  onRemove,
  onResize,
  onResizeStart,
  onResizeEnd,
  onDragPress,
  onUpdateConfig,
}: SortableWidgetCellProps): ReactElement {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: widget.id,
  });

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

  // dnd-kit does not report a drag until the PointerSensor's 4px activation
  // distance is met, so the edit state would otherwise only appear once the
  // widget was already moving. Announce the press first, then hand the event on.
  const dragHandleProps = {
    ...attributes,
    ...listeners,
    ref: setActivatorNodeRef,
    onPointerDown: (event: React.PointerEvent<Element>) => {
      onDragPress();
      listeners?.onPointerDown?.(event);
    },
  };

  return (
    <div
      ref={setNodeRef}
      data-widget-id={widget.id}
      data-drop-target={isDropTarget ? 'true' : undefined}
      className={isDropTarget ? 'rounded-md outline-2 outline-offset-2 outline-ring' : undefined}
      style={{
        gridColumn: `${widget.x + 1} / span ${widget.w}`,
        gridRow: `${widget.y + 1} / span ${widget.h}`,
        // The DragOverlay carries the moving snapshot (Req 4.6.4); the source
        // cell just dims so the drop target stays readable underneath.
        opacity: isDragging ? 0.4 : undefined,
      }}
    >
      <WidgetCard
        widget={widget}
        onRemove={onRemove}
        onResize={(rect) => onResize(widget.id, rect)}
        onResizeStart={onResizeStart}
        onResizeEnd={onResizeEnd}
        onUpdateConfig={boundUpdateConfig}
        dragHandleProps={dragHandleProps}
      />
    </div>
  );
}

export function DashboardGrid({
  widgets,
  onRemove,
  scheduleLayoutWrite,
  onUpdateConfig,
}: DashboardGridProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [media, setMedia] = useState<MediaState>(() => readMediaState());

  // A press that never becomes a drag still has to end. The release can land
  // anywhere — outside the handle, outside the window — so it is watched
  // globally rather than on the element that was pressed. This also backstops
  // the resize gesture on any browser lacking pointer capture, which would
  // otherwise strand the edit state on.
  useEffect(() => {
    if (!isPressing && !isResizing) return;
    const release = (): void => {
      setIsPressing(false);
      setIsResizing(false);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [isPressing, isResizing]);

  // Local echo of the persisted layout. `scheduleLayoutWrite` debounces the
  // PUT by 300ms and the query cache only updates once that fires, so without
  // this the widget would snap back to its old cell for a third of a second
  // after every drop, and the resize gesture would have no live feedback.
  // Server responses and error rollbacks both arrive as a new `widgets` prop,
  // which resets the echo.
  const [localWidgets, setLocalWidgets] = useState<WidgetPlacement[]>(widgets);
  useEffect(() => {
    setLocalWidgets(widgets);
  }, [widgets]);

  const commit = useCallback(
    (next: WidgetPlacement[]) => {
      setLocalWidgets(next);
      scheduleLayoutWrite(next);
    },
    [scheduleLayoutWrite],
  );

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

  // ResizeObserver on the grid container — recompute dnd-kit's coordinate
  // system on width change (Req 4.12). dnd-kit's measuringConfiguration
  // re-runs `getBoundingClientRect()` lazily on the next drag; we force an
  // explicit measurement by bumping a state key on width change so
  // SortableContext re-renders with fresh node layouts.
  const [measureKey, setMeasureKey] = useState(0);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let lastWidth = node.clientWidth;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width !== lastWidth) {
          lastWidth = width;
          setMeasureKey((k) => k + 1);
        }
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const sortedForMobile = useMemo(() => sortByYThenX(localWidgets), [localWidgets]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements = useMemo(
    () => buildAnnouncements(localWidgets, (type) => widgetRegistry[type].displayName),
    [localWidgets],
  );

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent): void {
    setOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveId(null);
    setOverId(null);
    const { active, over } = event;
    if (!over) return;
    const next = applyDragEnd(localWidgets, String(active.id), String(over.id));
    if (next !== localWidgets) {
      commit(next);
    }
  }

  function handleDragCancel(): void {
    setActiveId(null);
    setOverId(null);
  }

  const handleResize = useCallback(
    (id: string, rect: GridRect) => {
      const next = applyResize(localWidgets, id, rect);
      if (next !== localWidgets) {
        commit(next);
      }
    },
    [commit, localWidgets],
  );

  const activeWidget = activeId ? (localWidgets.find((w) => w.id === activeId) ?? null) : null;

  // Show the cell grid while a gesture is in flight (Req 4.6.6) — from the
  // moment a handle is pressed, not from the moment the widget starts moving.
  const isEditing = activeId !== null || isResizing || isPressing;
  const occupiedRows = localWidgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);

  // Mobile fallback (Req 4.9): single-column stack, drag/resize disabled.
  if (media.isMobile) {
    return (
      <div ref={containerRef} className="flex w-full flex-col gap-4" data-grid-mode="mobile">
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
    <DndContext
      sensors={sensors}
      accessibility={{ announcements }}
      // dnd-kit's default measures droppable rects once, when the drag begins.
      // Anything that reflows the grid after that point — the edit wash turning
      // on, a row band resizing, the sidebar collapsing — leaves every rect
      // stale, and the drop then resolves against geometry the user cannot see,
      // landing on the wrong widget or on nothing at all. Re-measuring keeps
      // the collision rects honest; n <= 6 widgets makes the cost negligible.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={localWidgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div
          ref={containerRef}
          data-measure-key={measureKey}
          data-grid-mode="grid"
          data-editing={isEditing ? 'true' : undefined}
          // The edit wash reads in the gutters between widgets and in the
          // outline standing off the whole grid, because the backdrop cells
          // themselves are covered wherever a widget sits. `outline` is used
          // rather than a border so nothing reflows when the mode turns on.
          // `relative` makes this the containing block for the absolutely
          // positioned backdrop cells, so each resolves against its grid area.
          className={`relative grid w-full gap-4 rounded-lg transition-colors ${
            isEditing
              ? 'bg-muted/60 outline-2 outline-dashed outline-offset-8 outline-muted-foreground/30'
              : ''
          }`}
          style={{
            gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
            // Content-aware rows: at least GRID_ROW_HEIGHT_PX, growing to fit
            // whatever the tallest widget in the band renders, so nothing is
            // clipped or forced to scroll internally. `h` is therefore a row
            // MINIMUM, not an exact height. Widgets sharing a row band share
            // its height — which is why DEFAULT_WIDGETS pairs each chart with
            // a rail widget of the same row span.
            gridAutoRows: `minmax(${GRID_ROW_HEIGHT_PX}px, auto)`,
          }}
        >
          {/* First in DOM order so the widgets paint over the outlines. */}
          {isEditing ? <GridBackdrop rows={occupiedRows} /> : null}
          {localWidgets.map((widget) => (
            <SortableWidgetCell
              key={widget.id}
              widget={widget}
              isDropTarget={overId === widget.id && activeId !== widget.id}
              onRemove={onRemove}
              onResize={handleResize}
              onResizeStart={() => setIsResizing(true)}
              onResizeEnd={() => setIsResizing(false)}
              onDragPress={() => setIsPressing(true)}
              onUpdateConfig={onUpdateConfig}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeWidget ? (
          <div data-drag-overlay="true" data-active-widget-id={activeWidget.id}>
            <WidgetCard
              widget={activeWidget}
              onRemove={() => undefined}
              // Empty activator props: the snapshot keeps the live handle
              // styling but carries no listeners of its own.
              dragHandleProps={{}}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default DashboardGrid;
