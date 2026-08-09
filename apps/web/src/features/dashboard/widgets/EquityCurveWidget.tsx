import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import EquityCurveChart from '@/features/performance/components/EquityCurveChart';
import { TierWindowNotice } from '@/features/performance/components/TierWindowNotice';
import { usePresetPerformance } from '@/features/performance/hooks/usePresetPerformance';
import { useUserTimezone } from '@/hooks/useUserTimezone';

/**
 * EquityCurveWidget — dashboard widget rendering the cumulative net P&L
 * curve for the user's display currency (Design §10.2, Req 6.6).
 *
 * Data flow mirrors `StatsSummaryWidget` (Task 37):
 *   1. Resolve `displayCurrency` from `useDisplayCurrencyQuery()`.
 *   2. Compute {start, end} via `derivePresetRange('all-time', ...)` anchored at
 *      the user's stored reporting timezone (`useUserTimezone` — NOT the
 *      browser's zone). The first request bootstraps with
 *      `DEFAULT_CURRENCY_HISTORY_RANGE` (§B); once the response lands,
 *      `usePresetPerformance` re-derives the window from the real
 *      `historyRange`, so "all-time" reaches the account's earliest close
 *      instead of stopping at the current month.
 *   3. Fetch via `usePerformance({ granularity: 'month', ... })`, passing `null`
 *      until the stored zone lands so nothing is bucketed by a guess.
 *   4. Pick the currency entry via `response.currencies.find(c => c.code === displayCurrency)`
 *      (§A — array form, NOT record indexing) and read `.equityCurve`.
 */
function EquityCurveWidget() {
  const { data: displayCurrencyData } = useDisplayCurrencyQuery();
  const displayCurrency = displayCurrencyData?.currency ?? null;

  const timezone = useUserTimezone();

  const { query: performanceQuery, currencyData } = usePresetPerformance({
    preset: 'all-time',
    timezone,
    currency: displayCurrency,
    granularity: 'month',
  });

  const { data: response, isLoading, isError, error, refetch } = performanceQuery;

  // A disabled query reports `isLoading: false`, so the wait for the stored
  // zone has to be spelled out here — otherwise the widget would drop through
  // to its empty state before the first fetch.
  if (timezone === undefined || isLoading) {
    return <Skeleton className="h-[320px] w-full" />;
  }

  if (isError) {
    const message = error instanceof Error ? error.message : 'Failed to load equity curve';
    return (
      <EmptyState
        title="Couldn't load equity curve"
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

  // L3 clamp notice (plan-tiers REQ-7.3) — non-blocking; the all-time preset
  // this widget uses is clamped for enforced free users.
  const tierWindowNotice = response?.tierWindow ? (
    <TierWindowNotice tierWindow={response.tierWindow} surface="dashboard-widget" />
  ) : null;

  if (currencyData == null) {
    return (
      <div className="flex flex-col gap-3">
        {tierWindowNotice}
        <EmptyState title="Close a position in this currency to see your equity curve." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {tierWindowNotice}
      <EquityCurveChart series={currencyData.equityCurve} currency={currencyData.code} />
    </div>
  );
}

export default EquityCurveWidget;
