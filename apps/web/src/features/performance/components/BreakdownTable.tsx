import type { Granularity, SeriesBucket } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { formatBucketLabel } from '../utils/formatPerformance';

export interface BreakdownTableProps {
  series: ReadonlyArray<SeriesBucket>;
  granularity: Granularity;
  /** Resolved IANA timezone (per REQ-6.6 server fallback). */
  tz: string;
  /** ISO 4217 code used to format money columns. */
  currency: string;
}

/**
 * BreakdownTable — one row per bucket from the `series` array. Bucket labels
 * are formatted via `formatBucketLabel` so the granularity-driven label rules
 * (REQ-1.2 / Task 30 prompt) are tested in one place.
 *
 * Money cells use `formatMoney` (re-exported from `@/lib/format` per Task 3).
 * No cross-feature reach into `positions/utils`.
 */
export function BreakdownTable({ series, granularity, tz, currency }: BreakdownTableProps) {
  return (
    <div data-testid="breakdown-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Positions</TableHead>
            <TableHead className="text-right">Wins</TableHead>
            <TableHead className="text-right">Losses</TableHead>
            <TableHead className="text-right">Breakevens</TableHead>
            <TableHead className="text-right">Net P&L</TableHead>
            <TableHead className="text-right">Gross P&L</TableHead>
            <TableHead className="text-right">Fees</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.length === 0 ? (
            // Table-shaped empty variant (R4.4): the message spans all 8 columns
            // so the header's column geometry is preserved instead of collapsing.
            <EmptyState.Table colSpan={8} message="No buckets in this timeframe." />
          ) : null}
          {series.map((bucket) => (
            <TableRow key={bucket.bucketStart}>
              <TableCell className="font-medium">
                {formatBucketLabel(bucket.bucketStart, granularity, tz)}
              </TableCell>
              <TableCell className="text-right">
                <Numeric value={bucket.totalPositions} kind="integer" direction="none" />
              </TableCell>
              <TableCell className="text-right">
                <Numeric value={bucket.wins} kind="integer" direction="none" />
              </TableCell>
              <TableCell className="text-right">
                <Numeric value={bucket.losses} kind="integer" direction="none" />
              </TableCell>
              <TableCell className="text-right">
                <Numeric value={bucket.breakevens} kind="integer" direction="none" />
              </TableCell>
              <TableCell className="text-right">
                <Numeric value={bucket.netPnl} kind="money" currency={currency} direction="auto" />
              </TableCell>
              <TableCell className="text-right">
                <Numeric
                  value={bucket.grossPnl}
                  kind="money"
                  currency={currency}
                  direction="auto"
                />
              </TableCell>
              <TableCell className="text-right">
                <Numeric value={bucket.fees} kind="money" currency={currency} direction="none" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default BreakdownTable;
