import { Check, Plus, RotateCcw, Trash2, Play, type LucideIcon } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

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

interface ActionProps {
  icon: LucideIcon;
  /** Accessible name and tooltip label when the action is available. */
  label: string;
  /** Replaces `label` in the tooltip while disabled, explaining what unlocks it. */
  disabledReason?: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}

/**
 * One icon button in the row's action strip. The label is always the button's
 * accessible name — the icon alone is meaningless to a screen reader — and
 * doubles as the tooltip, so the icon never has to be guessed at.
 *
 * The `<span>` wrapper is required: Radix tooltips listen for pointer events,
 * which a disabled button does not emit, so a disabled action would otherwise
 * be the one case that never explains itself.
 */
function RowAction({
  icon: Icon,
  label,
  disabledReason,
  disabled = false,
  destructive = false,
  onClick,
}: ActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="outline"
            size="icon-sm"
            className={
              destructive
                ? 'cursor-pointer text-destructive hover:bg-destructive/10 hover:text-destructive'
                : 'cursor-pointer'
            }
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            <Icon aria-hidden="true" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabled && disabledReason ? disabledReason : label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Row-level actions for a position, shared by the positions list and the
 * dashboard open-positions widget. Rendered as a strip of discrete icon
 * buttons rather than a `⋯` menu: the actions are the point of the row, and
 * burying them one click deep made them undiscoverable in a wide table.
 *
 * Lifecycle gating mirrors `PositionDetailView`'s header, derived from the
 * list row: that row carries no `fills` array, so "has an entry fill" comes
 * from the aggregate `totalEntryQuantity` — equivalent, since every entry fill
 * adds to it.
 *
 * Two omissions are deliberate. **Edit** needs a full `PositionDetail` (fills
 * included) for its option-contract branch, so it stays on the detail page.
 * **View details** is gone with the menu — the whole row already navigates
 * there, so an icon for it would be redundant.
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

  // R11-AC4/AC5: Open and Close are SHOWN for their status and merely disabled
  // when the position is not yet eligible — not hidden. Reopen is different:
  // the R11 amendment scopes it to "only when" the same-day window is open, so
  // it stays conditionally rendered.
  const hasEntryQuantity = position.totalEntryQuantity > 0;
  const canOpen = hasEntryQuantity;
  const canClose = hasEntryQuantity && position.totalEntryQuantity === position.totalExitQuantity;
  const canReopen =
    isClosed && isOpenedTodayInAccountTz(position.openedAt, position.accountTimezone, new Date());

  const isPending =
    openPosition.isPending ||
    closePosition.isPending ||
    reopenPosition.isPending ||
    deletePosition.isPending;

  return (
    <>
      <div className="flex items-center justify-end gap-1">
        {!isClosed && (
          <RowAction
            icon={Plus}
            label="Add fill"
            disabled={isPending}
            onClick={() => setFillOpen(true)}
          />
        )}

        {isDraft && (
          <RowAction
            icon={Play}
            label="Open position"
            disabledReason="Add an entry fill first"
            disabled={isPending || !canOpen}
            onClick={() => openPosition.mutate({})}
          />
        )}

        {isOpen && (
          <RowAction
            icon={Check}
            label="Close position"
            disabledReason="Exit the full quantity first"
            disabled={isPending || !canClose}
            onClick={() => closePosition.mutate({})}
          />
        )}

        {canReopen && (
          <RowAction
            icon={RotateCcw}
            label="Reopen"
            disabled={isPending}
            onClick={() => reopenPosition.mutate({})}
          />
        )}

        <RowAction
          icon={Trash2}
          label="Delete"
          destructive
          disabled={isPending}
          onClick={() => setDeleteOpen(true)}
        />
      </div>

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
