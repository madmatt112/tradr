import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export interface ChunkLoadFallbackProps {
  onReload: () => void;
  /**
   * Widget-level layout: a single row with the line-clamped title beside the
   * Reload button and no description, so Reload stays reachable in the ~93px
   * body of the smallest dashboard widget. Announced politely (`role="status"`)
   * because a stale-tab reload can render one per widget at once.
   */
  compact?: boolean;
  className?: string;
}

/**
 * Non-dismissible fallback rendered in place of a lazy surface whose chunk
 * failed to load and could not be recovered by an automatic reload. This is the
 * REQ-3.6 tier: not dismissible, never a modal, never a second automatic
 * reload — a single Reload button that goes through `reloadAfterChunkFailure`
 * (wired by the boundary via `onReload`).
 */
export function ChunkLoadFallback({
  onReload,
  compact = false,
  className,
}: ChunkLoadFallbackProps) {
  const reloadButton = (
    <button
      type="button"
      data-testid="chunk-load-fallback-reload"
      onClick={onReload}
      className={cn(
        'shrink-0 cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      Reload
    </button>
  );

  if (compact) {
    return (
      <Alert
        data-testid="chunk-load-fallback"
        variant="destructive"
        // Polite, not assertive: on the common stale-tab path every widget
        // renders this at once, so six identical announcements should queue
        // rather than interrupt each other. Overrides the Alert's role="alert".
        role="status"
        className={cn('flex items-start justify-between gap-4', className)}
      >
        <AlertTitle>This part of Tradr couldn't load</AlertTitle>
        {reloadButton}
      </Alert>
    );
  }

  return (
    <Alert
      data-testid="chunk-load-fallback"
      variant="destructive"
      // A whole page or route that failed to appear is worth interrupting for.
      aria-live="assertive"
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <AlertTitle>This part of Tradr couldn't load</AlertTitle>
        <AlertDescription>
          The app was updated while this tab was open and the automatic reload didn't fix it. Reload
          to get the current version.
        </AlertDescription>
      </div>
      {reloadButton}
    </Alert>
  );
}
