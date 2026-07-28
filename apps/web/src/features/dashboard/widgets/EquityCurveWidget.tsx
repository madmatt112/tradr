import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import EquityCurveChart from '@/features/performance/components/EquityCurveChart';
import { TierWindowNotice } from '@/features/performance/components/TierWindowNotice';
import { usePerformance } from '@/features/performance/hooks/usePerformance';
import {
  DEFAULT_CURRENCY_HISTORY_RANGE,
  derivePresetRange,
} from '@/features/performance/utils/derivePresetRange';

/** Resolve the browser's IANA timezone, falling back to UTC. */
function resolveBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * EquityCurveWidget — dashboard widget rendering the cumulative net P&L
 * curve for the user's display currency (Design §10.2, Req 6.6).
 *
 * Data flow mirrors `StatsSummaryWidget` (Task 37):
 *   1. Resolve `displayCurrency` from `useDisplayCurrencyQuery()`.
 *   2. Compute {start, end} via `derivePresetRange('all-time', ...)`. On first
 *      render we use `DEFAULT_CURRENCY_HISTORY_RANGE` (§B) + browser tz.
 *   3. Fetch via `usePerformance({ granularity: 'month', ... })`.
 *   4. Pick the currency entry via `response.currencies.find(c => c.code === displayCurrency)`
 *      (§A — array form, NOT record indexing) and read `.equityCurve`.
 */
function EquityCurveWidget() {
  const { data: displayCurrencyData } = useDisplayCurrencyQuery();
  const displayCurrency = displayCurrencyData?.currency ?? null;

  const browserTz = resolveBrowserTimezone();
  const defaultWeekStart = 1 as const;

  const bootstrapRange = derivePresetRange(
    'all-time',
    DEFAULT_CURRENCY_HISTORY_RANGE,
    new Date(),
    browserTz,
    defaultWeekStart,
  );

  const performanceQuery = usePerformance({
    granularity: 'month',
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
