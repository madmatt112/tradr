// ZeroState — the screen a newly-registered user lands on instead of six empty
// widgets.
//
// WHAT IT REPLACES. `/dashboard` renders six widgets, and for a user with no
// accounts every one of them is empty and phrases its emptiness differently:
// "Close a position to see stats." / "No open positions. Create one to get
// started." / "No accounts yet." Each is individually correct and the screen as
// a whole reads as broken, because nothing on it says which of the six holes to
// fill first. This component answers that question once, at the top, in the
// user's words: you need a brokerage account, and here is how to get one.
//
// WHY NOT `EmptyState`. The shared `EmptyState` is a centred `max-w-md` card
// with one string description and one action slot, and the zero-state needs two
// paragraphs (the prerequisite AND the not-connected statement), three actions
// of three different weights, and an embedded checklist. Pushing all of that
// through `action` would use the component as a container rather than as the
// empty-state idiom, and widening the shared component for its one
// non-empty-state caller is worse. So the same Card primitives `EmptyState`
// itself is built from are used directly, with the same real-heading shape —
// no parallel primitive is introduced and no shared component is bent.
//
// THE NOT-CONNECTED COPY IS LOAD-BEARING, not decoration. New users arrive
// expecting either a broker connection or an execution platform, and the
// account form asks for a starting balance and a currency without ever saying
// what the thing it is creating IS. The card states both halves plainly: a
// Tradr account MIRRORS a real brokerage account, and it is NOT connected to
// one — Tradr never places or executes trades. Say it here, once, before the
// user types a balance into a form and wonders whose money it is.
//
// EXACTLY ONE PRIMARY (AMBER) ACTION, AND IT IS "CREATE MY FIRST ACCOUNT".
// The design system reserves amber for the single action a view is about, and
// on this view that is the brokerage account: it is the prerequisite that copy
// names, the only control here that changes the user's data, and the one that
// makes this whole screen go away. The walkthrough is a way of doing that same
// thing with help, not a different outcome, so it takes `outline`; sample data
// is an aside. `ActivationChecklist` deliberately carries no primary action of
// its own for exactly this reason — the one amber this composed view is allowed
// lives here.
//
// The docs link is a MUTED underlined link, not the app's usual `text-primary`
// one (ImportPage, Sidebar). Those surfaces have no amber button competing with
// them; this one does, and an amber link two inches under an amber button is a
// second primary action in everything but markup.
//
// NEITHER FORK IS A DEAD END — and it is structural, not a branch. The
// checklist and the docs link are unconditional siblings: no choice on this
// screen hides them, so there is no state in which declining guidance leaves the
// user with less than they started with. That is cheaper to keep true than a
// rule about which branch re-renders what.
//
// THIS IS WHERE THE WALKTHROUGH IS REACHED FROM. `useWalkthrough` never starts
// a tour on its own — mounting it does nothing, and no effect there reads the
// stored status and begins one — so every walkthrough in the product starts at
// one of the two call sites below: "Walk me through it", and the checklist's
// per-item "Start". That is what makes opt-in structural rather than a rule
// someone has to remember, and it is why a new entry point has to be a new
// deliberate call rather than something a status value can trigger.
//
// THE UNGUIDED PATH WRITES NOTHING, ON PURPOSE. "Create my first account" leaves
// the status on `pending`, and it does not need to record a refusal, because
// there is nothing for a stored status to auto-start: the restriction "declining
// guidance must never let the walkthrough start later" is already satisfied by
// the hook having no auto-start at all. Writing `skipped` here would be worse
// than useless — that value is the checklist's OWN dismissal, and spending it
// on "I would rather click around myself" would take the checklist away from a
// user who never asked to lose it.
//
// "WALK ME THROUGH IT" IS BLOCKED RATHER THAN QUEUED WHEN THERE IS NO STEP TO
// RUN. `start()` returns silently when the checklist names no outstanding item —
// which is the truth for a whole round trip while the positions read is in
// flight, and permanently for a user who dismissed the checklist. Two answers
// were available and only one of them is honest at the moment of the click:
// remembering the click and firing when the checklist lands would put a
// walkthrough on screen seconds after the user pressed a button that appeared
// to do nothing, and it would need exactly the auto-start effect nothing in
// this feature is allowed to have. So the control states its own condition
// instead — `aria-disabled` with the reason next to it, and no status write —
// and becomes live the instant there is a step behind it. `guidanceGap()` below
// is the single place that decides, so the button, its description and the
// click guard can never disagree.

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { AccountDialog } from '@/features/accounts/components/AccountDialog';
import { docsUrl } from '@/lib/docs';

import { useDemoAccount } from '../hooks/useDemoAccount';
import { useOnboarding } from '../hooks/useOnboarding';
import { useWalkthrough } from '../hooks/useWalkthrough';
import type { Checklist, ChecklistItemId } from '../lib/derive-checklist';

import { ActivationChecklist } from './ActivationChecklist';

