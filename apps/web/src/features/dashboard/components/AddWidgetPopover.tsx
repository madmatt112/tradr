import { Popover as PopoverPrimitive } from 'radix-ui';
import { type ReactElement } from 'react';

import type { WidgetPlacement, WidgetType } from '@tradr/shared';

import { newWidgetId } from '@/lib/uuid-fallback';

import { findFirstSlot } from '../layout';
import { widgetRegistry } from '../widgets/registry';

export { findFirstSlot };

export interface AddWidgetPopoverProps {
  placedTypes: WidgetType[];
  onAdd: (placement: WidgetPlacement) => void;
  /** Open the popover by default (primarily for testing). */
  defaultOpen?: boolean;
}

export function AddWidgetPopover({
  placedTypes,
  onAdd,
  defaultOpen,
}: AddWidgetPopoverProps): ReactElement {
  const placedSet = new Set<WidgetType>(placedTypes);
  const available = Object.values(widgetRegistry)
    .filter((def) => !placedSet.has(def.type))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const allPlaced = available.length === 0;

  function handleSelect(type: WidgetType): void {
    const def = widgetRegistry[type];
    // Build a placeholder `existing[]` from `placedTypes`. The route is
    // responsible for the authoritative packing using the real placements;
    // here we emit a placement with a reasonable position derived from the
    // types alone (route may override). Use the registry default sizes.
    const minSize = { w: def.defaultSize.w, h: def.defaultSize.h };
    const { x, y } = findFirstSlot([], minSize);
    const placement: WidgetPlacement = {
      id: newWidgetId(),
      type,
      x,
      y,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
    };
    onAdd(placement);
  }

  return (
    <PopoverPrimitive.Root defaultOpen={defaultOpen}>
      <PopoverPrimitive.Trigger
        data-slot="add-widget-trigger"
        className="cursor-pointer rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent"
      >
        Add Widget
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-slot="add-widget-content"
          align="end"
          sideOffset={4}
          className="z-50 w-64 rounded-md border bg-popover p-2 text-popover-foreground shadow-md outline-none"
        >
          {allPlaced ? (
            <p data-slot="add-widget-empty" className="px-2 py-3 text-sm text-muted-foreground">
              All widgets added.
            </p>
          ) : (
            <ul data-slot="add-widget-list" className="flex flex-col" role="list">
              {available.map((def) => (
                <li key={def.type} role="listitem">
                  <button
                    type="button"
                    data-widget-type={def.type}
                    data-slot="add-widget-item"
                    onClick={() => handleSelect(def.type)}
                    className="w-full cursor-pointer rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    {def.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export default AddWidgetPopover;
