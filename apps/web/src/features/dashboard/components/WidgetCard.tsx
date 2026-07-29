import { Suspense, useEffect, useId, useRef } from 'react';

import type { WidgetPlacement } from '@tradr/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';

import { GRID_GAP_PX, RESIZE_HYSTERESIS_PX } from '../grid.constants';
import { resolveResizeRect, type GridRect, type ResizeEdges } from '../resize';
import { widgetRegistry } from '../widgets/registry';

/**
 * The dnd-kit activator props `<DashboardGrid>` threads into the drag zone.
 *
 * Structural on purpose: `<WidgetCard>` is presentational chrome and does not
 * mount dnd-kit hooks itself (design 9.3). The shape covers dnd-kit's
 * `DraggableAttributes` plus the `PointerSensor` / `KeyboardSensor` activator
 * listeners.
 */
export interface DragHandleProps {
  ref?: React.Ref<HTMLButtonElement>;
  role?: string;
  tabIndex?: number;
  'aria-disabled'?: boolean;
  'aria-pressed'?: boolean;
  'aria-roledescription'?: string;
  'aria-describedby'?: string;
  onPointerDown?: React.PointerEventHandler<Element>;
  onKeyDown?: React.KeyboardEventHandler<Element>;
}

/**
 * The seven resize affordances, in paint order — edges first so the corners
 * sit on top of them and win the overlapping pixels.
 *
 * There is deliberately no TOP edge strip: the whole header is the drag zone,
 * and a full-width resize strip along the top would swallow the start of every
 * drag. The two top CORNERS are small enough to coexist with it.
 */
const RESIZE_HANDLES: ReadonlyArray<{
  key: string;
  edges: ResizeEdges;
  label: string;
  className: string;
}> = [
  {
    key: 'left',
    edges: { left: true },
    label: 'left edge',
    className: 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
  },
  {
    key: 'right',
    edges: { right: true },
    label: 'right edge',
    className: 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
  },
  {
    key: 'bottom',
    edges: { bottom: true },
    label: 'bottom edge',
    className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize',
  },
  {
    key: 'top-left',
    edges: { top: true, left: true },
    label: 'top-left corner',
    className: 'left-0 top-0 h-3 w-3 cursor-nwse-resize',
  },
  {
    key: 'top-right',
    edges: { top: true, right: true },
    label: 'top-right corner',
    className: 'right-0 top-0 h-3 w-3 cursor-nesw-resize',
  },
  {
    key: 'bottom-left',
    edges: { bottom: true, left: true },
    label: 'bottom-left corner',
    className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize',
  },
  {
    key: 'bottom-right',
    edges: { bottom: true, right: true },
    label: 'bottom-right corner',
    className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
  },
];

export interface WidgetCardProps {
  widget: WidgetPlacement;
  onRemove: (id: string) => void;
  onUpdateConfig?: (config: Record<string, unknown>) => void;
  focusOnMount?: boolean;
  gapPx?: number;
  /** Omitted wherever resize is disabled (mobile stack, drag overlay). */
  onResize?: (rect: GridRect) => void;
  /** Gesture lifecycle — the grid uses these to show its cell backdrop. */
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /** Omitted wherever drag is disabled (mobile stack, drag overlay). */
  dragHandleProps?: DragHandleProps;
}

interface ResizeGesture {
  pointerId: number;
  edges: ResizeEdges;
  startClientX: number;
  startClientY: number;
  /** The widget's grid rect when the gesture began — deltas measure from it. */
  startRect: GridRect;
  colSpanPx: number;
  rowSpanPx: number;
}

