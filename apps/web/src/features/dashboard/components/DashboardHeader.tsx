import { type ReactElement } from 'react';

import type { WidgetPlacement, WidgetType } from '@tradr/shared';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { AddWidgetPopover } from './AddWidgetPopover';

export interface DashboardHeaderProps {
  /** Currently placed widget types — used to filter the Add Widget picker. */
  placedTypes: WidgetType[];
  /** Called when the user selects a widget to add from the popover. */
  onAdd: (placement: WidgetPlacement) => void;
}

/**
 * Small header above the dashboard grid.
 *
 * Renders:
 * - The Add Widget popover (Task 36.3).
 * - A `?` keyboard-help tooltip (Req 4.11.2 — Tab → Space → arrows → Space).
 *
 * Does NOT mount `<ThemeToggle />` — Task 26 mounts it in the sidebar; per
 * Task 43 restrictions we must not double-mount it here.
 */
export function DashboardHeader({ placedTypes, onAdd }: DashboardHeaderProps): ReactElement {
  return (
    <header data-slot="dashboard-header" className="flex items-center justify-between gap-2">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="flex items-center gap-2">
        <AddWidgetPopover placedTypes={placedTypes} onAdd={onAdd} />
        <Tooltip>
          <TooltipTrigger
            type="button"
            aria-label="Keyboard reorder help"
            data-slot="dashboard-keyboard-help"
            className="cursor-pointer rounded-md border bg-background px-2 py-1 text-sm font-medium shadow-sm hover:bg-accent"
          >
            ?
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Keyboard reorder: Tab to a widget, Space to grab, arrow keys to move, Space to drop.
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

export default DashboardHeader;
