import { Link, useNavigate } from '@tanstack/react-router';

import type { PositionListEntry, PositionListItem } from '@tradr/shared';
import { computeUnrealised } from '@tradr/shared';


import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CostBasisOnly } from '@/features/positions/components/CostBasisOnly';
import { PastExpiryChip } from '@/features/positions/components/PastExpiryChip';
import { PositionGroupRowActions } from '@/features/positions/components/PositionGroupRowActions';
import { PositionRowActions } from '@/features/positions/components/PositionRowActions';
import { QuoteStaleness } from '@/features/positions/components/QuoteStaleness';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { firstOpenLegId, isGroupEntry } from '@/features/positions/utils/listEntries';
import { markReason, quoteSymbolsFor } from '@/features/positions/utils/markToMarket';
import { shouldNavigateFromRowClick } from '@/features/positions/utils/rowNavigation';
import { oldestFetchedAt, useStockQuotes } from '@/hooks/useStockQuotes';

export const OPEN_POSITIONS_ROW_CAP = 5;

/**
 * OpenPositionsWidget — dashboard widget showing up to five most recently
 * updated open positions (Req 6.2).
 *
 * Columns: symbol, side, asset type, quantity, opened date. When the stock
 * quote provider is configured (design C10), three more columns appear
 * before Actions — Last, Unrealised P&L and Unrealised % — for every row
 * eligible to be marked to market; a group, option or non-USD row instead
 * shows a single "Cost basis only" cell with its reason (Requirement 4).
 * Not configured, the table is exactly as it was before this feature
 * (Requirement 1.3).
 */
function reasonFor(entry: PositionListEntry): string | null {
  if (isGroupEntry(entry)) {
    return markReason({
      isGroup: true,
      groupId: null,
      assetType: 'stock',
      accountCurrency: entry.accountCurrency,
    });
  }
  return markReason({
    isGroup: false,
    groupId: null,
    assetType: entry.assetType,
    accountCurrency: entry.accountCurrency,
  });
}

function OpenPositionsWidget() {
  const navigate = useNavigate();
  const { data: positions, isLoading } = usePositions({ status: 'open' });

  const rows = positions
    ? [...positions]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, OPEN_POSITIONS_ROW_CAP)
    : [];

  const { configured, quote } = useStockQuotes(quoteSymbolsFor(rows));

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <EmptyState
        title="No open positions. Create one to get started."
        action={
          <Link to="/positions" className="text-sm font-medium underline">
            New position
          </Link>
        }
      />
    );
  }

  const priceCells = configured
    ? rows
        .filter((entry): entry is PositionListItem => !isGroupEntry(entry) && reasonFor(entry) === null)
        .map((entry) => quote(entry.symbol))
    : [];

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Asset</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead>Opened</TableHead>
            {configured && (
              <>
                <TableHead className="text-right">Last</TableHead>
                <TableHead className="text-right">Unrealised P&L</TableHead>
                <TableHead className="text-right">Unrealised %</TableHead>
              </>
            )}
            <TableHead className="w-24 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => {
            if (isGroupEntry(entry)) {
              const targetId = firstOpenLegId(entry);
              const reason = reasonFor(entry);
              return (
                <TableRow
                  key={entry.id}
                  className="cursor-pointer"
                  onClick={(e) => {
                    if (!shouldNavigateFromRowClick(e)) return;
                    navigate({ to: '/positions/$positionId', params: { positionId: targetId } });
                  }}
                >
                  <TableCell className="font-medium">
                    <Link
                      to="/positions/$positionId"
                      params={{ positionId: targetId }}
                      className="hover:underline max-md:inline-flex max-md:min-h-6 max-md:min-w-6 max-md:items-center"
                    >
                      {entry.underlying} {entry.label}
                    </Link>
                    {!!entry.pastExpiryLegCount && (
                      <PastExpiryChip count={entry.pastExpiryLegCount} />
                    )}
                  </TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell>
                    {entry.openedAt ? new Date(entry.openedAt).toLocaleDateString() : '—'}
                  </TableCell>
                  {configured && reason && (
                    <TableCell colSpan={3}>
                      <CostBasisOnly reason={reason} variant="tooltip" />
                    </TableCell>
                  )}
                  <TableCell>
                    <PositionGroupRowActions group={entry} />
                  </TableCell>
                </TableRow>
              );
            }

            const reason = reasonFor(entry);
            const cell = configured && reason === null ? quote(entry.symbol) : null;
            const unrealised =
              cell && cell.state === 'price'
                ? computeUnrealised({
                    side: entry.side,
                    openQty: entry.totalEntryQuantity - entry.totalExitQuantity,
                    openCostBasis: entry.openCostBasis,
                    lastPrice: cell.lastPrice,
                    currency: entry.accountCurrency,
                  })
                : null;
            const numericState = cell?.state === 'loading' ? 'loading' : 'value';

            return (
              <TableRow
                key={entry.id}
                className="cursor-pointer"
                onClick={(e) => {
                  if (!shouldNavigateFromRowClick(e)) return;
                  navigate({ to: '/positions/$positionId', params: { positionId: entry.id } });
                }}
              >
                <TableCell className="font-medium">
                  <Link
                    to="/positions/$positionId"
                    params={{ positionId: entry.id }}
                    className="hover:underline max-md:inline-flex max-md:min-h-6 max-md:min-w-6 max-md:items-center"
                  >
                    {entry.symbol}
                  </Link>
                  {entry.pastExpiryUnsettled && <PastExpiryChip />}
                </TableCell>
                <TableCell className="capitalize">{entry.side}</TableCell>
                <TableCell className="capitalize">{entry.assetType}</TableCell>
                <TableCell className="text-right">
                  <Numeric
                    value={entry.totalEntryQuantity - entry.totalExitQuantity}
                    kind="integer"
                    direction="none"
                  />
                </TableCell>
                <TableCell>
                  {entry.openedAt ? new Date(entry.openedAt).toLocaleDateString() : '—'}
                </TableCell>
                {configured && reason !== null && (
                  <TableCell colSpan={3}>
                    <CostBasisOnly reason={reason} variant="tooltip" />
                  </TableCell>
                )}
                {configured && reason === null && (
                  <>
                    <TableCell className="text-right">
                      <Numeric
                        value={cell?.state === 'price' ? cell.lastPrice : null}
                        kind="money"
                        currency={entry.accountCurrency}
                        direction="none"
                        state={numericState}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Numeric
                        value={unrealised ? unrealised.unrealisedPnl : null}
                        kind="money"
                        direction="auto"
                        state={numericState}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Numeric
                        value={unrealised ? unrealised.unrealisedPercent : null}
                        kind="percent"
                        precision={2}
                        direction="auto"
                        state={numericState}
                      />
                    </TableCell>
                  </>
                )}
                <TableCell>
                  <PositionRowActions position={entry} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-3">
        {configured && <QuoteStaleness oldestFetchedAt={oldestFetchedAt(priceCells)} />}
        <Link
          to="/positions"
          className="text-sm font-medium hover:underline max-md:inline-flex max-md:min-h-6 max-md:items-center"
        >
          View all {positions.length} open positions
        </Link>
      </div>
    </div>
  );
}

export default OpenPositionsWidget;