export function WidgetCard({
  widget,
  onRemove,
  onUpdateConfig,
  focusOnMount,
  gapPx = GRID_GAP_PX,
  onResize,
  onResizeStart,
  onResizeEnd,
  dragHandleProps,
}: WidgetCardProps): React.ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  const gestureRef = useRef<ResizeGesture | null>(null);
  const titleId = useId();
  const descId = useId();
  const def = widgetRegistry[widget.type];
  const Body = def.component;
  const canResize = onResize !== undefined;
  const canDrag = dragHandleProps !== undefined;

  useEffect(() => {
    if (focusOnMount) {
      ref.current?.focus();
    }
  }, [focusOnMount]);

  function handleResizeStart(event: React.PointerEvent<HTMLDivElement>, edges: ResizeEdges): void {
    if (!canResize) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep the gesture off the card's focus handling and off the header's drag
    // activator — this is a resize, not a drag.
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = {
      pointerId: event.pointerId,
      edges,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: { x: widget.x, y: widget.y, w: widget.w, h: widget.h },
      // Cell pitch measured from THIS widget's own box rather than a constant:
      // rows are `minmax(GRID_ROW_HEIGHT_PX, auto)`, so a band that grew to fit
      // its content is taller than the constant. `rect` spans `w` columns and
      // `w - 1` gaps, so one column's pitch is `(width + gap) / w`.
      colSpanPx: (rect.width + gapPx) / widget.w,
      rowSpanPx: (rect.height + gapPx) / widget.h,
    };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    onResizeStart?.();
  }

  function handleResizeMove(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!onResize) return;
    const next = resolveResizeRect(
      gesture.startRect,
      { x: widget.x, y: widget.y, w: widget.w, h: widget.h },
      {
        x: event.clientX - gesture.startClientX,
        y: event.clientY - gesture.startClientY,
      },
      gesture.edges,
      { colSpanPx: gesture.colSpanPx, rowSpanPx: gesture.rowSpanPx },
      def.minSize,
      RESIZE_HYSTERESIS_PX,
    );
    if (next.x !== widget.x || next.y !== widget.y || next.w !== widget.w || next.h !== widget.h) {
      onResize(next);
    }
  }

  function handleResizeEnd(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === 'function' &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeEnd?.();
  }

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
      {/*
        The whole header is the drag zone. It carries the pointer/keyboard
        activator listeners; the `::` button additionally carries dnd-kit's
        aria attributes and the activator ref, so it stays the labelled,
        focusable target for keyboard reorder (Req 4.11.2).
      */}
      <header
        data-drag-zone={canDrag ? 'true' : undefined}
        onPointerDown={canDrag ? dragHandleProps?.onPointerDown : undefined}
        onKeyDown={canDrag ? dragHandleProps?.onKeyDown : undefined}
        className={`flex select-none items-center justify-between gap-2 border-b px-3 py-2 ${
          canDrag ? 'cursor-grab touch-none active:cursor-grabbing' : ''
        }`}
      >
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
            {...dragHandleProps}
            aria-disabled={canDrag ? undefined : true}
            className={
              canDrag
                ? 'cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing'
                : 'cursor-not-allowed rounded p-1 text-muted-foreground/50'
            }
          >
            <span aria-hidden="true">::</span>
          </button>
          {/*
            The overflow menu lives inside the drag zone, so its pointerdown
            must not reach the activator or opening the menu would arm a drag.
          */}
          <div onPointerDown={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${def.displayName} menu`}
                className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent"
              >
                <span aria-hidden="true">···</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onRemove(widget.id)} className="cursor-pointer">
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-auto p-3">
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
          <Body placement={widget} onUpdateConfig={onUpdateConfig ?? (() => undefined)} />
        </Suspense>
      </div>
      {canResize
        ? RESIZE_HANDLES.map((handle) => (
            <div
              key={handle.key}
              aria-hidden="true"
              data-resize-handle="true"
              data-resize-edge={handle.key}
              title={`Resize ${def.displayName} — ${handle.label}`}
              onPointerDown={(event) => handleResizeStart(event, handle.edges)}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
              className={`absolute touch-none ${handle.className}`}
            />
          ))
        : null}
    </section>
  );
}

export default WidgetCard;
