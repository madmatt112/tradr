import { useNavigate } from '@tanstack/react-router';

import type { PerformanceQueryInput } from '@tradr/shared';

import { cn } from '@/lib/utils';

import { TIMEFRAME_PRESET_OPTIONS, useTimeframeSelection } from '../hooks/useTimeframeSelection';
import {
  type CurrencyHistoryRange,
  derivePresetRange,
  type PerformancePreset,
} from '../utils/derivePresetRange';

/**
 * Re-export of the canonical six-preset array. Kept under its historical name
 * (`TIMEFRAME_PRESETS`) so existing imports — notably the component's tests —
 * continue to resolve. New code should prefer `TIMEFRAME_PRESET_OPTIONS` from
 * `../hooks/useTimeframeSelection`.
 */
export const TIMEFRAME_PRESETS = TIMEFRAME_PRESET_OPTIONS;

export interface TimeframeSelectorProps {
  /**
   * Currently-selected preset. The component is stateless — the parent owns
   * the canonical preset (typically derived from the URL search params).
   */
  value: PerformancePreset;
  /**
   * History range of the currently-selected currency. Used by `derivePresetRange`
   * for the `yearly` and `all-time` anchors.
   */
  currencyHistoryRange: CurrencyHistoryRange;
  /** Resolved IANA timezone from the latest API response. */
  resolvedTimezone: string;
  /** Resolved week-start day from the latest API response. */
  resolvedWeekStartDay: 0 | 1;
}

/**
 * Build the patch that the timeframe-selector navigate() call applies. Pure;
 * exported so tests can verify the wiring without rendering the component.
 */
export function buildTimeframePatch(
  preset: PerformancePreset,
  currencyHistoryRange: CurrencyHistoryRange,
  resolvedTimezone: string,
  resolvedWeekStartDay: 0 | 1,
  nowInstant: Date = new Date(),
): { granularity: PerformanceQueryInput['granularity']; start: string; end: string } {
  return derivePresetRange(
    preset,
    currencyHistoryRange,
    nowInstant,
    resolvedTimezone,
    resolvedWeekStartDay,
  );
}

/**
 * TimeframeSelector — six preset buttons. On click, fires a single
 * `navigate({ search: (prev) => ({ ...prev, ...derivePresetRange(...) }) })`.
 *
 * Implemented as a `<div role="tablist">` of `<button role="tab">` rather
 * than the shadcn `Tabs` primitive: shadcn/Radix Tabs renders an associated
 * `TabsContent` panel and animates state via portals, neither of which we
 * need here. A flat tablist is keyboard-accessible (arrow keys are wired
 * by the browser when each tab carries `role="tab"` and proper `aria-*`),
 * smaller in bundle, and easier to test.
 *
 * State logic lives in `useTimeframeSelection` so the dashboard's
 * `PerformanceChartWidget` can share the picker without forking the UI.
 */
export function TimeframeSelector({
  value,
  currencyHistoryRange,
  resolvedTimezone,
  resolvedWeekStartDay,
}: TimeframeSelectorProps) {
  const navigate = useNavigate({ from: '/performance' });

  const {
    value: selected,
    options,
    handleChange,
  } = useTimeframeSelection(value, (preset) => {
    const patch = buildTimeframePatch(
      preset,
      currencyHistoryRange,
      resolvedTimezone,
      resolvedWeekStartDay,
    );
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
    });
  });

  return (
    <div
      role="tablist"
      aria-label="Timeframe"
      data-testid="timeframe-selector"
      className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
    >
      {options.map((preset) => {
        const isActive = preset.id === selected;
        return (
          <button
            key={preset.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-state={isActive ? 'active' : 'inactive'}
            data-testid={`timeframe-preset-${preset.id}`}
            onClick={() => handleChange(preset.id)}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
