import type { ReactNode } from 'react';

import { EmptyState } from '@/components/EmptyState';

import { DataQualityBanner, hasAnyDataQualityIssue, type DataQuality } from './DataQualityBanner';

export interface PerformanceEmptyStateProps {
  hasAnyAccounts: boolean;
  hasAnyClosedPositions: boolean;
  hasAnyClosedPositionsInSupportedCurrency: boolean;
  /**
   * `true` when the API returned the populated-history flags but the
   * filtered-to-the-current-timeframe series is empty. Co-displays with the
   * DataQualityBanner above the empty-state when both apply.
   */
  isInTimeframeEmpty?: boolean;
  /** Surfaces the DataQualityBanner above the empty-state when issues exist. */
  dataQuality?: DataQuality;
  /** Optional CTA — caller decides whether to include a "Create account" link, etc. */
  action?: ReactNode;
  className?: string;
}

/**
 * Feature-level empty state for the Performance page. Composes the shared
 * `EmptyState` (Task 4) with three branches based on the API flags:
 *
 *  1. `!hasAnyAccounts` → "Create an account to get started."
 *  2. `hasAnyAccounts && !hasAnyClosedPositions` → "Close a position…"
 *  3. `hasAnyClosedPositions && !hasAnyClosedPositionsInSupportedCurrency` →
 *     "Your closed positions are in currencies not yet supported."
 *
 * Plus the in-timeframe-empty co-display:
 *
 *  4. `hasAnyClosedPositionsInSupportedCurrency && isInTimeframeEmpty` →
 *     "No closed positions in this timeframe." DataQualityBanner stacks
 *     ABOVE the empty-state when `dataQuality` has any non-zero counts
 *     (Design §Component 7 "in-timeframe-empty + DataQualityBanner co-display").
 *
 * Returns `null` when none of the branches apply (the caller renders the
 * populated view instead).
 */
export function PerformanceEmptyState({
  hasAnyAccounts,
  hasAnyClosedPositions,
  hasAnyClosedPositionsInSupportedCurrency,
  isInTimeframeEmpty = false,
  dataQuality,
  action,
  className,
}: PerformanceEmptyStateProps) {
  let title: string | null = null;
  let description: string | undefined;
  let testId: string | null = null;

  if (!hasAnyAccounts) {
    title = 'No accounts yet';
    description = 'Create an account to get started.';
    testId = 'performance-empty-state-no-accounts';
  } else if (!hasAnyClosedPositions) {
    title = 'No closed positions yet';
    description = 'Close a position to start tracking performance.';
    testId = 'performance-empty-state-no-closed-positions';
  } else if (!hasAnyClosedPositionsInSupportedCurrency) {
    title = 'Currency not supported';
    description = 'Your closed positions are in currencies not yet supported.';
    testId = 'performance-empty-state-unsupported-currency';
  } else if (isInTimeframeEmpty) {
    title = 'No closed positions in this timeframe';
    description = 'Try a wider timeframe or a different preset.';
    testId = 'performance-empty-state-in-timeframe-empty';
  }

  if (title === null || testId === null) return null;

  // DataQualityBanner stacks ABOVE the empty-state when co-displaying. Per
  // Design §Component 7: this only applies in the in-timeframe-empty branch
  // (the upstream branches mean there's no data to QA). We still gate on
  // `hasAnyDataQualityIssue` so empty-state only renders the banner when
  // there's something to say.
  const showBannerAbove =
    isInTimeframeEmpty && dataQuality !== undefined && hasAnyDataQualityIssue(dataQuality);

  return (
    <div data-testid={testId} className={className}>
      {showBannerAbove ? (
        <div className="mb-4">
          <DataQualityBanner dataQuality={dataQuality} />
        </div>
      ) : null}
      <EmptyState title={title} description={description} action={action} />
    </div>
  );
}
