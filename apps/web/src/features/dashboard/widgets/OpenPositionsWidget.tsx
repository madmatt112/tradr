import { Link, useNavigate } from '@tanstack/react-router';

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
import { PositionRowActions } from '@/features/positions/components/PositionRowActions';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { shouldNavigateFromRowClick } from '@/features/positions/utils/rowNavigation';

const MAX_ROWS = 10;

/**
 * OpenPositionsWidget — dashboard widget showing up to 10 most recently
 * updated open positions (Req 6.2).
 *
 * Columns: symbol, side, asset type, quantity, opened date.
 * Unrealized P&L is intentionally NOT shown in v1 — Req 6.2 defers it to
 * the `ibkr-integration` spec.
 */
function OpenPositionsWidget() {
  const navigate = useNavigate();
  const { data: positions, isLoading } = usePositions({ status: 'open' });

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

  const rows = [...positions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_ROWS);

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
            <TableHead className="w-24 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((pos) => (
            <TableRow
              key={pos.id}
              className="cursor-pointer"
              onClick={(e) => {
                if (!shouldNavigateFromRowClick(e)) return;
                navigate({ to: '/positions/$positionId', params: { positionId: pos.id } });
              }}
            >
              <TableCell className="font-medium">
                <Link
                  to="/positions/$positionId"
                  params={{ positionId: pos.id }}
                  className="hover:underline"
                >
                  {pos.symbol}
                </Link>
              </TableCell>
              <TableCell className="capitalize">{pos.side}</TableCell>
              <TableCell className="capitalize">{pos.assetType}</TableCell>
              <TableCell className="text-right">
                <Numeric
                  value={pos.totalEntryQuantity - pos.totalExitQuantity}
                  kind="integer"
                  direction="none"
                />
              </TableCell>
              <TableCell>
                {pos.openedAt ? new Date(pos.openedAt).toLocaleDateString() : '—'}
              </TableCell>
              <TableCell>
                <PositionRowActions position={pos} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="text-right">
        <Link to="/positions" className="text-sm font-medium hover:underline">
          View all →
        </Link>
      </div>
    </div>
  );
}

export default OpenPositionsWidget;
