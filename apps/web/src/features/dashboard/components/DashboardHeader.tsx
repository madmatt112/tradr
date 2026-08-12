import { useState, type ReactElement, type ReactNode } from 'react';

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
  /**
   * The dashboard's coach mark, rendered BESIDE THE HEADING — which is where
   * every other surface's mark sits (`ImportPage`, `OptionsPage`,
   * `PositionDetail` all put it immediately after their `<h1>`/`<h2>`), and
   * where it has to sit here too.
   *
   * A coach mark opens below its anchor. Anchored at the far right of this row,
   * as this one was, it opens over the right-hand edge of everything beneath —
   * which on the dashboard is the column the app keeps its per-row and per-card
   * buttons in. Measured in Chromium at 1280x720, the card landed at x
   * 984-1272 with its "Got it" directly on top of the activation checklist's
   * play button for "Log a position" (x 1207-1239): a click aimed at the play
   * button pressed "Got it" instead. Those play buttons are the only way back
   * into a walkthrough once the zero-state has gone, so the mark was covering
   * the control that restores the thing it is a substitute for. With the
   * checklist retired it landed on the first widget's card menu instead.
   *
   * Beside the heading the card opens over body text and nothing else. The
   * prop exists because the heading lives in here, not in the route.
   */
  coachMark?: ReactNode;
}

/**
 * Small header above the dashboard grid.
 *
 * Renders the Add Widget popover (Task 36.3) and, once widgets are placed, a
 * Reset layout action.
 *
 * The `?` keyboard-reorder tooltip that used to live here is gone for good. It
 * documented a Tab → Space → arrows → Space flow that never worked, and
 * keyboard operation of the grid is now explicitly OUT OF SCOPE — not pending
 * implementation. Req 4.11.2 is withdrawn, so there is nothing left to
 * document here.
 *
 * Does NOT mount `<ThemeToggle />` — Task 26 mounts it in the sidebar; per
 * Task 43 restrictions we must not double-mount it here.
 */
export function DashboardHeader({
  placedTypes,
  onAdd,
  onResetLayout,
  resetBusy,
  coachMark,
}: DashboardHeaderProps): ReactElement {
  const [confirmingReset, setConfirmingReset] = useState(false);

  return (
    <header data-slot="dashboard-header" className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        {coachMark}
      </div>
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
