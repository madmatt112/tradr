import { Suspense, useEffect, useId, useRef } from 'react';

import type { WidgetPlacement } from '@tradr/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';

import { widgetRegistry } from '../widgets/registry';

/**
 * The class gridstack's `handle` selector targets.
 *
 * The whole header wears it, so the header — and only the header — starts a
 * drag. `<WidgetCard>` stays presentational and mounts no gesture hooks of its
 * own (design 9.3); the grid owns the gesture and finds this class by selector.
 */
export const WIDGET_DRAG_HANDLE_CLASS = 'widget-drag-handle';

/**
 * The class gridstack's `draggable.cancel` selector targets.
 *
 * Anything inside the header that has to stay clickable wears it, so pressing
 * it never arms a drag.
 */
export const WIDGET_DRAG_CANCEL_CLASS = 'widget-drag-cancel';

export interface WidgetCardProps {
  widget: WidgetPlacement;
  onRemove: (id: string) => void;
  onUpdateConfig?: (config: Record<string, unknown>) => void;
  focusOnMount?: boolean;
  /** False in the mobile single-column stack, where drag is disabled (Req 4.9). */
  draggable?: boolean;
}

export function WidgetCard({
  widget,
  onRemove,
  onUpdateConfig,
  focusOnMount,
  draggable = false,
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
      // Flat, crisp desk surface: hairline border, no elevation shadow.
      className="relative flex h-full flex-col overflow-hidden rounded-md border border-hairline bg-card text-card-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header
        data-drag-zone={draggable ? 'true' : undefined}
        className={`flex select-none items-center justify-between gap-2 border-b border-hairline px-3 py-1.5 ${
          draggable
            ? `${WIDGET_DRAG_HANDLE_CLASS} cursor-grab touch-none active:cursor-grabbing`
            : ''
        }`}
      >
        <h3
          id={titleId}
          className="truncate font-mono text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground"
        >
          {def.displayName}
        </h3>
        <span id={descId} className="sr-only">
          {def.displayName} widget
        </span>
        <div className="flex items-center gap-1">
          {/*
            Grab affordance only — deliberately NOT focusable. Keyboard
            operation of the grid is out of scope, and a focusable control here
            would advertise a keyboard path that does not exist.
          */}
          <span
            aria-hidden="true"
            data-drag-handle="true"
            className={`rounded p-1 ${
              draggable ? 'text-muted-foreground' : 'text-muted-foreground/50'
            }`}
          >
            ::
          </span>
          {/*
            The overflow menu sits inside the drag zone, so it wears the cancel
            class — without it, opening the menu would also arm a drag.
          */}
          <div className={WIDGET_DRAG_CANCEL_CLASS}>
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
    </section>
  );
}

export default WidgetCard;
