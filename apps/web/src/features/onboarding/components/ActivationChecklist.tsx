// ActivationChecklist — the four-item "what set up means" list.
//
// IT WEARS THE WIDGET CHROME, NOT A CARD'S. On the populated dashboard it is a
// grid item — locked in the top-right slot, never persisted — and a card with
// its own border weight and radius sat in that grid like a visitor. So the
// shell here is `WidgetCard`'s (hairline border, `rounded-md`, the mono
// uppercase title strip, with the progress line in it), and the same shell
// serves every other mount: the zero-state, the empty layout, the mobile stack.
// Nothing here knows which one it is in — the caller sizes the box, this fills
// it.
//
// `resolveChecklistView` IS THE ONE STATEMENT OF WHICH OF THE FOUR THINGS TO
// SHOW. The route needs the same answer BEFORE rendering, to tell the grid
// whether to make room, and a second copy of the rules there is a second thing
// to get wrong. So the rules live in the function and the component reads it.
//
// It renders derived state and writes nothing except the onboarding STATUS.
// Every completion decision comes from `useOnboarding().checklist`, which is
// `deriveChecklist`'s output: this file must never restate a rule like
// `accountCount > 0` or `items.every(done)`, because that would fork the rule
// set out of `lib/derive-checklist.ts` — one function, one input shape, and one
// place the rules live. `allComplete` is read, not recomputed.
//
// NOTHING COMPLETES ON SAMPLE DATA ALONE, and this file gets that for free: the
// hook excludes the sample account and everything booked against it from the
// counts it derives from — so nothing here strikes an item through for trades
// the user never made. Nothing here knows demo data exists, and nothing here
// should.
//
// EVERY ITEM CARRIES ITS OWN GUIDED-STEP BUTTON, COMPLETED ONES INCLUDED. The
// walkthrough is guidance, not progress: a user who has logged a position may
// still want to be shown the calculator, and an item that has been ticked is the
// one they are most likely to want repeated. Withdrawing the button on
// completion also made the later sets unreachable in practice — the first item
// completes the moment the user has an account, which is the same moment the
// zero-state (the walkthrough's other door) goes away.
//
// WHICH BUTTONS ARE OFFERED IS THE CALLER'S ANSWER, not this file's. A set whose
// first step targets a control that is not on screen exits `target-missing` in
// silence a few seconds after it starts, so `canStartStep` withholds those —
// `useWalkthrough.canStartSet` is where that is decided, from the same data the
// steps themselves depend on.
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
// DISMISSAL — WHERE RECOVERY LIVES. Dismissal is only `status: 'skipped'` (no
// progress is stored anywhere, so there is nothing to lose), which means it is
// recoverable in principle. This component is what makes it recoverable in
// PRACTICE: for a `skipped` user it renders a single quiet "Reopen setup
// checklist" row instead of nothing at all. `setStatus('active')` flips the
// hook's gate on the same render, the two gated reads fire, and the checklist
// comes back with real counts. A dismissed checklist that left NO trace
// anywhere would satisfy "dismissible" and fail "re-openable without support
// intervention". Note the asymmetry with `done`: retirement is permanent and
// leaves nothing behind, dismissal leaves this one row.
//
// RETIREMENT. When all four are complete the checklist stops rendering AND
// writes `status: 'done'` once, so it does not reappear on later logins.
// The write is not merely an optimisation: it also switches off the two
// expensive gated reads for a user who can never see a checklist again.
//
// COLOUR: completion uses the `success` STATUS role, never `gain`. A green tick
// borrowing the gain token would read as a P&L direction on a screen full of
// money — the exact collision the design system reserves gain/loss to prevent.
// The tick is doubled by an icon shape and by screen-reader text, so completion
// never rests on colour alone.

import { Circle, CircleCheck, Play, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useOnboarding, type UseOnboardingResult } from '../hooks/useOnboarding';
import type { ChecklistItemId } from '../lib/derive-checklist';

/** What the checklist renders as, for the three checklist values (above). */
export type ChecklistView = 'none' | 'loading' | 'reopen' | 'card';

export function resolveChecklistView({
  checklist,
  preference,
  isError,
}: Pick<UseOnboardingResult, 'checklist' | 'preference' | 'isError'>): ChecklistView {
  // "There is no checklist for this user." Only a dismissal leaves a trace.
  if (checklist === null) return preference?.status === 'skipped' ? 'reopen' : 'none';
  // "Not known yet." A terminal failure is not a loading state, and neither is
  // an unknown status — see the note on `undefined` above.
  if (checklist === undefined) return isError || preference === undefined ? 'none' : 'loading';
  // Retired. The component persists it; this stops showing it now.
  return checklist.allComplete ? 'none' : 'card';
}

