// CoachMark — the one-shot contextual prompts (R7).
//
// These are NOT checklist items and must never become them. The checklist (R4)
// is the four things a user has to do before the product does anything for
// them, and it is DERIVED from their real data. A coach mark is the opposite:
// a feature that is worth knowing about but that nobody has to use, introduced
// where it lives rather than in a tour up front. Nothing in this file feeds
// `deriveChecklist` or the onboarding status — the only state it touches is the
// `coachMarksSeen` set, which is a UI preference and nothing else.
//
// IT READS THE CHEAP PREFERENCE QUERY, NEVER `useOnboarding()`. The composed
// hook additionally pulls the whole unfiltered positions list down to count it,
// which is a real cost on the position detail, import and options surfaces —
// none of which has any use for a checklist. `useOnboardingQuery` is the same
// `['users','me','onboarding']` cache entry the dashboard already holds, so on
// three of the four surfaces this is one small request and on the fourth it is
// none.
//
// DISMISSAL IS ONE IDEMPOTENT APPEND (R7.2). `PATCH /users/me/onboarding` with
// the SINGULAR `coachMarkSeen` merges the key into the stored set server-side,
// in SQL, so marking the same surface twice is a no-op and two tabs cannot lose
// each other's writes. There is deliberately no client-side membership check
// before the write and no client-side set to keep in step — the server owns the
// set, and a second copy of it here could only ever disagree.
//
// EVERY CLOSE IS A DISMISSAL. "Got it", Escape and a click anywhere else on the
// page all mean the same thing: the user is done with it. Re-opening it on the
// next visit because they clicked past it rather than pressing the button would
// make a one-shot prompt into a recurring one, which is the behaviour R7.1's
// "one-shot" exists to rule out.
//
// R7.3 — IT MUST NOT BLOCK THE SURFACE IT DESCRIBES, and that takes two
// deliberate choices on top of the primitive:
//
//   `modal={false}` — the Radix default, stated explicitly because the
//   requirement rests on it. A modal popover renders an overlay, sets
//   `disableOutsidePointerEvents`, and traps focus; every one of those is a
//   prompt that blocks the thing it is pointing at.
//
//   `onOpenAutoFocus` PREVENTED — this is the one that is easy to miss. Radix's
//   FocusScope moves focus into the content on mount whether or not it is
//   trapping, and a non-modal popover is no exception. Since this mark opens by
//   itself, on arrival, rather than off a click, that would pull the caret out
//   of whatever the user was typing into. Preventing it leaves focus exactly
//   where it was; nothing here is ever trapped, and Tab walks straight past the
//   mark into the page.
//
// R7.6 — SUPPRESSED WHILE A WALKTHROUGH RUNS, and suppressed properly. The
// signal is read from the walkthrough's module-scoped store SYNCHRONOUSLY
// during render, so a mark on a surface the tour navigates to never mounts at
// all. Rendering and then hiding in an effect would still cost a frame, and
// that frame is a popover painted over the driver.js highlight the tour is
// pointing at.
//
// R7.5 — GATING IS THE CALLER'S ANSWER, because the caller is where the real
// predicate lives. `available` is checked BEFORE anything renders. A mark
// advertising a feature this deployment has switched off is worse than no mark,
// so an unknown answer counts as unavailable: the import surface passes the
// tier state's own remaining-imports figure and passes `false` until it lands.

import { Lightbulb } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { docsUrl, type DocsPage } from '@/lib/docs';

import { useOnboardingQuery, useOnboardingPatch } from '../hooks/useOnboarding';
import { useIsWalkthroughRunning } from '../hooks/useWalkthrough';

/**
 * The surfaces R7.1 names. The string IS the stored key, so renaming one
 * re-shows the mark to everybody who had already dismissed it.
 */
export type CoachMarkSurface =
  | 'position-partials'
  | 'csv-import'
  | 'options-tools'
  | 'dashboard-widgets';

interface CoachMarkCopy {
  title: string;
  body: string;
  /**
   * The "read more" target (R7.4). OPTIONAL, and the omission is a statement
   * rather than an oversight: `apps/docs` still ships `user-guide/options-tools`
   * as a placeholder that says "this page is not written yet", and the same rule
   * the walkthrough's step data is held to (a read-more that lands on a
   * placeholder is worse than no link at all — `steps.test.ts` fails on one)
   * applies here. The link comes back with the page.
   */
  docs?: DocsPage;
}

