import { useState } from 'react';

import type { PerformanceResponse } from '@tradr/shared';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export type DataQuality = PerformanceResponse['dataQuality'];

// ---- sessionStorage with try/catch + module-local fallback (Safari private mode) ----
const STORAGE_PREFIX = 'perf.dq_dismissed.';
const dismissedFallback = new Set<string>();
let storageWarned = false;

function warnStorageOnce(err: unknown): void {
  if (storageWarned) return;
  storageWarned = true;
  console.warn('[DataQualityBanner] sessionStorage unavailable; using in-memory fallback', err);
}

function readDismissed(key: string): boolean {
  try {
    if (sessionStorage.getItem(STORAGE_PREFIX + key) === 'true') return true;
  } catch (err) {
    warnStorageOnce(err);
  }
  return dismissedFallback.has(key);
}

function writeDismissed(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, 'true');
  } catch (err) {
    warnStorageOnce(err);
  }
  dismissedFallback.add(key);
}

/** Test seam — clears module-local fallback state so test runs are isolated. */
export function __resetDataQualityBannerState(): void {
  dismissedFallback.clear();
  storageWarned = false;
}

// ---- Storage-key derivation ----
//
// The session-dismissal flag is keyed on the SHAPE of the data-quality issues
// (which scopes have which non-zero reasons), not on absolute counts. Counts
// fluctuate across timeframe changes; users would re-see the banner after every
// scrub if we keyed on counts. The "reason set" form ("tf:unsupported,mismatch|h:closed_at_null")
// stays stable while the user explores adjacent timeframes.
function deriveStorageKey(dq: DataQuality): string {
  const tfReasons: string[] = [];
  if (dq.timeframeExcluded.unsupported > 0) tfReasons.push('unsupported');
  if (dq.timeframeExcluded.mismatch > 0) tfReasons.push('mismatch');
  const histReasons: string[] = [];
  if (dq.historyExcluded.closed_at_null > 0) histReasons.push('closed_at_null');
  return `tf:${tfReasons.join(',')}|h:${histReasons.join(',')}`;
}

/**
 * Whether the overlap disclaimer "(some may have multiple issues)" applies
 * within a scope. Per Design §Component 7: ONLY when ≥ 2 per-reason counts
 * are non-zero in that scope can a single row contribute to multiple reasons.
 */
export function shouldShowTimeframeOverlap(dq: DataQuality): boolean {
  let nonZero = 0;
  if (dq.timeframeExcluded.unsupported > 0) nonZero += 1;
  if (dq.timeframeExcluded.mismatch > 0) nonZero += 1;
  return nonZero >= 2;
}

export function shouldShowHistoryOverlap(dq: DataQuality): boolean {
  // Only one history-scope reason is currently exposed (`closed_at_null`); a
  // future reason would make this disclaimer meaningful. Keep the helper so the
  // composition site doesn't need to know which scope has > 1 reasons.
  let nonZero = 0;
  if (dq.historyExcluded.closed_at_null > 0) nonZero += 1;
  return nonZero >= 2;
}

export function hasAnyDataQualityIssue(dq: DataQuality): boolean {
  return dq.timeframeExcluded.total > 0 || dq.historyExcluded.total > 0;
}

export interface DataQualityBannerProps {
  dataQuality: DataQuality;
  className?: string;
}

/**
 * Session-dismissible banner summarizing positions excluded from the
 * performance computation. Two scopes:
 *  - **Timeframe-scoped**: excluded within the selected window (unsupported
 *    currency, user_id mismatch).
 *  - **History-scoped**: excluded across all-history (missing `closed_at`).
 *
 * The "(some may have multiple issues)" overlap disclaimer renders only when
 * a scope has ≥ 2 non-zero per-reason counts (a single row can satisfy
 * multiple reasons; counts may overlap; `total` is DISTINCT — see Design
 * §Component 3.1).
 */
export function DataQualityBanner({ dataQuality, className }: DataQualityBannerProps) {
  const storageKey = deriveStorageKey(dataQuality);
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(storageKey));

  if (dismissed) return null;
  if (!hasAnyDataQualityIssue(dataQuality)) return null;

  const handleDismiss = () => {
    writeDismissed(storageKey);
    setDismissed(true);
  };

  const tf = dataQuality.timeframeExcluded;
  const hist = dataQuality.historyExcluded;
  const tfOverlap = shouldShowTimeframeOverlap(dataQuality);
  const histOverlap = shouldShowHistoryOverlap(dataQuality);

  return (
    <Alert
      data-testid="data-quality-banner"
      // polite — informational; doesn't interrupt the user.
      aria-live="polite"
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>Some positions were excluded</AlertTitle>
        <AlertDescription>
          {tf.total > 0 ? (
            <p data-testid="data-quality-banner-timeframe">
              <strong>In the selected timeframe:</strong> {tf.total}{' '}
              {tf.total === 1 ? 'position' : 'positions'} excluded
              {tfOverlap ? ' (some may have multiple issues)' : ''}.
              {tf.unsupported > 0 ? ` Up to ${tf.unsupported} for unsupported currency;` : ''}
              {tf.mismatch > 0 ? ` Up to ${tf.mismatch} for user-id mismatch;` : ''}
            </p>
          ) : null}
          {hist.total > 0 ? (
            <p data-testid="data-quality-banner-history">
              <strong>Across all history:</strong> {hist.total}{' '}
              {hist.total === 1 ? 'position' : 'positions'}
              {histOverlap ? ' (some may have multiple issues)' : ''}
              {hist.closed_at_null > 0 ? ' with a missing close timestamp.' : '.'}
            </p>
          ) : null}
        </AlertDescription>
      </div>
      <button
        type="button"
        data-testid="data-quality-banner-dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss data quality notice"
        className={cn(
          'shrink-0 cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        Dismiss
      </button>
    </Alert>
  );
}
