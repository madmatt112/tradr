import type { BreakdownQueryInput, PerformanceStats } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TagChip } from '@/features/tags/components/TagChip';

import { useBreakdown } from '../hooks/useBreakdown';
import { formatProfitFactor } from '../utils/formatPerformance';

// Group + five statistic columns (R6.3). Kept as one constant so the loading,
// empty and error states span the same width the header establishes (R6.6).
const COLUMN_COUNT = 6;
const SKELETON_ROWS = 6;

export interface DimensionBreakdownTableProps {
  /** The dimension to group by (URL `by=`). */
  by: BreakdownQueryInput['by'];
  /** The page's current window; the breakdown reuses its `start`/`end`/`tz` (R6.2). */
  params: Pick<BreakdownQueryInput, 'start' | 'end' | 'tz'>;
  /** The active currency code; formats money columns and scopes the request (DD4). */
  currency: string;
}

/**
 * The five statistic cells shared by every data row and the total row. The
 * `direction` choices mirror `StatsPanel` (`StatsPanel.tsx:40-69`): counts and
 * rates are neutral, money is signed; the profit-factor null branches route
 * through `formatProfitFactor` exactly as the panel does (`StatsPanel.tsx:56-66`).
 * A zero-count row's null rates render `Numeric`'s absent state (D8).
 */
function StatCells({ stats, currency }: { stats: PerformanceStats; currency: string }) {
  return (
    <>
      <TableCell className="text-right">
        <Numeric value={stats.totalPositions} kind="integer" direction="none" />
      </TableCell>
      <TableCell className="text-right">
        <Numeric value={stats.winRate} kind="percent" direction="none" />
      </TableCell>
      <TableCell className="text-right">
        <Numeric value={stats.totalNetPnl} kind="money" currency={currency} direction="auto" />
      </TableCell>
      <TableCell className="text-right">
        {stats.profitFactor !== null ? (
          <Numeric value={stats.profitFactor} kind="decimal" direction="none" />
        ) : (
          <span>{formatProfitFactor(stats.profitFactor, stats.hasWins, stats.hasLosses)}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Numeric value={stats.expectancy} kind="money" currency={currency} direction="auto" />
      </TableCell>
    </>
  );
}

/**
 * DimensionBreakdownTable — the per-dimension statistics table (design Component
 * 15, R6). It reads its own data through `useBreakdown` keyed by the page window
 * and the active currency, and renders one `Table` with the columns Group,
 * Positions, Win rate, Net P&L, Profit factor, Expectancy (R6.3).
 *
 * It never replaces the page: loading, empty and error all stay inside the table
 * and preserve the column geometry (R6.6). The time-bucket `BreakdownTable`
 * (`BreakdownTable.tsx`, testid `breakdown-table`) is a separate table; this one
 * carries its own testid.
 *
 * Whether a total row appears is driven by the response's `multiValued` flag,
 * never by inspecting the dimension (R3.6): a single-valued dimension ends with a
 * reconciling total row (R6.4); the multi-valued tag dimension shows an
 * explanatory sentence instead (R6.5).
 */
export function DimensionBreakdownTable({ by, params, currency }: DimensionBreakdownTableProps) {
  const query = useBreakdown({
    by,
    start: params.start,
    end: params.end,
    tz: params.tz,
    currency,
  });

  const data = query.data;
  // The page always requests the active currency, so the response carries a
  // single entry for that code (DD4); match it, falling back to the first.
  const currencyEntry = data?.currencies.find((c) => c.code === currency) ?? data?.currencies[0];
  const rows = currencyEntry?.rows ?? [];

  const multiValued = data?.multiValued ?? false;
  const showTotalRow =
    query.status === 'success' && rows.length > 0 && !multiValued && currencyEntry !== undefined;
  const showTagSentence = query.status === 'success' && multiValued;

  let bodyContent;
  if (query.status === 'pending') {
    bodyContent = Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
      <TableRow key={rowIndex} data-testid="dimension-breakdown-skeleton-row">
        {Array.from({ length: COLUMN_COUNT }, (_, cellIndex) => (
          <TableCell key={cellIndex}>
            <Skeleton className="h-4 w-full" />
          </TableCell>
        ))}
      </TableRow>
    ));
  } else if (query.status === 'error') {
    bodyContent = (
      <EmptyState.Table
        colSpan={COLUMN_COUNT}
        message={
          <span className="inline-flex items-center gap-2">
            Couldn&apos;t load this breakdown.
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </span>
        }
      />
    );
  } else if (rows.length === 0) {
    // Only `symbol` can be empty; weekday/hour/tag always carry their fixed rows (D8).
    bodyContent = (
      <EmptyState.Table colSpan={COLUMN_COUNT} message="No closed positions in this timeframe." />
    );
  } else {
    bodyContent = rows.map((row) => (
      <TableRow key={row.key}>
        <TableCell className="font-medium">
          {/* A tag row renders the same chip the tag list uses; every other key
              (including the symbol) renders as text, never markup (NFR-Security). */}
          {row.tag !== null ? <TagChip tag={row.tag} /> : row.label}
        </TableCell>
        <StatCells stats={row.stats} currency={currency} />
      </TableRow>
    ));
  }

  return (
    <div data-testid="dimension-breakdown-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Group</TableHead>
            <TableHead className="text-right">Positions</TableHead>
            <TableHead className="text-right">Win rate</TableHead>
            <TableHead className="text-right">Net P&L</TableHead>
            <TableHead className="text-right">Profit factor</TableHead>
            <TableHead className="text-right">Expectancy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{bodyContent}</TableBody>
        {showTotalRow && currencyEntry ? (
          <TableFooter>
            <TableRow data-testid="dimension-breakdown-total">
              <TableCell className="font-medium">Closed positions in range</TableCell>
              <StatCells stats={currencyEntry.total} currency={currency} />
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      {showTagSentence ? (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="dimension-breakdown-note">
          A position with several tags counts in each row; Untagged completes the picture.
        </p>
      ) : null}
    </div>
  );
}

export default DimensionBreakdownTable;
