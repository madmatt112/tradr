import type { ReactNode } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { TierWindowNotice } from '@/features/performance/components/TierWindowNotice';
import { usePerformance } from '@/features/performance/hooks/usePerformance';
import {
  DEFAULT_CURRENCY_HISTORY_RANGE,
  derivePresetRange,
} from '@/features/performance/utils/derivePresetRange';
import { formatProfitFactor } from '@/features/performance/utils/formatPerformance';

/** Resolve the browser's IANA timezone, falling back to UTC. */
function resolveBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

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
 *   2. Compute {start, end} via `derivePresetRange('all-time', historyRange, ...)`.
 *      On first render `historyRange = DEFAULT_CURRENCY_HISTORY_RANGE` (§B);
 *      once the response lands we use the currency entry's `historyRange`.
 *   3. Fetch via `usePerformance({ granularity: 'year', start, end, tz, currency })`.
 *   4. Pick the currency entry via `response.currencies.find(c => c.code === displayCurrency)`
 *      (§A — array form, NOT record indexing) and read `.stats`.
 */
function StatsSummaryWidget() {
  const { data: displayCurrencyData } = useDisplayCurrencyQuery();
  const displayCurrency = displayCurrencyData?.currency ?? null;

  // Browser-resolved tz/week-start are the bootstrap values; once a response
  // lands we prefer its `resolvedTimezone` / `resolvedWeekStartDay`.
  const browserTz = resolveBrowserTimezone();
  const defaultWeekStart = 1 as const;

  // -------- First-render bootstrap ----------
  // We don't yet have a response, so we can't read historyRange or resolvedTz
  // from it. Use DEFAULT_CURRENCY_HISTORY_RANGE + browser tz.
  const bootstrapRange = derivePresetRange(
    'all-time',
    DEFAULT_CURRENCY_HISTORY_RANGE,
    new Date(),
    browserTz,
    defaultWeekStart,
  );

  const performanceQuery = usePerformance({
    granularity: 'year',
    start: bootstrapRange.start,
    end: bootstrapRange.end,
    tz: browserTz,
    ...(displayCurrency ? { currency: displayCurrency } : {}),
  });

  const { data: response, isLoading, isError, error, refetch } = performanceQuery;

  // §A — currencies is an ARRAY: use find(), not record-style indexing.
  const currencyData =
    displayCurrency != null
      ? (response?.currencies.find((c) => c.code === displayCurrency) ?? null)
      : null;

  if (isLoading) {
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
