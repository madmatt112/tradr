// ActivationChecklist — the four-item "what set up means" list (R4).
//
// It renders derived state and writes nothing except the onboarding STATUS.
// Every completion decision comes from `useOnboarding().checklist`, which is
// `deriveChecklist`'s output: this file must never restate a rule like
// `accountCount > 0` or `items.every(done)`, because that would fork the rule
// set out of `lib/derive-checklist.ts` (the "one function with one input shape"
// NFR). `allComplete` is read, not recomputed.
//
// R4.8 follows for free: item 1 stays incomplete while only demo data is
// present because the hook excludes demo accounts from the count it derives
// from. Nothing here knows demo data exists, and nothing here should.
//
// THE THREE CHECKLIST VALUES ARE THREE DIFFERENT ANSWERS, and this component is
// the reason the hook bothers to distinguish them:
//
//   `undefined` — not known yet. A read is in flight (or failed). Render a
//                 skeleton, never four unticked boxes: a half-loaded derivation
//                 is a WRONG answer, not an early one, and would flash "you
//                 have done nothing" at a fully set-up user on every load.
//                 But ONLY once `preference` has landed — see below.
//   `null`      — this user has no checklist, because onboarding is `done` or
//                 `skipped`, so the reads it would need were never issued. A
//                 skeleton here would spin forever waiting for a request that
//                 is never going to happen.
//   a Checklist — the answer. Render it.
//
// `undefined` COVERS TWO SITUATIONS AND ONLY ONE OF THEM EARNS A SKELETON. The
// hook composes a cheap preference read and two expensive gated reads, and the
// cheap one lands first. Until it does, `preference` is `undefined` and we do
// not yet know whether this user is `pending`/`active` (a checklist is coming)
// or `done`/`skipped` (one never will be). Painting the four-row skeleton in
// that window means every established user gets a card on the dashboard that
// then collapses to a single ghost row or to nothing — a layout jump on the
// primary screen for the majority of users, which the design system forbids of
// a loading state. So `preference` is the gate: render nothing, occupying no
// space, while the status is unknown, and start the skeleton only once the
// status says a checklist is on its way. Once `preference` HAS landed the two
// values cannot be confused — a `done`/`skipped` user's checklist is `null`, so
// `undefined` past this point can only mean the gated reads are still in
// flight.
//
// R4.5 — WHERE RECOVERY LIVES. Dismissal is only `status: 'skipped'` (no
// progress is stored anywhere, so there is nothing to lose), which means it is
// recoverable in principle. This component is what makes it recoverable in
// PRACTICE: for a `skipped` user it renders a single quiet "Reopen setup
// checklist" row instead of nothing at all. `setStatus('active')` flips the
// hook's gate on the same render, the two gated reads fire, and the checklist
// comes back with real counts. A dismissed checklist that left NO trace
// anywhere would satisfy "dismissible" and fail "re-openable without support
// intervention". Note the asymmetry with `done`: retirement (R4.7) is
// permanent and leaves nothing behind, dismissal leaves this one row.
//
// R4.7 — RETIREMENT. When all four are complete the checklist stops rendering
// AND writes `status: 'done'` once, so it does not reappear on later logins.
// The write is not merely an optimisation: it also switches off the two
// expensive gated reads for a user who can never see a checklist again.
//
// COLOUR: completion uses the `success` STATUS role, never `gain`. A green tick
// borrowing the gain token would read as a P&L direction on a screen full of
// money — the exact collision the design system reserves gain/loss to prevent.
// The tick is doubled by an icon shape and by screen-reader text, so completion
// never rests on colour alone.

import { Circle, CircleCheck, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useOnboarding } from '../hooks/useOnboarding';
import type { ChecklistItemId } from '../lib/derive-checklist';

