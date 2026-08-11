// WalkthroughLauncher — the walkthrough's permanent door, in Settings › Help.
//
// WHY IT EXISTS. Every other way into the walkthrough is temporary. The
// zero-state goes the moment the user creates their first account, and the
// activation checklist — which carries a "Start" on every row, completed ones
// included, precisely so the later sets stay reachable — RETIRES when all four
// items are complete. Retirement is required behaviour and must stay: the
// `status: 'done'` write it makes is what switches `useOnboarding`'s two
// expensive reads off for a user who can never see a checklist again. But it
// left a user who had finished onboarding with no route back to the guided tour
// from anywhere in the product, which is the same dead end the checklist's play
// buttons were added to fix, reached from the other side.
//
// SO IT OFFERS ALL FOUR SETS TO EVERYONE, UNCONDITIONALLY, and that is what
// makes it permanent rather than merely long-lived. It asks no question about
// the user's progress, so there is no answer that could take a control away:
// not `canStart` (which withholds a set whose opening screen is not the one the
// user is on, and would hide three of the four from exactly the retired user
// this is for), and not the checklist (which for that user is `null`). Nothing
// here reads or writes onboarding state at all — see `useWalkthroughLauncher`,
// which is the hook that property lives in.
//
// TWO OF THE SETS NEED THE USER TO ACT, AND THAT IS NOT THE SAME AS A BUTTON
// THAT CANNOT BEGIN. The position and close sets contain steps that only move on
// once the real thing has been done — creating the position, recording the exit
// fill — and a tour that waits for the user is the tour working. That is left
// alone here.
//
// What is NOT left alone is a set with nothing to open on. The close set starts
// on one of the user's open positions and this component knows of none, so it
// used to navigate nowhere and disappear; the account set is a tour of the
// welcome screen, which is gone for good once an account exists. `start()` now
// resolves the first from the user's own rows and answers for the second in
// words — see `useWalkthroughLauncher`. Both happen at the CLICK, so this card
// still asks the server nothing to render.

import { Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { useWalkthroughLauncher } from '../hooks/useWalkthrough';
import { CHECKLIST_ITEMS } from '../lib/derive-checklist';

export function WalkthroughLauncher() {
  const { start, isUnavailable } = useWalkthroughLauncher();

  return (
    <Card data-testid="walkthrough-launcher" className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-base">Guided walkthrough</CardTitle>
        <CardDescription>
          Take any part of the tour, as many times as you like. It only points at the screen it is
          talking about — nothing is changed and nothing is recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {/* Ordered, because these are the four setup steps in the order the
            checklist presents them — not because one gates the next. */}
        <ol className="flex flex-col">
          {CHECKLIST_ITEMS.map((item) => (
            <li
              key={item.id}
              data-walkthrough-set={item.id}
              className="flex min-h-9 items-center gap-3 py-1"
            >
              <span className="min-w-0 flex-1 text-sm">{item.label}</span>
              {/* A named button rather than the checklist's bare play triangle:
                  this card is a list of four things to start and nothing else,
                  so the action is the point of the row rather than an extra on
                  the end of it. The label goes in the accessible name too —
                  four buttons all reading "Start" name nothing to a screen
                  reader. */}
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 cursor-pointer"
                data-walkthrough-action={item.id}
                aria-label={`Start walkthrough: ${item.label}`}
                disabled={isUnavailable}
                onClick={() => start(item.id)}
              >
                <Play aria-hidden="true" />
                Start
              </Button>
            </li>
          ))}
        </ol>
        {/* The same withdrawal the zero-state and the checklist make when the
            runtime will not load, said out loud because this card would
            otherwise be four dead buttons and no explanation. */}
        {isUnavailable && (
          <p
            data-testid="walkthrough-launcher-unavailable"
            className="pt-3 text-sm text-muted-foreground"
          >
            The guided walkthrough could not be loaded. Nothing is lost — the getting-started guide
            covers the same four steps in full.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
