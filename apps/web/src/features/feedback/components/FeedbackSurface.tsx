import { useCallback, useEffect, useRef, useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  getFeedbackSurveyIds,
  isFeedbackSurveyConfigured,
  type FeedbackSurveyIds,
} from '@/lib/telemetry/config';
import {
  captureFeedbackDismissed,
  captureFeedbackSent,
  captureFeedbackShown,
} from '@/lib/telemetry/posthog';
import { cn } from '@/lib/utils';
import { useDrawerStore } from '@/stores/drawer.store';

import {
  FEEDBACK_MAIN_GUTTER,
  FEEDBACK_MAIN_GUTTER_DRAWER_OPEN,
  FEEDBACK_TAB_WIDTH_CLASSES,
} from '../geometry';

import { FeedbackForm } from './FeedbackForm';

// How long the "Sent. Thank you." state dwells before the popover auto-closes
// through the close funnel (design register item 8).
export const SENT_STATE_DWELL_MS = 3000;

/**
 * FeedbackSurface — the gate, the right-edge tab, the popover shell, the
 * drawer-follow, and the capture lifecycle (design Component 3). The only
 * component that talks to telemetry.
 *
 * Gate: renders null (no DOM node, no listener, no capture) when the surface is
 * not configured, resolving the survey ids once when it is. The hook-bearing
 * body lives in an inner component so an unconfigured deploy subscribes to no
 * store and registers no effect (REQ-1.4, 8.6).
 */
export function FeedbackSurface() {
  const ids = getFeedbackSurveyIds();
  if (!ids) return null;
  return <FeedbackSurfaceInner ids={ids} />;
}

function FeedbackSurfaceInner({ ids }: { ids: FeedbackSurveyIds }) {
  const drawerOpen = useDrawerStore((s) => s.isOpen);
  const isMobile = useMediaQuery('(max-width: 767px)');

  // Controlled popover open state, plus a per-open record: a submission id minted
  // per open and a sent flag. The form is remounted per open (key={submissionId})
  // so its own state and double-activation guard reset for free (REQ-4.8).
  const [open, setOpen] = useState(false);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Config is immutable at runtime; hold the mount ids so the close funnel and
  // the capture handlers stay stable across the parent's drawer-driven renders.
  const idsRef = useRef(ids);
  // Once-per-open close guard. Starts "closed" so a funnel call before the first
  // open (or a second call within one open) no-ops; reset to false on open, back
  // to true inside the funnel — so "dismissed" can never double-fire.
  const closedRef = useRef(true);
  const sentRef = useRef(false);
  const submissionIdRef = useRef<string | null>(null);
  const dwellTimerRef = useRef<number | null>(null);

  // The single close path. EVERY close routes through it — Radix's
  // onOpenChange(false), the sent-state timer, and the drawer-change effect. It
  // fires captureFeedbackDismissed iff the popover was open and nothing was sent
  // (REQ-4.7, 5.4, 7.1).
  const closePopover = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (!sentRef.current && submissionIdRef.current !== null) {
      captureFeedbackDismissed(idsRef.current, submissionIdRef.current);
    }
    setOpen(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        const id = crypto.randomUUID();
        submissionIdRef.current = id;
        sentRef.current = false;
        closedRef.current = false;
        setSubmissionId(id);
        setSent(false);
        setOpen(true);
        captureFeedbackShown(idsRef.current);
      } else {
        closePopover();
      }
    },
    [closePopover],
  );

  const handleSend = useCallback(
    (rating: number, text: string) => {
      const id = submissionIdRef.current;
      if (id === null) return;
      captureFeedbackSent(idsRef.current, id, rating, text);
      sentRef.current = true;
      setSent(true);
      dwellTimerRef.current = window.setTimeout(() => {
        dwellTimerRef.current = null;
        closePopover();
      }, SENT_STATE_DWELL_MS);
    },
    [closePopover],
  );

  // Drawer-change effect: previous-value refs over drawerOpen and isMobile. Runs
  // silently on mount (records only), then closes the popover on ANY drawerOpen
  // flip while open, and when (isMobile && drawerOpen) becomes true — a resize
  // crossing below md with the drawer open. The funnel guard is the second wall
  // that keeps a persisted-open-drawer mount silent (design deviation 3).
  const prevDrawerOpenRef = useRef(drawerOpen);
  const prevIsMobileRef = useRef(isMobile);
  useEffect(() => {
    const prevDrawerOpen = prevDrawerOpenRef.current;
    const prevIsMobile = prevIsMobileRef.current;
    prevDrawerOpenRef.current = drawerOpen;
    prevIsMobileRef.current = isMobile;

    const drawerFlipped = drawerOpen !== prevDrawerOpen;
    const becameMobileWithDrawerOpen = isMobile && drawerOpen && !(prevIsMobile && prevDrawerOpen);

    if (drawerFlipped || becameMobileWithDrawerOpen) {
      closePopover();
    }
  }, [drawerOpen, isMobile, closePopover]);

  // Clear a pending dwell timer on unmount. The logout unmount's own dismissal
  // is deliberately not captured (accepted loss, Component 3).
  useEffect(() => {
    return () => {
      if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current);
    };
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="feedback-tab"
          aria-label="Send feedback"
          aria-expanded={open}
          className={cn(
            'fixed top-1/2 right-0 z-40 -translate-y-1/2',
            'flex items-center justify-center rounded-l-md border bg-background py-3',
            'text-muted-foreground transition-transform duration-200 ease-out',
            'cursor-pointer outline-none hover:text-foreground motion-reduce:duration-0',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            FEEDBACK_TAB_WIDTH_CLASSES,
            drawerOpen && 'max-md:hidden md:-translate-x-[360px]',
          )}
        >
          <span className="font-mono text-xs [writing-mode:vertical-rl]">feedback</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="feedback-popover"
        side="left"
        align="center"
        sideOffset={8}
        className="w-80"
      >
        <FeedbackForm key={submissionId} sent={sent} onSend={handleSend} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The configured-only <main> gutter classes for the coarse-pointer tab
 * (Component 5). Returns undefined when the surface is absent, so <main>'s
 * classes are byte-identical to today by construction (REQ-8.1, 8.6).
 */
export function feedbackMainGutterClasses(drawerOpen: boolean): string | undefined {
  if (!isFeedbackSurveyConfigured()) return undefined;
  return cn(FEEDBACK_MAIN_GUTTER, drawerOpen && FEEDBACK_MAIN_GUTTER_DRAWER_OPEN);
}
