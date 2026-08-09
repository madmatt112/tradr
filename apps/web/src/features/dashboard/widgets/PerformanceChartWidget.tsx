import { useEffect } from 'react';

import type { WidgetPlacement } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import PerformanceBarChart from '@/features/performance/components/PerformanceBarChart';
import { TierWindowNotice } from '@/features/performance/components/TierWindowNotice';
import { usePresetPerformance } from '@/features/performance/hooks/usePresetPerformance';
import { useTimeframeSelection } from '@/features/performance/hooks/useTimeframeSelection';
import { type PerformancePreset } from '@/features/performance/utils/derivePresetRange';
import { useUserTimezone } from '@/hooks/useUserTimezone';

import { widgetRegistry } from './registry';

const DEFAULT_TIMEFRAME: PerformancePreset = 'monthly';

export interface PerformanceChartWidgetProps {
  placement: WidgetPlacement;
  onUpdateConfig: (config: Record<string, unknown>) => void;
}

/**
 * PerformanceChartWidget — dashboard widget rendering a vertical bar chart of
 * per-bucket net P&L for the user's display currency (Design §10.4, Req 6.3).
 *
 * Data flow (per design Component 10.4):
 *   1. Parse `placement.config` against `widgetRegistry['performance-chart'].configSchema`.
 *      On failure render with `defaultConfig` AND emit a fix-up via `onUpdateConfig`
 *      (§K — the fix-up flows through the debounced layout state; NO separate PUT).
 *   2. Resolve `displayCurrency` from `useDisplayCurrencyQuery()`.
 *   3. Compute {granularity, start, end} via `derivePresetRange(config.timeframe, ...)`
 *      anchored at the user's stored reporting timezone (`useUserTimezone` —
 *      NOT the browser's zone).
 *      The historyRange comes from the previous response's `currencyData.historyRange`
 *      (§B — first render bootstraps with `DEFAULT_CURRENCY_HISTORY_RANGE`).
 *   4. Fetch via `usePerformance`, passing `null` until the stored zone lands so
 *      nothing is bucketed by a guess.
 *   5. Pick the currency entry via `response.currencies.find(c => c.code === displayCurrency)`
 *      (§A — array form, NOT record indexing) and read `.series`.
 */
function PerformanceChartWidget({ placement, onUpdateConfig }: PerformanceChartWidgetProps) {
  const def = widgetRegistry['performance-chart'];
  // configSchema/defaultConfig are guaranteed by the registry entry for this type.
  const configSchema = def.configSchema!;
  const defaultConfig = def.defaultConfig as { timeframe: PerformancePreset };

  const parseResult = configSchema.safeParse(placement.config);
  const config = parseResult.success
    ? (parseResult.data as { timeframe: PerformancePreset })
    : defaultConfig;
  const parseSucceeded = parseResult.success;

  // §K — On parse failure, emit a fix-up so the layout state self-heals.
  // The fix-up flows through `scheduleLayoutWrite` (debounced PUT); we do NOT
  // issue a separate PUT here.
  useEffect(() => {
    if (!parseSucceeded) {
      onUpdateConfig({ timeframe: DEFAULT_TIMEFRAME });
    }
  }, [parseSucceeded, onUpdateConfig]);

  const { data: displayCurrencyData } = useDisplayCurrencyQuery();
  const displayCurrency = displayCurrencyData?.currency ?? null;

  const timezone = useUserTimezone();

  // Derive the query window. The first request has no response to read, so the
  // historyRange falls back to DEFAULT_CURRENCY_HISTORY_RANGE (§B). Once the
  // response lands `usePresetPerformance` re-derives with the currency's real
  // historyRange and resolved week-start (Design §10.4 cycle-prevention note).
  const { query: performanceQuery, currencyData } = usePresetPerformance({
    preset: config.timeframe,
    timezone,
    currency: displayCurrency,
  });

  const { data: response, isLoading, isError, error, refetch } = performanceQuery;

  const { options, handleChange } = useTimeframeSelection(config.timeframe, (next) => {
    onUpdateConfig({ timeframe: next });
  });

  // A disabled query reports `isLoading: false`, so the wait for the stored
  // zone has to be spelled out here — otherwise the widget would drop through
  // to its empty state before the first fetch.
  if (timezone === undefined || isLoading) {
    return <Skeleton className="h-[320px] w-full" />;
  }

  if (isError) {
    const message = error instanceof Error ? error.message : 'Failed to load performance chart';
    return (
      <EmptyState
        title="Couldn't load performance chart"
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

  // L3 clamp notice (plan-tiers REQ-7.3) — non-blocking; rendered on the
  // empty branch too (a fully-pre-boundary window is a deliberate empty state).
  const tierWindowNotice = response?.tierWindow ? (
    <TierWindowNotice tierWindow={response.tierWindow} surface="dashboard-widget" />
  ) : null;

  if (currencyData == null) {
    return (
      <div className="flex flex-col gap-3">
        {tierWindowNotice}
        <EmptyState title="Close a position in this currency to see your chart." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {tierWindowNotice}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <Button
            key={opt.id}
            type="button"
            size="sm"
            variant={config.timeframe === opt.id ? 'default' : 'outline'}
            className="cursor-pointer"
            onClick={() => handleChange(opt.id)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
      <PerformanceBarChart series={currencyData.series} />
    </div>
  );
}

export default PerformanceChartWidget;
