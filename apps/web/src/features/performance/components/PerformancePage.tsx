import { lazy, Suspense } from 'react';

import type { Granularity, PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { Skeleton } from '@/components/ui/skeleton';
import { isTimezoneRejected } from '@/lib/invalidTimezone';

import { isInvalidTimezoneError, usePerformance } from '../hooks/usePerformance';
import type { PerformancePreset } from '../utils/derivePresetRange';

import { BreakdownTable } from './BreakdownTable';
import { ChartChunkStaleBanner } from './ChartChunkStaleBanner';
import { CurrencySelector } from './CurrencySelector';
import { DataQualityBanner, hasAnyDataQualityIssue } from './DataQualityBanner';
import { EquityCurveChartSkeleton } from './EquityCurveChartSkeleton';
import { InvalidTimezoneBanner } from './InvalidTimezoneBanner';
import { PerformanceEmptyState } from './PerformanceEmptyState';
import { StatsPanel } from './StatsPanel';
import { TimeframeSelector } from './TimeframeSelector';
import { WeekStartChangedBanner } from './WeekStartChangedBanner';

// ---------------------------------------------------------------------------
// Lazy chart import
// ---------------------------------------------------------------------------
//
// `EquityCurveChart` is the sole importer of `recharts` in the app (Task 29).
// We `React.lazy` the whole module so Recharts ships in its own JS chunk that
// is only fetched the first time the user lands on `/performance`. The
// alias-aware Vite import lives at module scope so the dynamic-import path
// is statically analyzable — Vite needs that to emit the chunk.
const EquityCurveChart = lazy(() => import('@/features/performance/components/EquityCurveChart'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map the URL `granularity` to the canonical `PerformancePreset` for selector
 * highlighting and currency-change patch construction.
 *
 * The URL stores `granularity / start / end`, NOT the preset id. Multiple
 * presets share a granularity (`monthly`, `ytd`, `all-time` all use
 * `month`). Day → daily, week → weekly, year → yearly are unambiguous; for
 * `month` we default to `monthly` because it is the most common explicit
 * choice and produces a sensible 12-month range when the user changes
 * currency without changing the preset.
 */
function granularityToPreset(granularity: Granularity): PerformancePreset {
  switch (granularity) {
    case 'day':
      return 'daily';
    case 'week':
      return 'weekly';
    case 'year':
      return 'yearly';
    case 'month':
      return 'monthly';
  }
}

/** Pick the currency object for the active query, falling back to the first. */
function pickActiveCurrency(
  data: PerformanceResponse,
  requested: string | undefined,
): PerformanceResponse['currencies'][number] | null {
  if (data.currencies.length === 0) return null;
  if (requested) {
    const match = data.currencies.find((c) => c.code === requested);
    if (match) return match;
  }
  if (data.defaultCurrency) {
    const match = data.currencies.find((c) => c.code === data.defaultCurrency);
    if (match) return match;
  }
  return data.currencies[0] ?? null;
}

// ---------------------------------------------------------------------------
// PerformancePage
// ---------------------------------------------------------------------------

export interface PerformancePageProps {
  /** Validated performance query params from the route's `useSearch()`. */
  params: PerformanceQueryInput;
}

/**
 * Composes the full `/performance` page. Owns:
 *   - Loading skeletons
 *   - Banner stack (DataQuality, InvalidTimezone, WeekStartChanged)
 *   - Empty-state branches (PerformanceEmptyState)
 *   - Selectors (Timeframe + Currency) at the top
 *   - Lazy chart inside Suspense + ChunkErrorBoundary
 *   - StatsPanel + BreakdownTable
 *
 * Per Design §Component 7, this is the SINGLE composition site. The chart
 * module (Task 29) is intentionally agnostic about lazy-load failures — the
 * boundary lives here so the boundary's own code is in the main bundle and
 * survives the chunk fetch failure it is meant to render.
 */
export function PerformancePage({ params }: PerformancePageProps) {
  const { data, isLoading, isError, error } = usePerformance(params);

  // ---- Loading -----------------------------------------------------------
  // Show only skeletons during the first load — banners require fields from
  // the response, and the empty-state branch flags only exist post-fetch.
  if (isLoading) {
    return (
      <div data-testid="performance-page" className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-9 w-32" />
        </div>
        <EquityCurveChartSkeleton />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // ---- INVALID_TIMEZONE error -------------------------------------------
  // The hook's retry policy already swapped to UTC on the first failure (and
  // the swap may itself succeed). We render the banner only when the request
  // ultimately failed with INVALID_TIMEZONE — signalling that even the UTC
  // fallback did not resolve.
  //
  // `isSecondFailure` asks the ONE question its copy claims: did the request
  // that just failed omit `tz`? That is true exactly when this zone is the
  // recorded rejected one — the same predicate the hook uses to decide whether
  // to send `tz` — so the server was validating its own UTC default. A failure
  // that still CARRIED the user's zone is a first failure, and gets the banner
  // that names profile settings as the fix.
  if (isError && isInvalidTimezoneError(error)) {
    const isSecondFailure = isTimezoneRejected(params.tz);
    return (
      <div data-testid="performance-page" className="space-y-4">
        <InvalidTimezoneBanner isSecondFailure={isSecondFailure} />
      </div>
    );
  }

  // ---- Other errors → bubble to the root boundary -----------------------
  if (isError || !data) {
    // `usePerformance` re-throws non-401 errors from `queryFn`; React Query
    // surfaces them as `error` on the result. Anything we can't render
    // meaningfully here propagates to the root error boundary.
    if (error) throw error;
    return null;
  }

  const {
    resolvedTimezone,
    resolvedWeekStartDay,
    dataQuality,
    hasAnyAccounts,
    hasAnyClosedPositions,
    hasAnyClosedPositionsInSupportedCurrency,
    currencies,
  } = data;

  const activeCurrency = pickActiveCurrency(data, params.currency);
  const currencyCode = activeCurrency?.code ?? params.currency ?? data.defaultCurrency ?? '';

  // REQ-5.6 — When the hook retried with `tz` omitted and the server fell
  // back to UTC, the request *succeeded* but the user's requested timezone
  // was not honored. Detect that swap (this zone is the recorded rejected one
  // AND the server's resolved tz differs) so the populated/empty paths both
  // render the informational banner — the one carrying the settings remedy.
  // Once the zone is corrected the record clears, so the banner goes with it.
  const showUtcFallbackBanner = isTimezoneRejected(params.tz) && params.tz !== resolvedTimezone;

  // The "in-timeframe-empty" branch only fires when global flags are
  // satisfied (the upstream branches own those cases) AND the active
  // currency's series is empty.
  const isInTimeframeEmpty =
    hasAnyAccounts &&
    hasAnyClosedPositions &&
    hasAnyClosedPositionsInSupportedCurrency &&
    (activeCurrency?.series.length ?? 0) === 0;

  const showEmptyState =
    !hasAnyAccounts ||
    !hasAnyClosedPositions ||
    !hasAnyClosedPositionsInSupportedCurrency ||
    isInTimeframeEmpty;

  // ---- Empty-state path --------------------------------------------------
  if (showEmptyState) {
    return (
      <div data-testid="performance-page" className="space-y-4">
        <WeekStartChangedBanner />
        {showUtcFallbackBanner ? <InvalidTimezoneBanner isSecondFailure={false} /> : null}
        <PerformanceEmptyState
          hasAnyAccounts={hasAnyAccounts}
          hasAnyClosedPositions={hasAnyClosedPositions}
          hasAnyClosedPositionsInSupportedCurrency={hasAnyClosedPositionsInSupportedCurrency}
          isInTimeframeEmpty={isInTimeframeEmpty}
          dataQuality={dataQuality}
        />
      </div>
    );
  }

  // ---- Populated path ----------------------------------------------------
  // Active currency must exist by this point (one of the empty-state branches
  // would have fired if `currencies` were empty). Defensive fallback: if some
  // future change makes this path reachable with a null active currency, we
  // render the in-timeframe-empty state rather than producing a silent blank
  // page.
  if (!activeCurrency) {
    return (
      <div data-testid="performance-page" className="space-y-4">
        <WeekStartChangedBanner />
        {showUtcFallbackBanner ? <InvalidTimezoneBanner isSecondFailure={false} /> : null}
        <PerformanceEmptyState
          hasAnyAccounts={hasAnyAccounts}
          hasAnyClosedPositions={hasAnyClosedPositions}
          hasAnyClosedPositionsInSupportedCurrency={hasAnyClosedPositionsInSupportedCurrency}
          isInTimeframeEmpty={true}
          dataQuality={dataQuality}
        />
      </div>
    );
  }

  const currentPreset = granularityToPreset(params.granularity);
  const showDataQualityBanner = hasAnyDataQualityIssue(dataQuality);

  return (
    <div data-testid="performance-page" className="space-y-4">
      <WeekStartChangedBanner />
      {showUtcFallbackBanner ? <InvalidTimezoneBanner isSecondFailure={false} /> : null}
      {showDataQualityBanner ? <DataQualityBanner dataQuality={dataQuality} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TimeframeSelector
          value={currentPreset}
          currencyHistoryRange={activeCurrency.historyRange}
          resolvedTimezone={resolvedTimezone}
          resolvedWeekStartDay={resolvedWeekStartDay}
        />
        <CurrencySelector
          value={currencyCode}
          currencies={currencies}
          currentPreset={currentPreset}
          resolvedTimezone={resolvedTimezone}
          resolvedWeekStartDay={resolvedWeekStartDay}
        />
      </div>

      <ChunkErrorBoundary fallback={({ reload }) => <ChartChunkStaleBanner onReload={reload} />}>
        <Suspense fallback={<EquityCurveChartSkeleton />}>
          {/*
            This page stacks the chart in normal flow, so nothing above it
            gives the chart a height — it names its own, and 320px is the
            figure `EquityCurveChartSkeleton` mirrors so the swap does not
            move the page.
          */}
          <EquityCurveChart
            series={activeCurrency.equityCurve}
            currency={currencyCode}
            className="h-[320px]"
          />
        </Suspense>
      </ChunkErrorBoundary>

      <StatsPanel stats={activeCurrency.stats} currency={currencyCode} />

      <BreakdownTable
        series={activeCurrency.series}
        granularity={params.granularity}
        tz={resolvedTimezone}
        currency={currencyCode}
      />
    </div>
  );
}

export default PerformancePage;
