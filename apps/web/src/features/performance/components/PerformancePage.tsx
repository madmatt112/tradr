import { Component, lazy, Suspense, type ReactNode } from 'react';

import type { Granularity, PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

import { Skeleton } from '@/components/ui/skeleton';

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
import { TierWindowNotice } from './TierWindowNotice';
import { TimeframeSelector } from './TimeframeSelector';
import { WeekStartChangedBanner } from './WeekStartChangedBanner';

const INVALID_TZ_SEEN_KEY = 'perf.invalid_tz_seen';

/**
 * Read the session flag set by `performanceRetry` when it retried with `tz`
 * omitted. Used at the populated path to detect "retry succeeded → fell back
 * to UTC" so the informational `InvalidTimezoneBanner` can render alongside
 * the data. Try/catch handles Safari private mode where storage throws.
 */
function readInvalidTzSeenSafe(): boolean {
  try {
    return sessionStorage.getItem(INVALID_TZ_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

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
// Vite chunk-404 detection
// ---------------------------------------------------------------------------
//
// When a deploy happens while the user is on the page, the lazy chunk's
// hashed filename in the running HTML may no longer exist on the server.
// Vite throws errors with one of these two messages depending on the browser
// (Chrome / Firefox vs. Safari). Anything else propagates to the root
// boundary unmodified.
const VITE_CHUNK_404_REGEX =
  /Failed to fetch dynamically imported module|Importing a module script failed/i;

function isChunkLoadError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const message =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown }).message === 'string'
          ? (err as { message: string }).message
          : '';
  return VITE_CHUNK_404_REGEX.test(message);
}

interface ChartErrorBoundaryProps {
  children: ReactNode;
  /** Override the reload action — primarily used by tests to assert wiring. */
  onReload?: () => void;
}

type ChartErrorBoundaryState =
  | { kind: 'idle' }
  | { kind: 'chunk' }
  | { kind: 'rethrow'; error: Error };

/**
 * Error boundary scoped to the lazy chart. Catches *only* the Vite chunk-404
 * pattern and renders `ChartChunkStaleBanner`; any other error is re-thrown
 * from `render()` so the next boundary above (the root error boundary)
 * handles it.
 *
 * We deliberately keep this inline rather than reaching for a library — the
 * detection logic is one regex and a tiny class component, and dragging in a
 * boundary library would balloon the surface area.
 */
export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  state: ChartErrorBoundaryState = { kind: 'idle' };

  static getDerivedStateFromError(error: unknown): ChartErrorBoundaryState {
    if (isChunkLoadError(error)) return { kind: 'chunk' };
    // Coerce non-Error throwables into an Error so the rethrow path always
    // propagates a sensible value. React only ever surfaces `unknown` here.
    const err = error instanceof Error ? error : new Error(String(error));
    return { kind: 'rethrow', error: err };
  }

  componentDidCatch(): void {
    // Intentionally empty: state transitions in `getDerivedStateFromError`
    // drive what `render()` does, including re-throwing non-chunk errors so
    // the parent boundary catches them.
  }

  render(): ReactNode {
    if (this.state.kind === 'chunk') {
      return <ChartChunkStaleBanner onReload={this.props.onReload} />;
    }
    if (this.state.kind === 'rethrow') {
      // Throwing from `render()` lets React's reconciler propagate the error
      // up to the next boundary, instead of leaving this boundary in a state
      // where it keeps re-rendering children that already threw.
      throw this.state.error;
    }
    return this.props.children;
  }
}

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
 *   - Lazy chart inside Suspense + ChartErrorBoundary
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
  // fallback did not resolve. `isSecondFailure` reflects the session flag the
  // hook wrote on its first observation.
  if (isError && isInvalidTimezoneError(error)) {
    let isSecondFailure = false;
    try {
      isSecondFailure = sessionStorage.getItem('perf.invalid_tz_seen') === 'true';
    } catch {
      // sessionStorage unavailable (Safari private mode) — treat as first
      // failure; the banner is still informational.
      isSecondFailure = false;
    }
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
  // was not honored. Detect that swap (session flag set AND server's
  // resolved tz differs from the requested tz) so the populated/empty paths
  // both render the informational banner.
  const showUtcFallbackBanner = readInvalidTzSeenSafe() && params.tz !== resolvedTimezone;

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

  // L3 lookback-clamp notice (plan-tiers REQ-7.3): non-blocking, rendered on
  // the populated AND empty paths — a fully-pre-boundary preset shows the
  // deliberate empty state with this same notice. Server-set only when the
  // free-tier floor actually clamped, so gating-off renders nothing.
  const tierWindowNotice = data.tierWindow ? (
    <TierWindowNotice tierWindow={data.tierWindow} surface="performance" />
  ) : null;

  // ---- Empty-state path --------------------------------------------------
  if (showEmptyState) {
    return (
      <div data-testid="performance-page" className="space-y-4">
        <WeekStartChangedBanner />
        {showUtcFallbackBanner ? <InvalidTimezoneBanner isSecondFailure={false} /> : null}
        {tierWindowNotice}
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
        {tierWindowNotice}
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
      {tierWindowNotice}

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

      <ChartErrorBoundary>
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
      </ChartErrorBoundary>

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
