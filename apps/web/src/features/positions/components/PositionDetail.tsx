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
import { formatCurrency } from '@/lib/format';

import {
  usePosition,
  useDeletePosition,
  useOpenPosition,
  useClosePosition,
  useReopenPosition,
} from '../hooks/usePosition';
import { decodeOptionContract } from '../utils/optionContract';

// R13 same-day reopen visibility: a closed position may be reopened only while
// its openedAt still falls on the current trading day in the ACCOUNT's timezone
// (never UTC — a US-Eastern evening session crosses UTC midnight but stays one
// trading day). Compares the zone-local YYYY-MM-DD keys of openedAt and now via
// Intl 'en-CA' (ISO order), mirroring the server's authoritative zonedDateKey.
// Fallback: if the account timezone is somehow unavailable, show the button and
// let the server's 409 surface as a toast rather than hiding a valid action.
function isOpenedTodayInAccountTz(
  openedAt: string | null,
  accountTimezone: string | undefined,
  now: Date,
): boolean {
  if (!accountTimezone) return true;
  if (openedAt === null) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: accountTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(openedAt)) === fmt.format(now);
}

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

  const hasEntryFills = position.fills.some((f) => f.type === 'entry');
  const canOpen = isDraft && hasEntryFills;
  const isFullyExited =
    position.totalEntryQuantity > 0 && position.totalEntryQuantity === position.totalExitQuantity;
  const canClose = isOpen && isFullyExited;

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
          {canOpen && (
            <Button
              className="cursor-pointer"
              onClick={() => openPosition.mutate({})}
              disabled={openPosition.isPending}
            >
              {openPosition.isPending ? 'Opening...' : 'Open Position'}
            </Button>
          )}
          {canClose && (
            <Button
              className="cursor-pointer"
              onClick={() => closePosition.mutate({})}
              disabled={closePosition.isPending}
            >
              {closePosition.isPending ? 'Closing...' : 'Close Position'}
            </Button>
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
            <AlertDialogDescription>
              {isClosed
                ? "Deleting this closed position removes its realized P&L from the account balance and from tax and performance summaries — including prior tax years — and may change other positions' wash-sale classification. This cannot be undone."
                : 'Are you sure you want to delete this position? This cannot be undone.'}
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
      />
    </div>
  );
}