interface ActivationChecklistProps {
  /**
   * Start the walkthrough step set for one item. The ids are the same strings
   * as the step-set module names, so the wiring needs no lookup table.
   *
   * Optional, and the per-item buttons render ONLY when it is supplied: a
   * "Start" button with nothing behind it is a dead control, and the checklist
   * is useful without one (the items name their own actions, all of which are
   * reachable from the normal UI — R4.3).
   *
   * That optionality is load-bearing now that the walkthrough is wired.
   * `ZeroState` passes `useWalkthrough().start` here and withdraws it when the
   * tour runtime fails to load (R5.8), so the shortcut disappears while the
   * checklist itself carries on unchanged. Any other caller that has no
   * walkthrough to offer simply omits the prop.
   */
  onStartStep?: (id: ChecklistItemId) => void;
}

export function ActivationChecklist({ onStartStep }: ActivationChecklistProps) {
  const { checklist, preference, isError, isSaving, setStatus, dismiss } = useOnboarding();

  const allComplete = checklist?.allComplete === true;
  const status = preference?.status;

  // Fire the R4.7 retirement write exactly once per mount. The ref is what
  // stops a second PATCH going out on the renders between the mutation being
  // sent and the new status landing in the cache — during that window
  // `allComplete` is still true and `status` is still the old one.
  const retired = useRef(false);
  useEffect(() => {
    if (!allComplete || retired.current || status === 'done') return;
    retired.current = true;
    setStatus('done');
  }, [allComplete, status, setStatus]);

  // "There is no checklist for this user." Only a dismissal leaves a trace.
  if (checklist === null) {
    if (status !== 'skipped') return null;
    return (
      <div data-testid="activation-checklist-reopen">
        <Button
          variant="ghost"
          size="sm"
          className="cursor-pointer text-muted-foreground"
          disabled={isSaving}
          onClick={() => setStatus('active')}
        >
          <RotateCcw aria-hidden="true" />
          Reopen setup checklist
        </Button>
      </div>
    );
  }

  // "Not known yet." A terminal failure is not a loading state — an unticked
  // box we cannot substantiate is worse than no box, so render nothing at all.
  if (checklist === undefined) {
    if (isError) return null;
    // Status unknown: the cheap preference read has not landed, so we cannot
    // tell a user who is about to see a checklist from one who never will.
    // Occupy no space rather than reserve room for a card most users lose.
    if (preference === undefined) return null;
    return (
      <Card
        data-testid="activation-checklist-loading"
        role="status"
        aria-label="Loading your setup checklist"
        className="gap-4 py-4"
      >
        <CardHeader className="px-4">
          <Skeleton className="h-5 w-32 motion-reduce:animate-none" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-6 w-full motion-reduce:animate-none" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // R4.7: retired. The effect above persists it; this stops showing it now.
  if (allComplete) return null;

  const doneCount = checklist.items.filter((item) => item.done).length;

  return (
    <Card data-testid="activation-checklist" className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-base">Get set up</CardTitle>
        {/* The non-colour carrier for overall progress, and the answer to "how
            far along am I?" that R4's user story asks for. */}
        <CardDescription data-testid="activation-checklist-progress">
          {doneCount} of {checklist.items.length} complete
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            className="cursor-pointer"
            aria-label="Dismiss checklist"
            disabled={isSaving}
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        {/* Ordered because R4.1 fixes the order, not because the items gate on
            each other — any one can be completed first (R4.3). */}
        <ol className="flex flex-col">
          {checklist.items.map((item) => (
            <li
              key={item.id}
              // The join to the walkthrough: this attribute is the anchor the
              // tour targets and the handle the per-item action is found by.
              data-checklist-item={item.id}
              className="flex min-h-9 items-center gap-3 py-1"
            >
              {item.done ? (
                <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 text-sm',
                  item.done && 'text-muted-foreground line-through',
                )}
              >
                {item.label}
                <span className="sr-only">{item.done ? ' — completed' : ' — not completed'}</span>
              </span>
              {/* No primary (amber) action anywhere on this card. The checklist
                  is embedded in the zero-state, which carries the one primary
                  action that view is allowed. */}
              {!item.done && onStartStep && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 cursor-pointer"
                  data-checklist-action={item.id}
                  aria-label={`Start: ${item.label}`}
                  onClick={() => onStartStep(item.id)}
                >
                  Start
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
