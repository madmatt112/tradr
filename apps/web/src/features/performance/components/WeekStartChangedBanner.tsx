import { useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

import { onWeekStartFlip } from '../hooks/usePerformance';

// ---- sessionStorage with try/catch + module-local fallback (Safari private mode) ----
const STORAGE_KEY = 'perf.week_start_flip_dismissed';
let dismissedFallback = false;
let storageWarned = false;

function warnStorageOnce(err: unknown): void {
  if (storageWarned) return;
  storageWarned = true;
  console.warn(
    '[WeekStartChangedBanner] sessionStorage unavailable; using in-memory fallback',
    err,
  );
}

function readDismissed(): boolean {
  try {
    if (sessionStorage.getItem(STORAGE_KEY) === 'true') return true;
  } catch (err) {
    warnStorageOnce(err);
  }
  return dismissedFallback;
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, 'true');
  } catch (err) {
    warnStorageOnce(err);
  }
  dismissedFallback = true;
}

/** Test seam — clears module-local fallback so test runs are isolated. */
export function __resetWeekStartChangedBannerState(): void {
  dismissedFallback = false;
  storageWarned = false;
}

export interface WeekStartChangedBannerProps {
  className?: string;
}

/**
 * Session-dismissible banner shown when the server's `resolvedWeekStartDay`
 * changes between requests. The hook (`usePerformance`) detects the flip and
 * emits a signal via `onWeekStartFlip`; this component subscribes to that
 * signal and surfaces the banner until the user dismisses it.
 *
 * Why this banner exists: a week-start flip silently changes how `week`-grain
 * buckets are partitioned, which affects every aggregated row. Operators need
 * to know that their cached weekly view is now showing differently-bucketed
 * data — without this signal, drift could be mistaken for a calculation bug.
 */
export function WeekStartChangedBanner({ className }: WeekStartChangedBannerProps) {
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    return onWeekStartFlip(() => {
      // Respect the session-level dismissal: a user who dismissed this banner
      // earlier in the session should not see it pop again on a subsequent
      // flip in the same session.
      if (readDismissed()) return;
      setVisible(true);
    });
  }, []);

  if (!visible) return null;

  const handleDismiss = () => {
    writeDismissed();
    setVisible(false);
  };

  return (
    <Alert
      data-testid="week-start-changed-banner"
      // polite — informational; the data is still consistent, just bucketed differently.
      aria-live="polite"
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>Week-start changed</AlertTitle>
        <AlertDescription>
          The server's week-start day changed. Weekly buckets are now grouped differently — your
          previous view is no longer comparable bucket-for-bucket.
        </AlertDescription>
      </div>
      <button
        type="button"
        data-testid="week-start-changed-banner-dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss week-start changed notice"
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
