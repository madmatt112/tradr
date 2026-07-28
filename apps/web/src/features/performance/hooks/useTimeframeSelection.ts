import type { PerformancePreset } from '../utils/derivePresetRange';

export interface TimeframePresetOption {
  id: PerformancePreset;
  label: string;
}

/**
 * Canonical six-preset array. Order is the order shown in the UI.
 *
 * Exported (rather than re-derived per-call) so consumers can render the
 * option list without invoking the hook (e.g. tests, storybook).
 */
export const TIMEFRAME_PRESET_OPTIONS: ReadonlyArray<TimeframePresetOption> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly', label: 'Yearly' },
  { id: 'ytd', label: 'YTD' },
  { id: 'all-time', label: 'All-Time' },
];

export interface UseTimeframeSelectionResult {
  value: PerformancePreset;
  options: ReadonlyArray<TimeframePresetOption>;
  handleChange: (next: PerformancePreset) => void;
}

/**
 * Headless state-management surface for the timeframe picker.
 *
 * Used by:
 * - `TimeframeSelector` (URL-navigation onChange — pushes to TanStack Router).
 * - `PerformanceChartWidget` (dashboard widget — persists to layout config
 *   via `scheduleLayoutWrite`).
 *
 * The hook is intentionally minimal: it does not own state, it just guards
 * against no-op changes (selecting the already-active preset) so consumers
 * don't double-fire their `onChange` side-effect.
 */
export function useTimeframeSelection(
  value: PerformancePreset,
  onChange: (next: PerformancePreset) => void,
): UseTimeframeSelectionResult {
  const handleChange = (next: PerformancePreset) => {
    if (next === value) return;
    onChange(next);
  };

  return {
    value,
    options: TIMEFRAME_PRESET_OPTIONS,
    handleChange,
  };
}
