// ZeroState — the screen a newly-registered user lands on instead of six empty
// widgets (R3).
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
// paragraphs (the prerequisite AND R3.3's not-connected statement), three
// actions of three different weights, and an embedded checklist. Pushing all of
// that through `action` would use the component as a container rather than as
// the empty-state idiom, and widening the shared component for its one
// non-empty-state caller is worse. So the same Card primitives `EmptyState`
// itself is built from are used directly, with the same real-heading shape —
// no parallel primitive is introduced and no shared component is bent.
//
// R3.3 IS THE LOAD-BEARING COPY, not decoration. New users arrive expecting
// either a broker connection or an execution platform, and the account form
// asks for a starting balance and a currency without ever saying what the thing
// it is creating IS. The card states both halves plainly: a Tradr account
// MIRRORS a real brokerage account, and it is NOT connected to one — Tradr
// never places or executes trades. Say it here, once, before the user types a
// balance into a form and wonders whose money it is.
//
// EXACTLY ONE PRIMARY (AMBER) ACTION, AND IT IS "CREATE MY FIRST ACCOUNT".
// The design system reserves amber for the single action a view is about, and
// on this view that is the brokerage account: it is the prerequisite R3.3 names,
// the only control here that changes the user's data, and the one that makes
// this whole screen go away (R3.4). The walkthrough is a way of doing that same
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
// NEITHER FORK IS A DEAD END (R3.2) — and it is structural, not a branch. The
// checklist and the docs link are unconditional siblings: no choice on this
// screen hides them, so there is no state in which declining guidance leaves the
// user with less than they started with. That is cheaper to keep true than a
// rule about which branch re-renders what.
//
// THIS IS WHERE THE WALKTHROUGH IS REACHED FROM (R5.2). `useWalkthrough` never
// starts a tour on its own — mounting it does nothing, and no effect there reads
// the stored status and begins one — so every walkthrough in the product starts
// at one of the two call sites below: "Walk me through it", and the checklist's
// per-item "Start". That is what makes opt-in structural rather than a rule
// someone has to remember, and it is why a new entry point has to be a new
// deliberate call rather than something a status value can trigger.
//
// THE UNGUIDED PATH WRITES NOTHING, ON PURPOSE. "Create my first account" leaves
// the status on `pending`, and it does not need to record a refusal, because
// there is nothing for a stored status to auto-start: the restriction "declining
// guidance must never let the walkthrough start later" is already satisfied by
// the hook having no auto-start at all. Writing `skipped` here would be worse
// than useless — that value is the checklist's OWN dismissal (R4.5), and
// spending it on "I would rather click around myself" would take the checklist
// away from a user who never asked to lose it.

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { AccountDialog } from '@/features/accounts/components/AccountDialog';
import { docsUrl } from '@/lib/docs';

import { useOnboarding } from '../hooks/useOnboarding';
import { useWalkthrough } from '../hooks/useWalkthrough';
import type { ChecklistItemId } from '../lib/derive-checklist';

import { ActivationChecklist } from './ActivationChecklist';

export function ZeroState() {
  const { setStatus, isSaving } = useOnboarding();
  const { start, isUnavailable } = useWalkthrough();
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  /**
   * Both ways into the walkthrough, and they are the same two lines.
   *
   * The status write is the OPT-IN RECORD R5.2 asks for — "this user asked to be
   * guided" — and it belongs here rather than in `useWalkthrough` because the
   * hook writes no onboarding state at all: that is what makes exiting a tour
   * unable to discard anything (R5.3). Choosing an item off the checklist is the
   * same choice made about one step instead of four, so it records the same
   * thing.
   *
   * With no id, `start()` runs the first item the checklist says is outstanding,
   * which is simultaneously "begin" and "resume" (R5.6) — the zero-state has no
   * step index to hand it and must never acquire one.
   *
   * No `params`: the sets that open on `/positions/$positionId` need the id of a
   * position the user has not created yet. `useWalkthrough` handles that by
   * starting where the user already is and exiting cleanly if the target never
   * appears; the checklist stays exactly as it was either way.
   */
  const beginGuided = (itemId?: ChecklistItemId) => {
    setStatus('active');
    start(itemId);
  };

  return (
    <div
      data-testid="onboarding-zero-state"
      // Single column at every width, capped so the prose keeps a readable
      // measure on a desktop dashboard (R3.7). Nothing here has a minimum width,
      // so there is nothing to overflow a 320px viewport.
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
          {/* R3.3. Both halves, plainly, before the user meets a form asking for
              a starting balance. */}
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
            <Button
              variant="outline"
              data-testid="zero-state-walkthrough"
              className="w-full cursor-pointer motion-reduce:transition-none sm:w-auto"
              disabled={isSaving}
              // Wrapped, not passed by reference: `beginGuided` takes an
              // optional item id and a click handler is called with an event.
              onClick={() => beginGuided()}
            >
              Walk me through it
            </Button>
            {/* R9.1 — sample data is offered ALONGSIDE creating a real account,
                never instead of it, which is why it sits next to the primary
                action and does not replace it.
                TASK 31 SEAM: the seeder (`useDemoAccount`, POST
                /api/accounts/demo) is Phase G and does not exist. Rather than
                ship a control that silently does nothing, the option is present
                and DISABLED with the reason stated next to it. Task 31 drops
                `disabled`, adds `onClick={seed}`, and removes the note below;
                the tests pinning both are the ones to update. */}
            <Button
              variant="outline"
              data-testid="zero-state-sample-data"
              className="w-full cursor-pointer motion-reduce:transition-none sm:w-auto"
              disabled
              aria-describedby="zero-state-sample-data-note"
            >
              Add sample data
            </Button>
          </div>

          {/* R5.8 / Principle 4. The tour runtime is a lazy chunk, so it can 404
              after a deploy, be blocked, or simply be unreachable offline.
              `useWalkthrough` swallows that and leaves the stored status alone —
              the user has not skipped anything — which leaves this screen with a
              button that appears to do nothing. So say what happened, and point
              at the two things that still work. Every other part of the screen,
              the primary action included, is untouched by this state. */}
          {isUnavailable && (
            <p
              role="status"
              data-testid="zero-state-guidance-note"
              className="text-sm text-muted-foreground"
            >
              The guided walkthrough could not be loaded. Nothing is lost — the setup checklist
              below lists the same four steps, and the getting-started guide covers them in full.
            </p>
          )}

          <p id="zero-state-sample-data-note" className="text-xs text-muted-foreground">
            Sample data is not available yet.
          </p>
        </CardContent>
      </Card>

      {/* Unconditional, both of them: this is what stops either fork being a
          dead end (R3.2). The checklist reads its own state and handles its own
          loading, dismissed and retired cases.

          The handler is WITHDRAWN when the runtime will not load, which is the
          same judgement the prop's own contract makes: no handler, no per-item
          buttons, and a "Start" that can only fail is not an affordance. The
          checklist itself stays, with all four items and their labels — R5.8's
          "fully functional" is about the list, not the shortcut into it. */}
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
