import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { useUpdateMonitor } from '@/hooks/useUpdateMonitor';
import { captureClientEvent } from '@/lib/telemetry/posthog';
import { getUpdateMonitor } from '@/lib/updateMonitor';

export const UPDATE_TOAST_ID = 'app-update';

/**
 * The dumb update prompt: it maps the monitor's state to one sonner toast (id
 * `app-update`) and forwards three intents — shown, accepted, dismissed. It
 * renders nothing itself and is mounted from __root.tsx beside Toaster and
 * VersionBadge, so it exists on every route. All detection, scheduling and
 * cross-tab knowledge live in the monitor; this component knows only the copy,
 * the toast id and the event names.
 */
export function UpdatePrompt(): null {
  const router = useRouter();
  const monitor = getUpdateMonitor();
  const { promptVisible, servedVersion, bootVersion, learnedVia } = useUpdateMonitor();

  // The served version a `shown` event was already captured for — a StrictMode
  // and once-per-served-version guard.
  const shownForRef = useRef<string | null>(null);
  // The served version a toast is currently issued for, or null when none is
  // live. Guards the programmatic dismiss so a mount-time no-op can never fire a
  // stray toast.dismiss or strand programmaticDismissRef.
  const issuedForRef = useRef<string | null>(null);
  // Set immediately before our own toast.dismiss so onDismiss can tell a
  // programmatic close from a genuine user close (read-and-clear).
  const programmaticDismissRef = useRef(false);

  // Drive the singleton: start on mount (which hands the router to the monitor),
  // stop on unmount. start/stop are idempotent, so this is StrictMode-safe.
  useEffect(() => {
    monitor.start({ router });
    return () => monitor.stop();
  }, []);

  useEffect(() => {
    if (promptVisible && servedVersion !== undefined) {
      toast('Tradr has been updated', {
        id: UPDATE_TOAST_ID,
        description: (
          <>
            Reload to switch to the version being served. Anything unsaved on this page will be
            lost.
            <span className="mt-1 block font-mono text-xs">
              {bootVersion} → {servedVersion}
            </span>
          </>
        ),
        duration: Infinity,
        dismissible: true,
        action: {
          label: 'Reload',
          onClick: () => {
            captureClientEvent('app_update_prompt_accepted', { bootVersion, servedVersion });
            monitor.accept();
          },
        },
        cancel: {
          label: 'Not now',
          onClick: () => {
            captureClientEvent('app_update_prompt_dismissed', { bootVersion, servedVersion });
            monitor.dismiss();
            issuedForRef.current = null;
          },
        },
        onDismiss: () => {
          // Our own programmatic dismiss reaches onDismiss asynchronously; read
          // and clear the flag and capture nothing.
          if (programmaticDismissRef.current) {
            programmaticDismissRef.current = false;
            return;
          }
          // A genuine user close (swipe / close button) — capture it.
          captureClientEvent('app_update_prompt_dismissed', { bootVersion, servedVersion });
          monitor.dismiss();
          issuedForRef.current = null;
        },
        classNames: { actionButton: 'cursor-pointer', cancelButton: 'cursor-pointer' },
      });
      issuedForRef.current = servedVersion;
      // A freshly-issued toast never inherits a stale programmatic-dismiss flag.
      programmaticDismissRef.current = false;
      if (shownForRef.current !== servedVersion) {
        shownForRef.current = servedVersion;
        const props: Record<string, string> = { bootVersion, servedVersion };
        if (learnedVia !== undefined) props.learnedVia = learnedVia;
        captureClientEvent('app_update_prompt_shown', props);
      }
    } else if (issuedForRef.current !== null) {
      // The prompt is no longer visible and a toast is actually live: dismiss it
      // programmatically. On mount (phase polling, no toast) issuedForRef is
      // still null, so this branch does nothing and strands no flag.
      programmaticDismissRef.current = true;
      toast.dismiss(UPDATE_TOAST_ID);
      issuedForRef.current = null;
    }
    // Only the two snapshot fields the design pins drive re-issue; bootVersion is
    // constant and learnedVia moves only with servedVersion.
  }, [promptVisible, servedVersion]);

  return null;
}
