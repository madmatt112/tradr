import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

// ---- sessionStorage with try/catch + module-local fallback (Safari private mode) ----
const FIRST_DISMISS_KEY = 'perf.invalid_tz_first_dismissed';
let firstDismissedFallback = false;
let storageWarned = false;

function warnStorageOnce(err: unknown): void {
  if (storageWarned) return;
  storageWarned = true;
  console.warn('[InvalidTimezoneBanner] sessionStorage unavailable; using in-memory fallback', err);
}

function readFirstDismissed(): boolean {
  try {
    if (sessionStorage.getItem(FIRST_DISMISS_KEY) === 'true') return true;
  } catch (err) {
    warnStorageOnce(err);
  }
  return firstDismissedFallback;
}

function writeFirstDismissed(): void {
  try {
    sessionStorage.setItem(FIRST_DISMISS_KEY, 'true');
  } catch (err) {
    warnStorageOnce(err);
  }
  firstDismissedFallback = true;
}

/** Test seam — clears module-local fallback so test runs are isolated. */
export function __resetInvalidTimezoneBannerState(): void {
  firstDismissedFallback = false;
  storageWarned = false;
}

export interface InvalidTimezoneBannerProps {
  /**
   * `true` when the request that just failed is the SECOND INVALID_TIMEZONE
   * encounter in this browser session (the retry-storm path was already
   * consumed by `usePerformance`). Source of truth: the same session flag
   * that `usePerformance.performanceRetry` writes — read it via
   * `readInvalidTzSeen()` exposure or, more simply, pass `seenBefore` from
   * the composition site which already knows.
   *
   * On first failure: dismissible, with "dates shown in UTC" copy.
   * On second failure: NOT dismissible (per Design §Component 7).
   */
  isSecondFailure: boolean;
  className?: string;
}

/**
 * Banner shown when the server rejects the requested IANA timezone.
 *
 * First failure: the hook's retry already swapped in UTC; the banner is
 * informational and dismissible. Second failure (same session): user's
 * environment is repeatedly producing an unparseable TZ → non-dismissible
 * because no user action will resolve the underlying issue without changing
 * something outside the page.
 */
export function InvalidTimezoneBanner({ isSecondFailure, className }: InvalidTimezoneBannerProps) {
  const [dismissed, setDismissed] = useState<boolean>(() =>
    isSecondFailure ? false : readFirstDismissed(),
  );

  if (dismissed) return null;

  const handleDismiss = () => {
    writeFirstDismissed();
    setDismissed(true);
  };

  // assertive only on the non-dismissible second-failure error state
  // (matches ChartChunkStaleBanner — assertive for terminal/blocking states).
  const ariaLive = isSecondFailure ? 'assertive' : 'polite';

  return (
    <Alert
      data-testid="invalid-timezone-banner"
      data-second-failure={isSecondFailure ? 'true' : undefined}
      variant={isSecondFailure ? 'destructive' : 'default'}
      aria-live={ariaLive}
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>
          {isSecondFailure ? 'Timezone could not be resolved' : 'Dates shown in UTC'}
        </AlertTitle>
        <AlertDescription>
          {isSecondFailure
            ? 'Your browser timezone is not recognized by the server. Try a different timezone or contact support.'
            : 'We could not resolve your local timezone, so dates are shown in UTC for this session.'}
        </AlertDescription>
      </div>
      {!isSecondFailure ? (
        <button
          type="button"
          data-testid="invalid-timezone-banner-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss timezone notice"
          className={cn(
            'shrink-0 cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium',
            'hover:bg-accent hover:text-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          Dismiss
        </button>
      ) : null}
    </Alert>
  );
}