interface ActivationChecklistProps {
  /**
   * Start the walkthrough step set for one item. The ids are the same strings
   * as the step-set module names, so the wiring needs no lookup table.
   *
   * Optional, and the per-item buttons render ONLY when it is supplied: a
   * "Start" button with nothing behind it is a dead control, and the checklist
   * is useful without one (the items name their own actions, all of which are
   * reachable from the normal UI).
   *
   * That optionality is load-bearing now that the walkthrough is wired.
   * `ZeroState` passes `useWalkthrough().start` here and withdraws it when the
   * tour runtime fails to load, so the shortcut disappears while the checklist
   * itself carries on unchanged. Any other caller that has no walkthrough to
   * offer simply omits the prop.
   */
  onStartStep?: (id: ChecklistItemId) => void;
  /**
   * Whether that item's step set would actually run from where the user is —
   * `useWalkthrough().canStart`, which both mount sites pass straight through.
   *
   * Omitted, every item gets a button, which is right for a caller whose
   * `onStartStep` can always deliver. It is asked per item rather than per
   * render because the answer differs by set: the account set opens on a control
   * only the zero-state renders, and the close set on a position the user may
   * not have open.
   */
  canStartStep?: (id: ChecklistItemId) => boolean;
}

/**
 * The widget shell — the same classes as `WidgetCard`'s section and header, so
 * the checklist reads as one of the grid's own. `h-full` fills a grid item; in
 * a flow container it is inert.
 *
 * THE BOX IS 224px TALL IN THE GRID — six rows of 40px less the 16px gutter —
 * and the four rows, the header and the body padding come to 209px. Nothing
 * else fits: a footer here put the card 14px over and gave it a scrollbar. So
 * the progress line lives in the header, beside the dismiss control, and the
 * loading state mirrors that row for row.
 */
function Shell({
  trailing,
  children,
  ...rest
}: { trailing?: ReactNode; children: ReactNode } & ComponentProps<'section'>) {
  return (
    <section
      {...rest}
      className="flex h-full flex-col overflow-hidden rounded-md border border-hairline bg-card text-card-foreground"
    >
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-hairline px-3 py-1.5">
        <h3 className="font-mono text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
          Get set up
        </h3>
        <div className="flex items-center gap-2">{trailing}</div>
      </header>
      <div className="flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}

export function ActivationChecklist({ onStartStep, canStartStep }: ActivationChecklistProps) {
  const { checklist, preference, isError, isSaving, setStatus, dismiss } = useOnboarding();

  const allComplete = checklist?.allComplete === true;
  const status = preference?.status;

  // Fire the retirement write exactly once per mount. The ref is what
  // stops a second PATCH going out on the renders between the mutation being
  // sent and the new status landing in the cache — during that window
  // `allComplete` is still true and `status` is still the old one.
  const retired = useRef(false);
  useEffect(() => {
    if (!allComplete || retired.current || status === 'done') return;
    retired.current = true;
    setStatus('done');
  }, [allComplete, status, setStatus]);

  const view = resolveChecklistView({ checklist, preference, isError });

  if (view === 'none') return null;

  if (view === 'reopen') {
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

  if (view === 'loading') {
    // Row for row the geometry of the settled card, so the swap moves nothing
    // around it — whichever box the caller put this in.
    return (
      <Shell
        data-testid="activation-checklist-loading"
        role="status"
        aria-label="Loading your setup checklist"
        trailing={<Skeleton className="h-4 w-24 motion-reduce:animate-none" />}
      >
        <ol className="flex flex-col">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="flex min-h-9 items-center py-1">
              <Skeleton className="h-4 w-full motion-reduce:animate-none" />
            </li>
          ))}
        </ol>
      </Shell>
    );
  }

  // `card` implies a checklist; the type system cannot follow the resolver.
  if (!checklist) return null;

  const doneCount = checklist.items.filter((item) => item.done).length;

  return (
    <Shell
      data-testid="activation-checklist"
      trailing={
        <>
          {/* The non-colour carrier for overall progress, and the answer to
              "how far along am I?" that a setup checklist has to give. */}
          <span
            data-testid="activation-checklist-progress"
            className="font-mono text-xs text-muted-foreground"
          >
            {doneCount} of {checklist.items.length} complete
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="cursor-pointer text-muted-foreground"
            aria-label="Dismiss checklist"
            disabled={isSaving}
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </Button>
        </>
      }
    >
      {/* Ordered because the four items have a fixed presentation order, not
          because they gate on each other — any one can be completed first. */}
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
                action that view is allowed.

                A PLAY TRIANGLE, AND A NAME THE ICON DOES NOT CARRY. The row is
                a line of text and a tick; a word here read as a second label
                competing with the item's own. The icon says "this starts
                something" at a glance and `aria-label` says which — an icon
                alone would leave a screen reader with an unnamed button four
                times over, one per row. */}
            {onStartStep && (canStartStep?.(item.id) ?? true) && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 cursor-pointer"
                data-checklist-action={item.id}
                aria-label={`Start: ${item.label}`}
                onClick={() => onStartStep(item.id)}
              >
                <Play aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Shell>
  );
}
