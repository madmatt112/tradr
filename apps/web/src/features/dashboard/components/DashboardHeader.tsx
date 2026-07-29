import { useState, type ReactElement } from 'react';

import type { WidgetPlacement, WidgetType } from '@tradr/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

import { AddWidgetPopover } from './AddWidgetPopover';

export interface DashboardHeaderProps {
  /** Currently placed widget types — used to filter the Add Widget picker. */
  placedTypes: WidgetType[];
  /** Called when the user selects a widget to add from the popover. */
  onAdd: (placement: WidgetPlacement) => void;
  /**
   * Restores the default layout. Omitted in the empty state, which already
   * offers "Use the default layout" as a primary action.
   */
  onResetLayout?: () => void;
  /** Disables the reset action while the default layout is being rebuilt. */
  resetBusy?: boolean;
}

/**
 * Small header above the dashboard grid.
 *
 * Renders the Add Widget popover (Task 36.3) and, once widgets are placed, a
 * Reset layout action.
 *
 * The `?` keyboard-reorder tooltip that used to live here has been REMOVED: it
 * documented a Tab → Space → arrows → Space flow that does not actually work,
 * so it was actively misleading. Either the keyboard path gets implemented or
 * the affordance goes for good — tracked separately; see Req 4.11.2, which
 * still specifies the binding and is currently out of step with the code.
 *
 * Does NOT mount `<ThemeToggle />` — Task 26 mounts it in the sidebar; per
 * Task 43 restrictions we must not double-mount it here.
 */
export function DashboardHeader({
  placedTypes,
  onAdd,
  onResetLayout,
  resetBusy,
}: DashboardHeaderProps): ReactElement {
  const [confirmingReset, setConfirmingReset] = useState(false);

  return (
    <header data-slot="dashboard-header" className="flex items-center justify-between gap-2">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <div className="flex items-center gap-2">
        <AddWidgetPopover placedTypes={placedTypes} onAdd={onAdd} />
        {onResetLayout ? (
          <>
            <Button
              type="button"
              variant="outline"
              data-slot="dashboard-reset-layout"
              className="cursor-pointer"
              disabled={resetBusy}
              onClick={() => setConfirmingReset(true)}
            >
              Reset layout
            </Button>
            <AlertDialog open={confirmingReset} onOpenChange={setConfirmingReset}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset dashboard layout</AlertDialogTitle>
                  <AlertDialogDescription>
                    Every widget goes back to its default position and size, and any widget you
                    removed comes back. Your trading data is not affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="cursor-pointer"
                    data-slot="dashboard-reset-confirm"
                    onClick={() => {
                      setConfirmingReset(false);
                      onResetLayout();
                    }}
                  >
                    Reset layout
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </div>
    </header>
  );
}

export default DashboardHeader;
