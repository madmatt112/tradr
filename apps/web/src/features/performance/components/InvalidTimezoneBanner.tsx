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
   * `true` when the request that just failed had already dropped `tz` — so it
   * was the server's OWN default that was rejected, not the user's zone.
   * Source of truth: `isTimezoneRejected(params.tz)`, the same predicate
   * `usePerformance` uses to decide whether to send `tz`, so the banner cannot
   * claim a fallback the request did not actually make.
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
 * First failure: the request carried the stored reporting timezone
 * (`useUserTimezone`, seeded into the URL by the sidebar) and the server
 * rejected it; the hook's retry already swapped in UTC, so the banner is
 * informational and dismissible. Changing the preference under Settings →
 * Profile is the fix, but it does not rewrite the `tz` already in this page's
 * URL — the copy therefore says to re-enter Performance from the sidebar,
 * which is what re-seeds the destination from the new preference. That
 * instruction stands on the URL alone: the rejection is recorded against the
 * OLD zone and cleared when the preference is written, so arriving with the
 * new zone sends it whether the navigation was a router transition or a full
 * page load.
 *
 * Second failure (same session): the retry omitted `tz` entirely, so the
 * server validated its own default of `UTC` (`PerformanceQuerySchema`) and
 * rejected THAT. The user's preference is not what failed, so profile settings
 * cannot resolve it — the copy says plainly that it is a server-side problem.
 * Non-dismissible, and deliberately offers no action.
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
          {isSecondFailure ? (
            <p>
              We retried without your reporting timezone and the server rejected UTC as well, so
              this is a problem on the server rather than something your settings can fix. Try again
              later, or contact support if it persists.
            </p>
          ) : (
            <p>
              We could not resolve your reporting timezone, so dates are shown in UTC until it is
              corrected. Change it in{' '}
              <a
                href="/settings/profile"
                data-testid="invalid-timezone-banner-settings-link"
                className="cursor-pointer underline underline-offset-4"
              >
                profile settings
              </a>
              , then reopen Performance from the sidebar to apply it.
            </p>
          )}
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