/** The note both the guidance paragraph and the button's description point at. */
const GUIDANCE_NOTE_ID = 'zero-state-guidance-note';
/** The same arrangement for the sample-data control while its seed is in flight. */
const SAMPLE_DATA_NOTE_ID = 'zero-state-sample-data-note';

/**
 * Why the guided fork cannot run right now, in the user's words — or `null` when
 * it can. This is the one condition; everything else on the screen reads it.
 *
 * The three cases are the three ways `useWalkthrough().start()` has nothing to
 * do, and they are genuinely different situations, so they get different
 * sentences rather than one that is vague enough to cover all of them.
 * `allComplete` is READ, never recomputed, for the same reason `ActivationChecklist`
 * reads it: the rule lives in `deriveChecklist` and nowhere else.
 */
function guidanceGap(
  isUnavailable: boolean,
  checklist: Checklist | null | undefined,
): string | null {
  if (isUnavailable) {
    return 'The guided walkthrough could not be loaded. Nothing is lost — the setup checklist below lists the same four steps, and the getting-started guide covers them in full.';
  }
  if (checklist === undefined) {
    return 'The guided walkthrough is waiting for your setup checklist to load. It will be ready in a moment.';
  }
  if (checklist === null || checklist.allComplete) {
    return 'The guided walkthrough follows the setup checklist, and no step is outstanding. Reopen the checklist below to be guided.';
  }
  return null;
}

