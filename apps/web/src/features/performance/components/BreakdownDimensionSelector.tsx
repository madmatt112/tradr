import { useNavigate } from '@tanstack/react-router';

import { BREAKDOWN_DIMENSIONS, type BreakdownDimension } from '@tradr/shared';

import { cn } from '@/lib/utils';

/** The user-facing label for each dimension, keyed off the shared const array. */
const DIMENSION_LABELS: Record<BreakdownDimension, string> = {
  symbol: 'Symbol',
  weekday: 'Weekday',
  hour: 'Hour',
  tag: 'Tag',
};

export interface BreakdownDimensionSelectorProps {
  /** The currently-selected dimension. The parent owns it (URL `by=`, R6.1). */
  value: BreakdownDimension;
}

/**
 * BreakdownDimensionSelector — four tabs (Symbol, Weekday, Hour, Tag) that set
 * the performance route's `by=` search param (R6.1, R6.7). Same flat-tablist
 * shape as `TimeframeSelector` (`TimeframeSelector.tsx:97-128`): a
 * `<div role="tablist">` of `<button role="tab">`, keyboard-operable natively,
 * each carrying `cursor-pointer` and the focus ring.
 *
 * On click it fires a single `navigate({ search: (prev) => ({ ...prev, by }) })`,
 * merging the new dimension into the existing search rather than replacing it.
 */
export function BreakdownDimensionSelector({ value }: BreakdownDimensionSelectorProps) {
  const navigate = useNavigate({ from: '/performance' });

  return (
    <div
      role="tablist"
      aria-label="Breakdown by"
      data-testid="breakdown-dimension-selector"
      className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
    >
      {BREAKDOWN_DIMENSIONS.map((by) => {
        const isActive = by === value;
        return (
          <button
            key={by}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-state={isActive ? 'active' : 'inactive'}
            data-testid={`breakdown-dimension-${by}`}
            onClick={() => {
              if (by === value) return;
              void navigate({ search: (prev) => ({ ...prev, by }) });
            }}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {DIMENSION_LABELS[by]}
          </button>
        );
      })}
    </div>
  );
}

export default BreakdownDimensionSelector;
