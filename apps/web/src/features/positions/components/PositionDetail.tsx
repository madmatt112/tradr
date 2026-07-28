import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Numeric } from '@/components/Numeric';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCurrency } from '@/lib/format';

import {
  usePosition,
  useDeletePosition,
  useOpenPosition,
  useClosePosition,
  useReopenPosition,
} from '../hooks/usePosition';
import { decodeOptionContract } from '../utils/optionContract';
import { isOpenedTodayInAccountTz } from '../utils/reopenWindow';

import { FillDialog } from './FillDialog';
import { FillTable } from './FillTable';
import { PositionEditDialog } from './PositionEditDialog';

interface Props {
  positionId: string;
}

export function PositionDetailView({ positionId }: Props) {
  const navigate = useNavigate();
  const { data: position, isLoading } = usePosition(positionId);
  const deletePosition = useDeletePosition(positionId);
  const openPosition = useOpenPosition(positionId);
  const closePosition = useClosePosition(positionId);
  const reopenPosition = useReopenPosition(positionId);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [fillDialogOpen, setFillDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (!position) {
    return <div className="py-12 text-center text-muted-foreground">Position not found</div>;
  }

  const isDraft = position.status === 'draft';
  const isOpen = position.status === 'open';
  const isClosed = position.status === 'closed';

  // Option positions store the contract in a compact OCC symbol; decode it for
  // display. null for stocks and any legacy non-OCC option symbol.
  const optionContract =
    position.assetType === 'option' ? decodeOptionContract(position.symbol) : null;

  // R11-AC4/AC5: Open and Close are SHOWN for their status and disabled until
  // the position is eligible — the reason rides on a tooltip, mirroring the
  // disabled "New Position" affordance in PositionList (R10-AC6). Reopen is
  // different: the R11 amendment scopes it to "only when" the same-day window
  // is open, so it stays conditionally rendered.
  const hasEntryFills = position.fills.some((f) => f.type === 'entry');
  const canOpen = hasEntryFills;
  const isFullyExited =
    position.totalEntryQuantity > 0 && position.totalEntryQuantity === position.totalExitQuantity;
  const canClose = isFullyExited;

  // Reopen (R13): closed positions whose openedAt is still the current trading
  // day in the account's timezone. Server is authoritative and 409s a prior-day
  // reopen; this only governs whether the button is offered.
  const canReopen =
    isClosed && isOpenedTodayInAccountTz(position.openedAt, position.accountTimezone, new Date());

  // Determine account currency from the position (we need it for formatting)
  // The detail endpoint doesn't return accountCurrency, so use a fallback
  const currency = 'USD'; // The list endpoint has accountCurrency; detail doesn't. This is a known limitation.

  const hasManualFillFees = position.fills.some((f) => parseFloat(f.fees) > 0);
  const hasDoubleFeeRisk = hasManualFillFees && position.brokerageFees > 0;

  const handleDelete = async () => {
    await deletePosition.mutateAsync();
    navigate({ to: '/positions' });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold" title={position.symbol}>
              {optionContract ? optionContract.underlying : position.symbol}
            </h1>
            <Badge variant={position.side === 'long' ? 'default' : 'secondary'}>
              {position.side}
            </Badge>
            <Badge variant="outline">{position.assetType}</Badge>
            <Badge variant="outline">{position.status}</Badge>
          </div>
          {optionContract && (
            <p className="text-sm text-muted-foreground">
              Exp {optionContract.expiryLabel} · {optionContract.strikeLabel}{' '}
              {optionContract.typeLabel}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="cursor-pointer" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          {isDraft && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    className="cursor-pointer"
                    onClick={() => openPosition.mutate({})}
                    disabled={openPosition.isPending || !canOpen}
                  >
                    {openPosition.isPending ? 'Opening...' : 'Open Position'}
                  </Button>
                </span>
              </TooltipTrigger>
              {!canOpen && <TooltipContent>Add an entry fill first</TooltipContent>}
            </Tooltip>
          )}
          {isOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    className="cursor-pointer"
                    onClick={() => closePosition.mutate({})}
                    disabled={closePosition.isPending || !canClose}
                  >
                    {closePosition.isPending ? 'Closing...' : 'Close Position'}
                  </Button>
                </span>
              </TooltipTrigger>
              {!canClose && <TooltipContent>Exit the full quantity first</TooltipContent>}
            </Tooltip>
          )}
          {canReopen && (
            <Button
              className="cursor-pointer"
              onClick={() => reopenPosition.mutate({})}
              disabled={reopenPosition.isPending}
            >
              {reopenPosition.isPending ? 'Reopening...' : 'Reopen'}
            </Button>
          )}
          <Button
            variant="destructive"
            className="cursor-pointer"
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* P&L Summary */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Avg Entry</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {position.avgEntryPrice !== null ? position.avgEntryPrice.toFixed(4) : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Avg Exit</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {position.avgExitPrice !== null ? position.avgExitPrice.toFixed(4) : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Target Price</CardTitle>
          </CardHeader>
          <CardContent>
            <Numeric
              value={position.targetPrice}
              kind="money"
              currency={currency}
              direction="none"
              className="text-lg font-semibold"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Target R/R</CardTitle>
          </CardHeader>
          <CardContent>
            <Numeric
              value={position.targetRR}
              kind="decimal"
              direction="none"
              className="text-lg font-semibold"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Actual R/R</CardTitle>
          </CardHeader>
          <CardContent>
            <Numeric
              value={position.actualRR}
              kind="decimal"
              direction="auto"
              className="text-lg font-semibold"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Gross P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <Numeric
              value={position.grossPnl}
              kind="money"
              currency={currency}
              direction="auto"
              className="text-lg font-semibold"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Brokerage Fees</CardTitle>
          </CardHeader>
          <CardContent>
            {position.brokerageName === null ? (
              <p className="text-lg font-semibold">
                <span aria-label="No brokerage assigned">—</span>
              </p>
            ) : (
              <>
                <p className="text-lg font-semibold">
                  {formatCurrency(position.brokerageFees, currency)}
                </p>
                <Link to="/brokerages" className="text-xs text-muted-foreground hover:underline">
                  {position.brokerageName}
                </Link>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Net P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <Numeric
              value={position.netPnl}
              kind="money"
              currency={currency}
              direction="auto"
              className="text-lg font-semibold"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Return %</CardTitle>
          </CardHeader>
          <CardContent>
            <Numeric
              value={position.returnPercentage}
              kind="percent"
              direction="auto"
              className="text-lg font-semibold"
            />
          </CardContent>
        </Card>
      </div>

      {/* Double-fee warning */}
      {hasDoubleFeeRisk && (
        <div className="rounded-md border border-info/20 bg-info/10 p-3 text-sm text-foreground">
          This position has both manual fill fees and brokerage-calculated fees. Consider zeroing
          out manual fees to avoid double-counting.
        </div>
      )}

      {/* Position Info */}
      {position.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap">{position.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Fills */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Fills</h2>
          {!isClosed && (
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setFillDialogOpen(true)}
            >
              Add Fill
            </Button>
          )}
        </div>
        <FillTable
          fills={position.fills}
          positionId={positionId}
          positionStatus={position.status}
        />
      </div>

      {/* Edit Dialog */}
      <PositionEditDialog open={editOpen} onOpenChange={setEditOpen} position={position} />

      {/* Delete Confirmation */}
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
            <AlertDialogAction className="cursor-pointer" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Fill Dialog */}
      <FillDialog
        open={fillDialogOpen}
        onOpenChange={setFillDialogOpen}
        positionId={positionId}
        positionStatus={position.status}
        position={{
          accountId: position.accountId,
          assetType: position.assetType,
          side: position.side,
          openUnits: position.totalEntryQuantity - position.totalExitQuantity,
          avgEntryPrice: position.avgEntryPrice,
          targetPrice: position.targetPrice,
          stopLoss: position.stopLoss,
        }}
      />
    </div>
  );
}