export function ZeroState() {
  const { setStatus, isSaving, checklist } = useOnboarding();
  const { start, isUnavailable } = useWalkthrough();
  const { seed, isPending: isSeeding } = useDemoAccount();
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  const guidanceNote = guidanceGap(isUnavailable, checklist);
  const guidedBlocked = guidanceNote !== null;

  /**
   * Both ways into the walkthrough, and they are the same three lines.
   *
   * The status write is the OPT-IN RECORD — "this user asked to be guided" — and
   * it belongs here rather than in `useWalkthrough` because the hook writes no
   * onboarding state at all: that is what makes exiting a tour unable to discard
   * anything. Choosing an item off the checklist is the same choice made about
   * one step instead of four, so it records the same thing.
   *
   * THE WRITE COMES FIRST, BEFORE THE LAZY CHUNK HAS HAD A CHANCE TO FAIL, and
   * that is deliberate rather than an oversight. What is being recorded is the
   * user's CHOICE, which they have already made by the time the import is even
   * requested; whether the runtime then arrives is not something the choice was
   * conditional on. Leaving the stored status alone when the runtime fails is a
   * rule about never recording a REFUSAL the user did not make — `skipped` is
   * the value that would cost them the checklist — and `active` is not one: it
   * starts nothing on a later login (the hook has no auto-start at all), it
   * keeps the checklist reads enabled exactly as `pending` does, and it is the
   * same value a successful tour would have written. Deferring it until the
   * chunk resolved would mean either awaiting a hook call documented to return
   * `void` and never reject, or an effect watching `isUnavailable` — a second
   * piece of tour lifecycle living outside `useWalkthrough`, to record something
   * that is already true. `ZeroState.test.tsx` pins this ordering so it stays a
   * decision.
   *
   * With no id, `start()` runs the first item the checklist says is outstanding,
   * which is simultaneously "begin" and "resume" — the zero-state has no step
   * index to hand it and must never acquire one.
   *
   * No `params`: the sets that open on `/positions/$positionId` need the id of a
   * position the user has not created yet. `useWalkthrough` handles that by
   * starting where the user already is and exiting cleanly if the target never
   * appears; the checklist stays exactly as it was either way.
   */
  const beginGuided = (itemId?: ChecklistItemId) => {
    // The guard, not just the styling: an `aria-disabled` control is still
    // clickable and still activates on Enter, which is the whole reason it stays
    // in the tab order. Nothing is written on a click that cannot start a tour.
    if (guidedBlocked) return;
    setStatus('active');
    start(itemId);
  };

  return (
    <div
      data-testid="onboarding-zero-state"
      // Single column at every width, capped so the prose keeps a readable
      // measure on a desktop dashboard. Nothing here has a minimum width, so
      // there is nothing to overflow a 320px viewport.
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-6"
    >
      <Card>
        <CardHeader className="px-4 sm:px-6">
          <h2 className="text-xl leading-none font-semibold">Welcome to Tradr</h2>
          <CardDescription>
            Start with a brokerage account. Every position, fill and ledger entry is booked against
            one, so there is nothing to show on this dashboard until you create it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4 sm:px-6">
          {/* The not-connected statement. Both halves, plainly, before the user
              meets a form asking for a starting balance. */}
          <p data-testid="zero-state-not-connected" className="text-sm text-muted-foreground">
            A Tradr account mirrors a real brokerage account: the same currency, the same starting
            balance, the same trades. It is not connected to your broker. Tradr never places or
            executes trades — you record trades you have already made.
          </p>

          {/* Stacked and full-width on a phone, side by side from `sm` up. The
              row wraps rather than shrinking, so no label is ever truncated. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              data-testid="zero-state-create-account"
              className="w-full cursor-pointer motion-reduce:transition-none sm:w-auto"
              onClick={() => setAccountDialogOpen(true)}
            >
              Create my first account
            </Button>
            {/* `aria-disabled`, NEVER the `disabled` attribute, whenever the
                reason is one the user can do something about. `disabled` takes
                the control out of the tab order, so a keyboard user never meets
                it and never learns the guided path exists — the same
                focusable-but-inert pattern the sidebar's in-flight Performance
                link uses. `disabled` IS still right for `isSaving`, which is a
                sub-second window with nothing to explain and no choice to lose.
                Either way the reason is real markup the control points at, the
                way the sample-data option does. */}
            <Button
              variant="outline"
              data-testid="zero-state-walkthrough"
              className="w-full cursor-pointer motion-reduce:transition-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:w-auto"
              disabled={isSaving}
              aria-disabled={guidedBlocked || undefined}
              aria-describedby={guidedBlocked ? GUIDANCE_NOTE_ID : undefined}
              // Wrapped, not passed by reference: `beginGuided` takes an
              // optional item id and a click handler is called with an event.
              onClick={() => beginGuided()}
            >
              Walk me through it
            </Button>
            {/* Sample data is offered ALONGSIDE creating a real account, never
                instead of it, which is why it sits next to the primary action,
                takes `outline` rather than the amber, and does not replace
                anything.
                NO `disabled` ATTRIBUTE ON THIS CONTROL, in flight or otherwise.
                It spent a phase disabled while the seeder was unbuilt, and a
                keyboard user never met it: `disabled` removes a control from the
                tab order, so the option might as well not have existed for them.
                The in-flight state uses the same focusable `aria-disabled` +
                stated-reason pattern as the guided fork above. */}
            <Button
              variant="outline"
              data-testid="zero-state-sample-data"
              className="w-full cursor-pointer motion-reduce:transition-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:w-auto"
              aria-disabled={isSeeding || undefined}
              aria-describedby={isSeeding ? SAMPLE_DATA_NOTE_ID : undefined}
              // The guard, not just the styling — an `aria-disabled` control is
              // still clickable, which is the price of leaving it reachable.
              onClick={() => {
                if (isSeeding) return;
                seed();
              }}
            >
              Add sample data
            </Button>
          </div>

          {/* A runtime that will not load is an ordinary outcome, not an
              exception, and these are the two quieter cases alongside it. The
              tour runtime is a lazy chunk, so it can 404 after a deploy, be
              blocked, or simply be unreachable offline; `useWalkthrough`
              swallows that and leaves the stored status alone — the user has not
              skipped anything — which would otherwise leave this screen with a
              button that appears to do nothing. The checklist still loading, and
              the checklist having been dismissed, leave the same button in the
              same state for different reasons, so all three say which one it is
              here rather than being flattened into one vague sentence.
              `role="status"` because this appears and disappears under the user,
              and every other part of the screen — the primary action included —
              is untouched by any of it. */}
          {guidanceNote !== null && (
            <p
              id={GUIDANCE_NOTE_ID}
              role="status"
              data-testid="zero-state-guidance-note"
              className="text-sm text-muted-foreground"
            >
              {guidanceNote}
            </p>
          )}

          {/* Seeding drives a set of trades through the real position
              lifecycle, so it is long enough to need saying. `role="status"`
              for the same reason as the guidance note above: it appears and
              disappears under the user while the rest of the screen carries on. */}
          {isSeeding && (
            <p
              id={SAMPLE_DATA_NOTE_ID}
              role="status"
              data-testid="zero-state-sample-data-note"
              className="text-sm text-muted-foreground"
            >
              Adding sample data. Your dashboard fills in as soon as it lands.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Unconditional, both of them: this is what stops either fork being a
          dead end. The checklist reads its own state and handles its own
          loading, dismissed and retired cases.

          The handler is WITHDRAWN when the runtime will not load, which is the
          same judgement the prop's own contract makes: no handler, no per-item
          buttons, and a "Start" that can only fail is not an affordance. The
          checklist itself stays, with all four items and their labels — what a
          failed runtime has to leave fully functional is the list, not the
          shortcut into it. */}
      <ActivationChecklist onStartStep={isUnavailable ? undefined : beginGuided} />

      <p className="text-sm text-muted-foreground">
        {/* The docs live on their own host, so this is an <a>, not a router
            Link, and it opens in a new tab — a reader following it is mid-task.
            The host comes from docsUrl() and is never written down here. */}
        <a
          data-testid="zero-state-docs-link"
          href={docsUrl('gettingStarted')}
          target="_blank"
          rel="noreferrer"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        >
          Read the getting-started guide
        </a>
      </p>

      <AccountDialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen} account={null} />
    </div>
  );
}
