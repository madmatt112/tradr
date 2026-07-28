import { appVersion } from '@/lib/api';

// Deploy-stamped version badge, rendered on every route from __root. Fixed
// bottom-right and informational only: pointer-events-none so it can never
// intercept a click or a test locator; low z-index so drawers/dialogs cover it.
export function VersionBadge() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed right-2 bottom-2 z-10 text-xs text-muted-foreground select-none"
    >
      {appVersion()}
    </div>
  );
}
