import { Minus, Plus, RotateCcw, Trash2, Play, type LucideIcon } from 'lucide-react';
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

import { useDeletePosition, useOpenPosition, useReopenPosition } from '../hooks/usePosition';
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
  const reopenPosition = useReopenPosition(position.id);

  const [fillType, setFillType] = useState<'entry' | 'exit' | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isDraft = position.status === 'draft';
  const isOpen = position.status === 'open';
  const isClosed = position.status === 'closed';

  // R11-AC4: Open is SHOWN on a draft and merely disabled until an entry fill
  // exists — not hidden. Reopen is different: the R11 amendment scopes it to
  // "only when" the same-day window is open, so it stays conditionally rendered.
  //
  // There is deliberately NO Close action here. A balancing exit auto-closes
  // the position (R7 amendment), so "−" then All *is* the close; a separate
  // button would sit permanently disabled except in the instant between full
  // exit and auto-close, which no user can reach. The detail page keeps one for
  // the residual path that does not auto-close (editing a fill up to full size).
  const openUnits = position.totalEntryQuantity - position.totalExitQuantity;
  const hasEntryQuantity = position.totalEntryQuantity > 0;
  const canOpen = hasEntryQuantity;
  const canReopen =
    isClosed && isOpenedTodayInAccountTz(position.openedAt, position.accountTimezone, new Date());

  const isPending = openPosition.isPending || reopenPosition.isPending || deletePosition.isPending;

  return (
    <>
      {/* data-slot is load-bearing: rowNavigation keys off it so a click on a
          DISABLED action (which lands on the tooltip's span wrapper, not the
          button) does not fall through and navigate the row. */}
      <div data-slot="row-actions" className="flex items-center justify-end gap-1">
        {/* Single-purpose entry/exit, replacing one dual-purpose "Add fill".
            Exit is `open`-only — R5-AC3 409s an exit fill on a draft — and is
            dead once nothing is left open to reduce. */}
        {!isClosed && (
          <RowAction
            icon={Plus}
            label="Add to position"
            disabled={isPending}
            onClick={() => setFillType('entry')}
          />
        )}

        {isOpen && (
          <RowAction
            icon={Minus}
            label="Reduce position"
            disabledReason="Nothing open to reduce"
            disabled={isPending || openUnits <= 0}
            onClick={() => setFillType('exit')}
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
        open={fillType !== null}
        onOpenChange={(next) => !next && setFillType(null)}
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
