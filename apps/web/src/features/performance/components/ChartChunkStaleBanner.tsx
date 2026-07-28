import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export interface ChartChunkStaleBannerProps {
  /**
   * Override the reload action — primarily for tests, which substitute a spy
   * to assert the click handler fires without actually reloading the test
   * environment. Production callers should rely on the default behaviour
   * (`window.location.reload()`).
   */
  onReload?: () => void;
  className?: string;
}

/**
 * Non-dismissible banner shown when the chart's lazy chunk fails to load —
 * typically after a deploy invalidates the file the SPA is trying to fetch
 * (HTTP 404 on a hashed JS chunk).
 *
 * Per Design §Component 7 ChartChunkStaleBanner and the "rejected
 * alternatives" subsection of the design doc, recovery is one-tier: a single
 * "Refresh" button that triggers a full page reload. There is intentionally
 * NO automatic retry, NO dismiss button, and NO inline retry — a stale chunk
 * means the user's HTML is referencing files that no longer exist on the
 * server, and only a fresh document load fetches the new manifest.
 *
 * Detection of the failure mode (matching the Vite-specific error messages
 * `/Failed to fetch dynamically imported module|Importing a module script
 * failed/i`) lives in the chart's parent error boundary (Task 32). This file
 * is intentionally agnostic about how it gets rendered.
 */
export function ChartChunkStaleBanner({ onReload, className }: ChartChunkStaleBannerProps) {
  const handleReload = () => {
    if (onReload) {
      onReload();
      return;
    }
    window.location.reload();
  };

  return (
    <Alert
      data-testid="chart-chunk-stale-banner"
      variant="destructive"
      // assertive — this represents an unrecoverable state until the user
      // acts, matching the "non-dismissible error banner" guideline.
      aria-live="assertive"
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>Chart unavailable</AlertTitle>
        <AlertDescription>
          The app updated while you were viewing this page. Refresh to load the latest version.
        </AlertDescription>
      </div>
      <button
        type="button"
        data-testid="chart-chunk-stale-banner-refresh"
        onClick={handleReload}
        className={cn(
          'shrink-0 cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        Refresh
      </button>
    </Alert>
  );
}