/**
 * The copy, kept as data next to the component that renders it.
 *
 * EVERY SENTENCE NAMES SOMETHING THAT IS ON THE SCREEN — the controls are
 * quoted by their real labels, and `CoachMark.test.tsx` re-reads the source of
 * each surface to check they still exist. This is the same rule R6.11 imposed
 * on the walkthrough copy, and it exists because Requirements 1 and 2 of this
 * spec are both about documentation describing fields the product does not
 * have.
 */
const COACH_MARKS: Record<CoachMarkSurface, CoachMarkCopy> = {
  'position-partials': {
    title: 'Scale in and out with fills',
    body:
      'Add Fill records an entry to scale in, or an exit to take part of the position off. ' +
      'Close Position stays disabled until the whole quantity has been exited.',
    docs: 'positions',
  },
  'csv-import': {
    title: 'Bring your history in from a CSV',
    body:
      "Pick a preset or map your broker's columns by hand, read the preview, then confirm. " +
      'Imports are additive — they add positions and fills to the account you choose.',
    docs: 'importHistory',
  },
  'options-tools': {
    title: 'Price a contract, decode a symbol',
    body:
      'The Black-Scholes pricer values a call or put from spot, strike, time to expiry, ' +
      'volatility and the risk-free rate. The OCC card decodes an option symbol or builds ' +
      'one from its parts.',
  },
  'dashboard-widgets': {
    title: 'Arrange the dashboard your way',
    body:
      "Add Widget puts another card on the grid and each card's menu removes it. On a pointer " +
      'device you can drag a card by its header and resize it from an edge; Reset layout puts ' +
      'everything back.',
    docs: 'gettingStarted',
  },
};

export interface CoachMarkProps {
  surface: CoachMarkSurface;
  /**
   * Whether the feature this mark describes can actually be used here (R7.5).
   * The caller answers, because the caller is the one holding the deployment's
   * own gating predicate. Defaults to `true` for the surfaces that have no gate
   * at all. Pass `false` — not `undefined` — while the answer is still loading.
   */
  available?: boolean;
}

export function CoachMark({ surface, available = true }: CoachMarkProps) {
  const { data: preference } = useOnboardingQuery();
  const patch = useOnboardingPatch();
  const walkthroughRunning = useIsWalkthroughRunning();
  const [dismissed, setDismissed] = useState(false);

  const mark = COACH_MARKS[surface];

  // Unknown counts as seen. Until the preference read lands we cannot tell a
  // first arrival from a hundredth, and a mark that appears for one frame and
  // then withdraws — on every visit, forever, for a user who dismissed it
  // months ago — is worse than one that is a round trip late. A failed read
  // lands here too, which is right: onboarding is never worth an error state.
  const seen = preference?.coachMarksSeen.includes(surface) ?? true;

  if (!available || walkthroughRunning || dismissed || seen) return null;

  function dismiss() {
    // Local first, so the mark is gone on this render rather than when the
    // write lands. The mutation carries its own error toast; if it fails, the
    // stored set is unchanged and the mark returns on the next visit, which is
    // the honest outcome — nothing was recorded.
    setDismissed(true);
    patch.mutate({ coachMarkSeen: surface });
  }

  return (
    <Popover
      open
      // Stated rather than left to the default: R7.3 rests on it. See the note
      // at the top of the file.
      modal={false}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <PopoverAnchor asChild>
        {/* The thing the popover points at, and the only trace the mark leaves
            in the layout. Decorative — the content beside it says everything
            this icon could. */}
        <span
          data-slot="coach-mark-anchor"
          className="inline-flex shrink-0 items-center text-muted-foreground"
        >
          <Lightbulb className="h-4 w-4" aria-hidden="true" />
        </span>
      </PopoverAnchor>
      <PopoverContent
        data-testid={`coach-mark-${surface}`}
        role="note"
        aria-label={mark.title}
        side="bottom"
        align="start"
        collisionPadding={8}
        // Never take focus from the surface being described (R7.3).
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="max-w-[calc(100vw-2rem)] space-y-3"
      >
        <div className="space-y-1">
          <p className="text-sm font-medium">{mark.title}</p>
          <p className="text-sm text-muted-foreground">{mark.body}</p>
        </div>
        <div className="flex items-center justify-end gap-3">
          {mark.docs !== undefined && (
            /* The host lives in docsUrl() and is written down nowhere here
               (C11). New tab: the reader is mid-task on this very surface. */
            <a
              href={docsUrl(mark.docs)}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer text-sm font-medium text-primary underline underline-offset-2"
            >
              Read more
            </a>
          )}
          {/* Outline, not primary: these surfaces already spend their one amber
              action elsewhere, and acknowledging a tip is not the important
              thing on any of them. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={dismiss}
          >
            Got it
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
