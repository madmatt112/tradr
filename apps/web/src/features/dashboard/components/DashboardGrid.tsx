
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import type { WidgetPlacement } from '@tradr/shared';

import { GRID_COLUMNS } from '../grid.constants';
import { widgetRegistry } from '../widgets/registry';

import { WidgetCard } from './WidgetCard';

/**
 * Pure helper extracted for unit testing (Task 36.2 case 5 / v3-7 / v4-4).
 *
 * Moves `activeId` to `overId`'s slot and shifts the displaced widget into
 * the active widget's previous slot. All other widgets are unchanged.
 *
 * The position semantics swap `(x, y)` between the two widgets — width/height
 * are preserved on each widget; only their cell origins swap. This is the
 * common "two-widget swap" behaviour for a grid sort and is the minimum
 * regression surface the v3-7 case exists to pin.
 */
export function applyDragEnd(
  prev: WidgetPlacement[],
  activeId: string,
  overId: string,
): WidgetPlacement[] {
  if (activeId === overId) return prev;
  const active = prev.find((w) => w.id === activeId);
  const over = prev.find((w) => w.id === overId);
  if (!active || !over) return prev;
  return prev.map((w) => {
    if (w.id === activeId) return { ...w, x: over.x, y: over.y };
    if (w.id === overId) return { ...w, x: active.x, y: active.y };
    return w;
  });
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
   * Called with the next `widgets[]` after a drag-end. The route is
   * expected to debounce the persistence write (300ms) via the same
   * helper the resize-end path uses.
   */
  scheduleLayoutWrite: (next: WidgetPlacement[]) => void;
  /**
   * Per-widget config update (e.g. PerformanceChartWidget timeframe change).
   * The route merges the partial config into the matching widget and
   * schedules a debounced layout write.
   */
  onUpdateConfig?: (widgetId: string, config: Record<string, unknown>) => void;
}

function sortByYThenX(widgets: WidgetPlacement[]): WidgetPlacement[] {
  return [...widgets].sort((a, b) => (a.y - b.y) || (a.x - b.x));
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

export function DashboardGrid({
  widgets,
  onRemove,
  scheduleLayoutWrite,
  onUpdateConfig,
}: DashboardGridProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  const sortedForMobile = useMemo(() => sortByYThenX(widgets), [widgets]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements = useMemo(
    () => buildAnnouncements(widgets, (type) => widgetRegistry[type].displayName),
    [widgets],
  );

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const next = applyDragEnd(widgets, String(active.id), String(over.id));
    if (next !== widgets) {
      scheduleLayoutWrite(next);
    }
  }

  function handleDragCancel(): void {
    setActiveId(null);
  }

  const activeWidget = activeId
    ? widgets.find((w) => w.id === activeId) ?? null
    : null;

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
              neighbors={widgets.filter((w) => w.id !== widget.id)}
              onRemove={onRemove}
              onUpdateConfig={
                onUpdateConfig
                  ? (config) => onUpdateConfig(widget.id, config)
                  : undefined
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
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div
          ref={containerRef}
          data-measure-key={measureKey}
          data-grid-mode="grid"
          className="grid w-full gap-4"
          style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
        >
          {widgets.map((widget) => (
            <div
              key={widget.id}
              data-widget-id={widget.id}
              style={{
                gridColumn: `${widget.x + 1} / span ${widget.w}`,
                gridRow: `${widget.y + 1} / span ${widget.h}`,
              }}
            >
              <WidgetCard
                widget={widget}
                neighbors={widgets.filter((w) => w.id !== widget.id)}
                onRemove={onRemove}
                onUpdateConfig={
                  onUpdateConfig
                    ? (config) => onUpdateConfig(widget.id, config)
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeWidget ? (
          <div data-drag-overlay="true" data-active-widget-id={activeWidget.id}>
            <WidgetCard
              widget={activeWidget}
              neighbors={[]}
              onRemove={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default DashboardGrid;
