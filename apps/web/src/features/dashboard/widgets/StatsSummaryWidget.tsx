import type { ReactNode } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { TierWindowNotice } from '@/features/performance/components/TierWindowNotice';
import { usePresetPerformance } from '@/features/performance/hooks/usePresetPerformance';
import { formatProfitFactor } from '@/features/performance/utils/formatPerformance';
import { useUserTimezone } from '@/hooks/useUserTimezone';

interface StatTile {
  label: string;
  render: () => ReactNode;
}

/**
 * StatsSummaryWidget — dashboard widget rendering five all-time statistic
 * tiles for the user's display currency (Design §10.2, Req 6.1).
 *
 * Data flow:
 *   1. Resolve `displayCurrency` from `useDisplayCurrencyQuery()`.
 *   2. Compute {start, end} via `derivePresetRange('all-time', historyRange, ...)`
 *      anchored at the user's stored reporting timezone (`useUserTimezone` —
 *      NOT the browser's zone).
 *      On first render `historyRange = DEFAULT_CURRENCY_HISTORY_RANGE` (§B);
 *      once the response lands `usePresetPerformance` re-derives the window
 *      from the currency entry's real `historyRange`, so "all-time" reaches the
 *      account's earliest close instead of stopping at the current month.
 *   3. Fetch via `usePerformance({ granularity: 'year', start, end, tz, currency })`,
 *      passing `null` until the stored zone lands so nothing is bucketed by a guess.
 *   4. Pick the currency entry via `response.currencies.find(c => c.code === displayCurrency)`
 *      (§A — array form, NOT record indexing) and read `.stats`.
 */
function StatsSummaryWidget() {
  const { data: displayCurrencyData } = useDisplayCurrencyQuery();
  const displayCurrency = displayCurrencyData?.currency ?? null;

  // The user's STORED reporting timezone, not the browser's — `undefined`
  // until that query settles.
  const timezone = useUserTimezone();

  const { query: performanceQuery, currencyData } = usePresetPerformance({
    preset: 'all-time',
    timezone,
    currency: displayCurrency,
    granularity: 'year',
  });

  const { data: response, isLoading, isError, error, refetch } = performanceQuery;

  // A disabled query reports `isLoading: false`, so the wait for the stored
  // zone has to be spelled out here — otherwise the widget would drop through
  // to its empty state and flash "Close a position…" before the first fetch.
  if (timezone === undefined || isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 5 }).map((_, idx) => (
          <div key={idx} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : 'Failed to load stats';
    return (
      <EmptyState
        title="Couldn't load stats"
        description={message}
        action={
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const stats = currencyData?.stats ?? null;

  // L3 clamp notice (plan-tiers REQ-7.3) — non-blocking; the all-time preset
  // this widget uses is clamped for enforced free users.
  const tierWindowNotice = response?.tierWindow ? (
    <TierWindowNotice tierWindow={response.tierWindow} surface="dashboard-widget" />
  ) : null;

  if (currencyData == null || stats == null || (!stats.hasWins && !stats.hasLosses)) {
    return (
      <div className="flex flex-col gap-3">
        {tierWindowNotice}
        <EmptyState title="Close a position to see stats." />
      </div>
    );
  }

  const code = currencyData.code;
  const tiles: StatTile[] = [
    {
      label: 'Total Net P&L',
      render: () => (
        <Numeric value={stats.totalNetPnl} kind="money" currency={code} direction="auto" />
      ),
    },
    {
      label: 'Win Rate',
      render: () => <Numeric value={stats.winRate} kind="percent" direction="none" />,
    },
    {
      label: 'Avg Win',
      render: () => <Numeric value={stats.avgWin} kind="money" currency={code} direction="auto" />,
    },
    {
      label: 'Avg Loss',
      render: () => <Numeric value={stats.avgLoss} kind="money" currency={code} direction="auto" />,
    },
    {
      label: 'Profit Factor',
      // Finite profit factor routes through the primitive (neutral decimal); the
      // ∞ / em-dash branches the primitive does not model stay on formatProfitFactor.
      render: () =>
        stats.profitFactor !== null ? (
          <Numeric value={stats.profitFactor} kind="decimal" direction="none" />
        ) : (
          <span>{formatProfitFactor(stats.profitFactor, stats.hasWins, stats.hasLosses)}</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {tierWindowNotice}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="flex flex-col">
            <dt className="text-sm text-muted-foreground">{tile.label}</dt>
            <dd className="font-medium">{tile.render()}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default StatsSummaryWidget;
