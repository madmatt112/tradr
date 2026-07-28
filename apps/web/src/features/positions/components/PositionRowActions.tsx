import { Link } from '@tanstack/react-router';
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

import {
  useDeletePosition,
  useOpenPosition,
  useClosePosition,
  useReopenPosition,
} from '../hooks/usePosition';
import { isOpenedTodayInAccountTz } from '../utils/reopenWindow';

import { FillDialog } from './FillDialog';

interface Props {
  position: PositionListItem;
}

/**
 * Row-level action menu for a position, shared by the positions list and the
 * dashboard open-positions widget. Mirrors the lifecycle gating in
 * `PositionDetailView`'s header, but derives it from the list row: that row
 * carries no `fills` array, so "has an entry fill" comes from the aggregate
 * `totalEntryQuantity` — equivalent, since every entry fill adds to it.
 *
 * Edit is deliberately NOT here: `PositionEditDialog` needs a full
 * `PositionDetail` (fills included), so it stays on the detail page rather than
 * making every row fetch one. "View details" is the path there.
 */
export function PositionRowActions({ position }: Props) {
  const deletePosition = useDeletePosition(position.id);
  const openPosition = useOpenPosition(position.id);
  const closePosition = useClosePosition(position.id);
  const reopenPosition = useReopenPosition(position.id);

  const [fillOpen, setFillOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isDraft = position.status === 'draft';
  const isOpen = position.status === 'open';
  const isClosed = position.status === 'closed';

  const canOpen = isDraft && position.totalEntryQuantity > 0;
  const canClose =
    isOpen &&
    position.totalEntryQuantity > 0 &&
    position.totalEntryQuantity === position.totalExitQuantity;
  const canReopen =
    isClosed && isOpenedTodayInAccountTz(position.openedAt, position.accountTimezone, new Date());

  const isPending =
    openPosition.isPending ||
    closePosition.isPending ||
    reopenPosition.isPending ||
    deletePosition.isPending;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="cursor-pointer"
            aria-label={`Actions for ${position.symbol}`}
            data-testid={`position-actions-${position.id}`}
          >
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link to="/positions/$positionId" params={{ positionId: position.id }}>
              View details
            </Link>
          </DropdownMenuItem>

          {!isClosed && (
            <DropdownMenuItem className="cursor-pointer" onClick={() => setFillOpen(true)}>
              Add fill
            </DropdownMenuItem>
          )}

          {canOpen && (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={isPending}
              onClick={() => openPosition.mutate({})}
            >
              Open position
            </DropdownMenuItem>
          )}

          {canClose && (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={isPending}
              onClick={() => closePosition.mutate({})}
            >
              Close position
            </DropdownMenuItem>
          )}

          {canReopen && (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={isPending}
              onClick={() => reopenPosition.mutate({})}
            >
              Reopen
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            variant="destructive"
            className="cursor-pointer"
            disabled={isPending}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FillDialog
        open={fillOpen}
        onOpenChange={setFillOpen}
        positionId={position.id}
        positionStatus={position.status}
      />

      {/* Same closed-position tax warning as the detail page — deleting a
          closed position reverses its ledger row. */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete position</AlertDialogTitle>
            <AlertDialogDescription>
              {isClosed
                ? "Deleting this closed position removes its realized P&L from the account balance and from tax and performance summaries — including prior tax years — and may change other positions' wash-sale classification. This cannot be undone."
                : 'Are you sure you want to delete this position? This cannot be undone.'}
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
