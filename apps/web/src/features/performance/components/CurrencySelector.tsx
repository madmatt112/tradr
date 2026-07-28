import { useNavigate } from '@tanstack/react-router';

import type { PerformanceCurrency, PerformanceQueryInput } from '@tradr/shared';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { derivePresetRange, type PerformancePreset } from '../utils/derivePresetRange';

export interface CurrencySelectorProps {
  /** Currently-selected currency code (from URL search params). */
  value: string;
  /** All currencies returned by the API for the current request. */
  currencies: ReadonlyArray<PerformanceCurrency>;
  /** Currently-selected preset (drives `derivePresetRange` on currency change). */
  currentPreset: PerformancePreset;
  /** Resolved IANA timezone from the latest API response. */
  resolvedTimezone: string;
  /** Resolved week-start day from the latest API response. */
  resolvedWeekStartDay: 0 | 1;
}

/**
 * A currency is "dormant" for the active timeframe when its in-timeframe
 * series is empty — i.e., switching to it without changing the timeframe
 * would yield an empty chart. We surface this via a suffix in the option
 * label so users understand the consequence of the switch.
 *
 * The per-currency `series` array tracks the active timeframe, so an empty
 * series is the precise signal. We OR with `historyRange.totalClosedPositions
 * === 0` as a secondary "never had positions" indicator — a currency with no
 * all-history positions is dormant for any sub-range too, even if the series
 * happened to be populated by other code paths.
 */
function isDormant(currency: PerformanceCurrency): boolean {
  return currency.series.length === 0 || currency.historyRange.totalClosedPositions === 0;
}

/**
 * Build the navigate() patch for a currency change. Pure; exported so tests
 * can verify the four-key atomicity (currency + granularity + start + end)
 * without rendering the component or mocking the router.
 */
export function buildCurrencyChangePatch(
  newCurrencyCode: string,
  currencies: ReadonlyArray<PerformanceCurrency>,
  currentPreset: PerformancePreset,
  resolvedTimezone: string,
  resolvedWeekStartDay: 0 | 1,
  nowInstant: Date = new Date(),
): {
  currency: string;
  granularity: PerformanceQueryInput['granularity'];
  start: string;
  end: string;
} {
  const next = currencies.find((c) => c.code === newCurrencyCode);
  // A change event that references an unknown currency would be a programming
  // error (the option list IS `currencies`), so fall back to an empty range.
  // The route-level Zod validation would still fail if start/end were invalid,
  // but `derivePresetRange` always returns a structurally-valid range.
  const range = next?.historyRange ?? {
    earliestClosedAt: null,
    mostRecentClosedAt: null,
    totalClosedPositions: 0,
  };
  const preset = derivePresetRange(
    currentPreset,
    range,
    nowInstant,
    resolvedTimezone,
    resolvedWeekStartDay,
  );
  return {
    currency: newCurrencyCode,
    granularity: preset.granularity,
    start: preset.start,
    end: preset.end,
  };
}

/**
 * CurrencySelector — dropdown when ≥2 currencies, static label when exactly 1.
 *
 * On change: builds the four-key patch (currency, granularity, start, end)
 * via `buildCurrencyChangePatch` and fires EXACTLY ONE `navigate()` call.
 * This is the atomicity contract: the URL never reflects a stale combination
 * (e.g., new currency with old start/end) per Design §Component 7.
 */
export function CurrencySelector({
  value,
  currencies,
  currentPreset,
  resolvedTimezone,
  resolvedWeekStartDay,
}: CurrencySelectorProps) {
  const navigate = useNavigate({ from: '/performance' });

  // Single-currency: render a static label, NOT a disabled select. A disabled
  // select looks like a broken dropdown; a styled span communicates "this is
  // the only option" without inviting interaction.
  if (currencies.length <= 1) {
    return (
      <span
        data-testid="currency-selector-static"
        className="inline-flex h-9 items-center rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground"
      >
        {value}
      </span>
    );
  }

  // Alphabetical sort by code (stable; the API does not pin order).
  const sorted = [...currencies].sort((a, b) => a.code.localeCompare(b.code));

  const handleChange = (newCurrencyCode: string) => {
    if (newCurrencyCode === value) return;
    const patch = buildCurrencyChangePatch(
      newCurrencyCode,
      currencies,
      currentPreset,
      resolvedTimezone,
      resolvedWeekStartDay,
    );
    // ATOMIC: one navigate() call — currency + granularity + start + end all
    // updated together. Per Design §Component 7 / Adversarial review the URL
    // must never reflect a stale combination.
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
    });
  };

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger
        data-testid="currency-selector"
        className="cursor-pointer"
        aria-label="Currency"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {sorted.map((currency) => {
          const dormant = isDormant(currency);
          return (
            <SelectItem
              key={currency.code}
              value={currency.code}
              data-testid={`currency-option-${currency.code}`}
              data-dormant={dormant ? 'true' : undefined}
              className={cn('cursor-pointer', dormant && 'text-muted-foreground italic')}
            >
              {currency.code}
              {dormant ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  (no positions in timeframe)
                </span>
              ) : null}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
