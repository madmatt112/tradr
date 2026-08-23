import { Minus, MoreHorizontal, Plus, RotateCcw, Trash2, Play } from 'lucide-react';
import { useState } from 'react';

import type { PositionListItem } from '@tradr/shared';

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useDeletePosition, useOpenPosition, useReopenPosition } from '../hooks/usePosition';
import { isOpenedTodayInAccountTz } from '../utils/reopenWindow';

import { FillDialog } from './FillDialog';

interface Props {
  position: PositionListItem;
}

/**
 * Row-level actions for a position, shared by the positions list and the
 * dashboard open-positions widget. A single `⋯` menu (visual-redesign task 7)
 * — the desk table spends its width on data, and the destructive Delete now
 * sits a deliberate click deep instead of permanently exposed at 31px row
 * height. Disabled items keep their explanation inline in the item label.
 *
 * Lifecycle gating mirrors `PositionDetailView`'s header, derived from the
 * list row: that row carries no `fills` array, so "has an entry fill" comes
 * from the aggregate `totalEntryQuantity` — equivalent, since every entry fill
 * adds to it.
 *
 * Two omissions are deliberate. **Edit** needs a full `PositionDetail` (fills
 * included) for its option-contract branch, so it stays on the detail page.
 * **View details** stays out of the menu — the row's inspect click and the
 * symbol link already cover it.
 */
export function PositionRowActions({ position }: Props) {
  const deletePosition = useDeletePosition(position.id);
  const openPosition = useOpenPosition(position.id);
  const reopenPosition = useReopenPosition(position.id);

  const [fillType, setFillType] = useState<'entry' | 'exit' | null>(null);
  /** Play opened the fill dialog to collect a draft's entry — open once it saves. */
  const [openAfterFill, setOpenAfterFill] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isDraft = position.status === 'draft';
  const isOpen = position.status === 'open';
  const isClosed = position.status === 'closed';

  // A draft is a PLAN, not a position holding units, so there is nothing to
  // "add to" — "+" is open-only. Play is the whole draft workflow instead: on a
  // draft that has no entry fill yet it collects the entry first (the server
  // rejects an open without one), then performs the transition. One button, one
  // meaning — "start this trade" — and never disabled, so a fresh draft is never
  // stranded in the list.
  //
  // There is deliberately NO Close action here. A balancing exit auto-closes
  // the position (R7 amendment), so "−" then All *is* the close; a separate
  // button would sit permanently disabled except in the instant between full
  // exit and auto-close, which no user can reach. The detail page keeps one for
  // the residual path that does not auto-close (editing a fill up to full size).
  const openUnits = position.totalEntryQuantity - position.totalExitQuantity;
  const hasEntryQuantity = position.totalEntryQuantity > 0;
  const canReopen =
    isClosed && isOpenedTodayInAccountTz(position.openedAt, position.accountTimezone, new Date());

  const isPending = openPosition.isPending || reopenPosition.isPending || deletePosition.isPending;

  return (
    <>
      {/* data-slot is load-bearing: rowNavigation keys off it so a click
          anywhere in the menu region never falls through and inspects the
          row. */}
      <div data-slot="row-actions" className="flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-pointer text-muted-foreground"
              aria-label={`Actions for ${position.symbol}`}
              disabled={isPending}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Single-purpose entry/exit. Both are `open`-only: a draft has no
                units to add to or reduce, and R5-AC3 409s an exit on a draft. */}
            {isOpen && (
              <DropdownMenuItem className="cursor-pointer" onSelect={() => setFillType('entry')}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add to position
              </DropdownMenuItem>
            )}
            {isOpen && (
              <DropdownMenuItem
                className="cursor-pointer"
                disabled={openUnits <= 0}
                onSelect={() => setFillType('exit')}
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
                {openUnits <= 0 ? 'Reduce position (nothing open)' : 'Reduce position'}
              </DropdownMenuItem>
            )}
            {isDraft && (
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => {
                  if (hasEntryQuantity) {
                    openPosition.mutate({});
                    return;
                  }
                  // No entry fill yet: collect it, then open once it saves.
                  setOpenAfterFill(true);
                  setFillType('entry');
                }}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Open position
              </DropdownMenuItem>
            )}
            {canReopen && (
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => reopenPosition.mutate({})}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Reopen
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="cursor-pointer"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <FillDialog
        open={fillType !== null}
        onOpenChange={(next) => {
          if (next) return;
          setFillType(null);
          // Cancelled rather than saved — drop the pending open.
          setOpenAfterFill(false);
        }}
        onAdded={() => {
          if (!openAfterFill) return;
          setOpenAfterFill(false);
          openPosition.mutate({});
        }}
        positionId={position.id}
        positionStatus={position.status}
        defaultType={fillType ?? undefined}
        position={{
          accountId: position.accountId,
          assetType: position.assetType,
          side: position.side,
          openUnits,
          avgEntryPrice: position.avgEntryPrice,
          targetPrice: position.targetPrice,
          stopLoss: position.stopLoss,
        }}
      />

      {/* Same closed-position tax warning as the detail page — deleting a
          closed position reverses its ledger row. */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete position</AlertDialogTitle>
            {/* R4 amendment: the dialog SHALL name the position. */}
            <AlertDialogDescription>
              {isClosed
                ? `Deleting the closed position "${position.symbol}" removes its realized P&L from the account balance and from tax and performance summaries — including prior tax years — and may change other positions' wash-sale classification. This cannot be undone.`
                : `Are you sure you want to delete "${position.symbol}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" onClick={() => deletePosition.mutate()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
