import { Suspense, useEffect, useId, useRef } from 'react';

import type { WidgetPlacement } from '@tradr/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';

import { GRID_COLUMNS } from '../grid.constants';
import { widgetRegistry } from '../widgets/registry';

const GRID_MAX_ROWS = 6;

/**
 * Clamps a pixel-denominated resize request into cell-denominated `{w, h}`.
 *
 * - Pixel → cell conversion uses **floor + half-cell snap with `hysteresisPx`
 *   deadband**: the gesture must cross the half-cell boundary by at least
 *   `hysteresisPx` past the snap threshold before the cell count changes.
 * - The result is then clamped against `neighbors` (rectangles that share a
 *   row/column with `selfPos`) and against the global grid bounds
 *   (12 columns, 6 rows).
 *
 * Pass `requestedSize` in **pixels**. Pass `currentSize` in **cells** (it's
 * the floor used as a tie-break inside the hysteresis deadband). The return
 * value is in **cells**.
 *
 * For pure-cell-domain unit tests, pass `cellPx = 1`, `gapPx = 0`,
 * `hysteresisPx = 0`; then `requestedSize` is effectively in cells.
 */
export function clampResize(
  currentSize: { w: number; h: number },
  requestedSize: { w: number; h: number },
  neighbors: WidgetPlacement[],
  hysteresisPx: number,
  cellPx: number,
  gapPx: number,
  selfPos: { x: number; y: number } = { x: 0, y: 0 },
): { w: number; h: number } {
  const span = cellPx + gapPx;
  // Floor + half-cell snap with a `hysteresisPx` deadband around the
  // half-cell boundary. The gesture must cross the half-cell line by at
  // least `hysteresisPx` before the cell count changes; otherwise the
  // result sticks to `currentSize`.
  function pxToCells(px: number, currentCells: number): number {
    if (px <= 0) return 1;
    const floor = Math.floor(px / span);
    const remainder = px - floor * span;
    const halfCell = span / 2;
    let snapped: number;
    if (remainder >= halfCell + hysteresisPx) {
      snapped = floor + 1;
    } else if (remainder <= halfCell - hysteresisPx) {
      snapped = floor;
    } else {
      // Inside the deadband — keep current cell count.
      snapped = currentCells;
    }
    return Math.max(1, snapped);
  }

  let w = pxToCells(requestedSize.w, currentSize.w);
  let h = pxToCells(requestedSize.h, currentSize.h);

  // Clamp to grid bounds.
  w = Math.min(w, GRID_COLUMNS - selfPos.x);
  h = Math.min(h, GRID_MAX_ROWS - selfPos.y);

  // Clamp against neighbors. Use the CURRENT self extent (not the requested
  // one) to detect whether a neighbor is east-of vs south-of self, so that
  // a south neighbor sharing the same column doesn't get mis-classified as
  // an east blocker.
  const selfBottom = selfPos.y + currentSize.h;
  const selfRight = selfPos.x + currentSize.w;
  for (const n of neighbors) {
    const sharesRowsCurrent = n.y < selfBottom && n.y + n.h > selfPos.y;
    const sharesColsCurrent = n.x < selfRight && n.x + n.w > selfPos.x;
    // East blocker: shares rows with self's current row range and is to the
    // right of self's current right edge.
    if (sharesRowsCurrent && n.x >= selfRight) {
      const maxW = n.x - selfPos.x;
      if (maxW < w) w = maxW;
    }
    // South blocker: shares cols with self's current col range and is below
    // self's current bottom edge.
    if (sharesColsCurrent && n.y >= selfBottom) {
      const maxH = n.y - selfPos.y;
      if (maxH < h) h = maxH;
    }
  }

  return { w: Math.max(1, w), h: Math.max(1, h) };
}

export interface WidgetCardProps {
  widget: WidgetPlacement;
  neighbors: WidgetPlacement[];
  onRemove: (id: string) => void;
  onUpdateConfig?: (config: Record<string, unknown>) => void;
  focusOnMount?: boolean;
  cellPx?: number;
  gapPx?: number;
}

export function WidgetCard({
  widget,
  onRemove,
  onUpdateConfig,
  focusOnMount,
}: WidgetCardProps): React.ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const def = widgetRegistry[widget.type];
  const Body = def.component;

  useEffect(() => {
    if (focusOnMount) {
      ref.current?.focus();
    }
  }, [focusOnMount]);

  return (
    <section
      ref={ref}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      data-widget-id={widget.id}
      data-widget-type={widget.type}
      className="relative flex h-full flex-col rounded-md border bg-card text-card-foreground shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h3 id={titleId} className="truncate text-sm font-medium">
          {def.displayName}
        </h3>
        <span id={descId} className="sr-only">
          {def.displayName} widget
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Drag to reorder ${def.displayName}`}
            data-drag-handle="true"
            className="cursor-grab rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
          >
            <span aria-hidden="true">::</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${def.displayName} menu`}
              className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent"
            >
              <span aria-hidden="true">···</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => onRemove(widget.id)}
                className="cursor-pointer"
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="flex-1 overflow-auto p-3">
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
          <Body placement={widget} onUpdateConfig={onUpdateConfig ?? (() => undefined)} />
        </Suspense>
      </div>
      <div
        aria-hidden="true"
        data-resize-handle="true"
        className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize"
      />
    </section>
  );
}

export default WidgetCard;
