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
    // The route owns the authoritative packing against the real placements; the
    // picker only knows the types, so it emits at the origin and lets `handleAdd`
    // re-slot. Carry the registry's `defaultConfig` when the widget has one so
    // the new tile opens configured (Req 7.3).
    const placement: WidgetPlacement = {
      id: newWidgetId(),
      type,
      x: 0,
      y: 0,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      ...(def.defaultConfig !== undefined ? { config: def.defaultConfig } : {}),
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
