/**
 * The walkthrough's tour engine — a thin adapter over `driver.js`.
 *
 * This is the ONLY module in the codebase permitted to import `driver.js`.
 * Everything a caller touches is declared here: `TourStep`, `TourHandlers`,
 * `TourExitReason`. No `driver.js` type crosses the boundary, so swapping the
 * library out is a change to this file and nothing else.
 *
 * It also owns the ONE `import '../tour.css'`. That stylesheet `@import`s the
 * vendor CSS itself, so this module must not import `driver.js/dist/driver.css`
 * as well — doing so would put the vendor rules after the token overrides and
 * lose the cascade. Because the stylesheet is reached only from here, and
 * `useWalkthrough` reaches here only through a dynamic import, neither the tour
 * runtime nor its CSS lands in the dashboard route's initial payload — which is
 * every returning user, none of whom are being guided.
 *
 * The module holds NO step content — copy, targets and docs links are data,
 * authored in `lib/steps/*.ts` and passed in.
 */

import { driver, type Driver, type DriveStep, type DriverHook } from 'driver.js';

import '../tour.css';

/** Consumed by `tour.css`; also the hook a future restyle can hang off. */
const POPOVER_CLASS = 'tradr-tour';
/** The hint element's class, styled in `tour.css`. */
const HINT_CLASS = 'tradr-tour-action-hint';
/** driver.js's own disabled-button class — `opacity: .5; pointer-events: none`. */
const DRIVER_BTN_DISABLED_CLASS = 'driver-popover-btn-disabled';
/** On the popover while the step cannot be advanced by "Next". */
const HELD_CLASS = 'tradr-tour-held';
/** Narrower popover, for the one step with no room at the full width. */
const NARROW_CLASS = 'tradr-tour-narrow';

export type TourStepSide = 'top' | 'right' | 'bottom' | 'left';
export type TourStepAlign = 'start' | 'center' | 'end';

export interface TourStep {
  /**
   * CSS selector for the control this step anchors to. Omit for a step that is
   * about the screen rather than a control — it renders centred.
   */
  target?: string;
  title: string;
  /**
   * Rendered as HTML, so a step can carry its `docsUrl()` "read more" anchor
   * without this module knowing anything about documentation. Step copy is
   * author-written and lives in the repo; NEVER interpolate user input here.
   */
  description: string;
  side?: TourStepSide;
  align?: TourStepAlign;
  /**
   * How long to wait for `target` to appear, in ms, before giving up. Set it on
   * any step whose target is created by the step before it — a dialog opening, a
   * route still navigating. Omitted means "must already be there"; on a miss the
   * tour ends rather than pointing at nothing.
   */
  waitForMs?: number;
  /**
   * When true, "Next" does NOT advance the tour: the caller calls `advance()`
   * when the real event lands. The highlighted control stays interactive either
   * way (`disableActiveInteraction: false`).
   *
   * Has no effect on the LAST step, where the button is "Done" — finishing is
   * not advancing, and trapping the user behind an action they may have already
   * taken would leave no way out but Escape. For the same reason it has no
   * effect while the highlighted control is disabled — see `isGatedStep`.
   *
   * READ THIS BEFORE BELIEVING THE STEP DATA. The flag carries two meanings, and
   * only one of them is this one. It also declares "the next step's target is
   * created by this step's action", which is what `steps.test.ts` reads to
   * require a `waitForMs` on that next step — so a step keeps the flag even when
   * its action publishes nothing we can observe. Because a gated step ignores
   * "Next", such a step would strand the user, so `useWalkthrough` downgrades it
   * at runtime: any step whose target is absent from `ACTION_SIGNALS` there is
   * handed to the engine with the flag off and advances on "Next" like any
   * other. Four are, today — `[data-tour="account-new"]`,
   * `[data-tour="calculator-risk"]`, `[data-tour="calculator-account"]` and
   * `[data-tour="position-new"]` — because each asks for a pure UI gesture that
   * changes no server data. `hooks/useWalkthrough.ts` owns both the mapping and
   * the downgrade, and a test there fails if a fifth step joins them unnoticed.
   *
   * A DOWNGRADED STEP IS NOT THEREBY DRIVEN BY "NEXT" — two of the four are
   * driven by `advanceOnAppearanceOf` below, because "Next" is the one thing
   * that cannot move them.
   */
  advanceOnAction?: boolean;
  /**
   * ADVANCE WHEN THIS SELECTOR APPEARS. The step's action IS something we can
   * observe after all — not on the event bus, but in the DOM: the control the
   * NEXT step is about arriving is the gesture having happened.
   *
   * IT EXISTS BECAUSE "NEXT" COULD NOT WORK ON THESE STEPS AND LOOKED LIKE IT
   * DID. A step downgraded to "Next" (see `advanceOnAction`) whose next step's
   * target lives inside a dialog the user has not opened moves the tour onto a
   * target that is not there, and driver.js then holds the PREVIOUS popover on
   * screen for the whole of that step's `waitForElement` window — 15 seconds on
   * both sets that do this. To the user "Next" is a live button that does
   * nothing, and then the walkthrough ends with a notice about a step they never
   * saw. That is the reported defect, against "Log a position" and "Create a
   * brokerage account": the only two sets whose first step opens a dialog.
   *
   * So the wait becomes the signal. While the selector is absent the step is
   * gated exactly as an action step is — "Next" is suppressed rather than
   * misleading — and the moment it resolves the tour advances by itself, which
   * is the gesture the step's own copy asked for ("Choose New Position"). Once
   * the control IS there the gate lifts, because from then on "Next" lands on a
   * step that exists.
   *
   * SET BY `useWalkthrough`, NOT AUTHORED. Only it knows which steps have no
   * event to advance on, and only it knows whether the next step is on this
   * step's own screen — a target that arrives by NAVIGATION must never be waited
   * for here, because nothing navigates until the tour moves and the wait would
   * never end.
   */
  advanceOnAppearanceOf?: string;
  /**
   * WHAT THE USER HAS TO DO, said in the imperative, for a step that cannot be
   * advanced by "Next".
   *
   * Shown in the popover only while the step is ACTUALLY held — not whenever it
   * is authored — because the gate releases on a control the user cannot press
   * (see `blockOn`), and telling somebody to choose a button that is greyed out
   * is worse than saying nothing. It is rendered next to a "Next" that has been
   * disabled for the same reason at the same moment, so the instruction and the
   * dead control can never disagree.
   *
   * Write the gesture and nothing else — "Choose New Account", not "Click the
   * New Account button to continue". The engine supplies the frame.
   */
  actionHint?: string;
  /**
   * Render this step's popover narrow (240px rather than 300px).
   *
   * FOR A STEP WITH NO ROOM ANY OTHER WAY, and there is exactly one. The close
   * set opens on "Add Fill", which sits at the bottom right of the position page
   * and opens a centred dialog. Measured at 1280x720, every placement fails at
   * the full width: above lands 12px inside the button, below and right leave the
   * viewport, and to the left a 300px popover reaches x=862 across a dialog that
   * runs to x=896. Narrowing it is what makes the left side fit — a 240px
   * popover starts at x=922, clear of the dialog on one side and of the button
   * on the other.
   *
   * Not a general dial. A narrower popover is a taller one, so this trades a
   * horizontal problem for a vertical one and is worth it only where the
   * horizontal problem is the unsolvable one.
   */
  narrow?: boolean;
}

export type TourExitReason =
  /** Ran off the end, or "Done" was clicked. */
  | 'completed'
  /**
   * The user turned the walkthrough down where it stood — close button, overlay
   * click, or Escape — WITH A WAY ON AVAILABLE. It means they did not want the
   * tour, which is why it does not cover a tour that ended because the session
   * did, and why it does not cover leaving a step whose control was not on
   * screen: the funnel exists to find where users stop, and "declined the
   * walkthrough", "left the app" and "we pointed at nothing" are different
   * answers to that question.
   */
  | 'dismissed'
  /**
   * The tour was pointing at a control that is not on screen — one that never
   * appeared within its `waitForMs`, or one that has gone since. Both are the
   * same thing to the user, and neither is anything they did.
   */
  | 'target-missing'
  /**
   * The session ended under the tour — a logout, or an expiry — and took it
   * down with it. Not a judgement on the walkthrough: the user was still in it.
   */
  | 'session-ended';

/**
 * WHY THE USER COULD NOT GET PAST A STEP — the engine's own classification, and
 * the ONLY thing a caller should explain a stop from.
 *
 * There are exactly two answers, and they are not interchangeable: either the
 * control the step asks for was there and the user chose not to use it, or it
 * was not there at all. Telling someone the first when it was the second blames
 * them for a control that had vanished, which is this area's recurring defect
 * one level down from where it kept being fixed.
 *
 * The classification carries its own step, so "which step?" cannot be answered
 * from a different source than "why?", and a cause without a step is
 * unrepresentable rather than merely unlikely.
 */
export type TourBlockCause =
  /**
   * The step only moves on the real action, and the control was on screen and
   * usable — so the user had the means and did not take it.
   */
  | 'action-required'
  /**
   * The step's control is not on screen. It never resolved within `waitForMs`,
   * or it was there when the step opened and has since unmounted — a dialog the
   * user closed, a row that went away. Nothing was asked of the user that they
   * could have done.
   */
  | 'target-missing';

export interface TourBlock {
  cause: TourBlockCause;
  /** The step the tour could not carry the user past. */
  step: TourStep;
}

export interface TourHandlers {
  /** Fires as each step is highlighted, before any animation. */
  onStepChange?: (index: number, step: TourStep) => void;
  /**
   * Fires just before a move the USER made — "Next", or the right arrow —
   * carries the tour off `index`, while that step is still the current one.
   *
   * It is the caller's chance to prepare the screen the next step lives on,
   * which cannot wait until the move has happened: driver.js reports a step
   * change only once it has RESOLVED that step's target, and a target on a
   * screen nobody navigated to resolves never. A caller driving the tour with
   * `advance()` needs no such hook — it already knows it is about to advance,
   * and prepares before it calls.
   */
  onBeforeAdvance?: (index: number) => void;
  /**
   * Fires exactly once per tour, however it ended.
   *
   * `blocked` IS HOW THE TOUR SAYS WHY IT STOPPED, and it is the answer to a
   * failure this walkthrough has now shipped three times: the tour vanishing
   * with nothing on screen to explain it. It names the step the user could not
   * get past AND which of the two things held them there, together, and it is
   * present only when there was such a step.
   *
   * NOBODY OUTSIDE THIS MODULE CAN WORK EITHER OUT, WHICH IS WHY THEY ARE
   * DECIDED HERE AND NOT RE-DERIVED THERE. `onStepChange` never fires for a step
   * that failed to resolve, so the caller's idea of "the current step" is the
   * one BEFORE the failure; and whether the user was really being asked for an
   * action depends on whether the highlighted control was on screen and usable,
   * which is read live here (`blockOn`). A caller that reconstructed the cause
   * from the step's own `advanceOnAction` flag, or from `reason`, would be
   * guessing at exactly the moment it must not.
   *
   * Absent means the tour ended without anyone being stuck — completion, an
   * ordinary dismissal, a session that went away, an ending the app itself
   * asked for.
   */
  onExit?: (reason: TourExitReason, blocked?: TourBlock) => void;
}

let instance: Driver | null = null;
let activeSteps: TourStep[] = [];
let activeHandlers: TourHandlers = {};
let exitReason: TourExitReason = 'dismissed';
/** Why the tour could not carry on, if it could not — see `TourHandlers.onExit`. */
let blocked: TourBlock | undefined;
let pendingStopTimer: number | undefined;
/**
 * The one DOM watch a running step needs, for the two things that change under
 * it: an `advanceOnAppearanceOf` control arriving, and the gate opening or
 * closing beneath a "Next" button that has to look like the answer.
 */
let stepObserver: MutationObserver | null = null;
/** The step `stepObserver` belongs to; `-1` when nothing is watched. */
let watchedIndex = -1;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * THE HINT IS PART OF THE DESCRIPTION, AND THAT IS A PLACEMENT FIX, NOT A
 * STYLISTIC ONE.
 *
 * It was originally inserted into the popover after driver.js had rendered it,
 * which put ~32px of content into a box whose position had already been
 * computed for the height it had WITHOUT them. The popover then grew downward
 * past its own placement: measured at 1280x720, the position set's draft step
 * ended up with its bottom at y=566 across an "Add Fill" button at y=554 — the
 * tour standing on the control it was telling the user to press. Every tall step
 * had the same problem to some degree, and moving them one at a time would have
 * been fixing the symptom on whichever ones happened to be measured.
 *
 * Rendered here it is in the DOM before driver.js positions anything, so the
 * library measures the real height and places the popover correctly with no
 * repositioning, no post-render mutation, and nothing for a resize to get wrong.
 *
 * It is always rendered when the step has one, and HIDDEN by class while the
 * step is not held (`syncGateAffordance`). Hiding can only make the popover
 * shorter than the box driver.js placed, and a shorter popover cannot overlap
 * something the taller one cleared.
 */
function toDriveStep(step: TourStep): DriveStep {
  return {
    element: step.target,
    waitForElement: step.waitForMs,
    popover: {
      title: step.title,
      description:
        step.actionHint === undefined
          ? step.description
          : `${step.description}<p class="${HINT_CLASS}" role="status">To continue: ${escapeHtml(step.actionHint)}</p>`,
      side: step.side,
      align: step.align,
      // driver.js REPLACES the global `popoverClass` with a step's own, so the
      // base class has to be repeated here or the step loses every token style.
      ...(step.narrow === true ? { popoverClass: `${POPOVER_CLASS} ${NARROW_CLASS}` } : {}),
    },
  };
}

/**
 * Escape the authored hint before it goes into the description's HTML.
 *
 * The hint is repo-authored copy today, so this is not defending against a
 * hostile value — it is making sure the one interpolation in this file cannot
 * become the place a future hint carrying an apostrophe or an ampersand renders
 * as broken markup, or worse if the field ever takes a value from elsewhere.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * MAKE THE POPOVER TELL THE TRUTH ABOUT WHETHER "NEXT" WORKS.
 *
 * A gated step ignores "Next" — that is the whole point of an action step — but
 * the button went on looking pressable, so the honest behaviour read as a broken
 * one. Reported twice: a live control that does nothing is indistinguishable
 * from a bug, and users correctly stopped trusting the walkthrough rather than
 * looking for the action it wanted.
 *
 * So the same `isGatedStep` answer that decides whether the press moves the tour
 * now also decides what the popover looks like. One reading, two consequences:
 * "Next" is disabled, and the step's `actionHint` appears saying what to do
 * instead. They cannot come apart, because there is nothing to keep in step —
 * both are derived here, together, from the one call.
 *
 * RUN AGAIN ON EVERY DOM CHANGE, because the gate is not a property of the step:
 * it is read live, and it releases the moment the highlighted control becomes
 * unpressable (`blockOn`). The close set reaches exactly that state — a Close
 * Position button that stays disabled after a partial exit — and a user who was
 * told to press it, and handed a dead "Next", would have Escape as their only
 * way on. When the gate lifts, this puts "Next" back and takes the instruction
 * away in the same pass.
 */
function syncGateAffordance(index: number): void {
  const popover = document.querySelector('.driver-popover');
  if (!popover) return;

  const held = isGatedStep(index);

  const next = popover.querySelector<HTMLButtonElement>('.driver-popover-next-btn');
  if (next) {
    // WRITTEN ONLY WHEN THE VALUE ACTUALLY CHANGES, and that is not a
    // micro-optimisation — it is what stops this function driving itself. The
    // watch that calls it filters on `disabled` and `aria-disabled`, and
    // `setAttribute` queues a mutation record even when the value it writes is
    // the one already there. Writing unconditionally therefore re-triggers the
    // observer, which calls this again, forever.
    if (next.disabled !== held) next.disabled = held;
    const announced = String(held);
    if (next.getAttribute('aria-disabled') !== announced) {
      next.setAttribute('aria-disabled', announced);
    }
    // DRIVER.JS'S OWN DISABLED CLASS, not a treatment of ours. It is what the
    // library already puts on "Previous" at the first step, so a held "Next"
    // looks like the disabled control the user has been looking at since the
    // tour opened rather than a second, different idea of disabled.
    next.classList.toggle(DRIVER_BTN_DISABLED_CLASS, held);
  }

  // The hint itself is rendered with the description (`toDriveStep`); this only
  // decides whether it is shown. A class rather than a node, so the popover's
  // measured height is the one driver.js placed it for, and so this write cannot
  // reach the watch — `class` is not in its attribute filter.
  popover.classList.toggle(HELD_CLASS, held);
}

/**
 * Stop watching for the step being left.
 *
 * Called from `advance()` and from the teardown, which is EVERY way a step stops
 * being the current one. A watch that outlived its step would advance the tour
 * off whichever step came next the moment its selector happened to resolve — and
 * the position set navigates onto a screen carrying the very control the step
 * before it was waiting on, so that is a step skipped rather than a theoretical
 * one.
 */
function disarmStepWatch(): void {
  stepObserver?.disconnect();
  stepObserver = null;
  watchedIndex = -1;
}

/**
 * Wait for the control this step's gesture creates, and advance when it lands.
 *
 * Armed only when the selector is ABSENT: a step whose next control is already
 * on screen is not waiting for anything, "Next" can move it, and arming here
 * would advance it the instant the tour opened. That is what keeps the
 * calculator set — whose two gesture steps both name a control the page already
 * renders — behaving exactly as it did.
 *
 * `document.body` with `subtree`, because what we are waiting for is a dialog
 * being portalled in somewhere we do not own. The callback is cheap: one
 * `querySelector` per mutation batch, for as long as one step is on screen.
 */
function armStepWatch(index: number): void {
  disarmStepWatch();
  watchedIndex = index;

  // The appearance selector, when this step has one AND it is still to come. A
  // step whose next control is already on screen is not waiting for anything,
  // and arming that half would advance it the instant the tour opened.
  const selector = activeSteps[index]?.advanceOnAppearanceOf;
  const awaiting =
    selector !== undefined && document.querySelector(selector) === null ? selector : undefined;

  stepObserver = new MutationObserver(() => {
    if (watchedIndex !== index) return;
    if (awaiting !== undefined && document.querySelector(awaiting) !== null) {
      // Through `advanceFromUser`, not `advance`, because this IS the user
      // advancing — they did the thing the step asked for. It is also what gives
      // the caller its `onBeforeAdvance`, so the move is prepared the same way a
      // "Next" press would have been.
      advanceFromUser();
      return;
    }
    syncGateAffordance(index);
  });

  // `attributes` as well as `childList`, and filtered to the three the gate
  // reads: `blockOn` releases on a control that is disabled, so the button going
  // from enabled to disabled has to reach this watch or "Next" stays dead on a
  // step the user can no longer act on.
  stepObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'data-disabled'],
  });

  syncGateAffordance(index);
}

function clearState(): void {
  if (pendingStopTimer !== undefined) {
    window.clearTimeout(pendingStopTimer);
    pendingStopTimer = undefined;
  }
  disarmStepWatch();
  window.removeEventListener('keyup', handleKeyup);
  instance = null;
  activeSteps = [];
  activeHandlers = {};
  exitReason = 'dismissed';
  blocked = undefined;
}

/**
 * WHAT IS HOLDING THE USER ON THIS STEP, AND WHICH OF THE TWO THINGS IT IS —
 * decided in ONE place, from the live DOM, so that "does 'Next' advance?" and
 * "what do we tell the user?" can never be answers to differently-asked
 * questions. Every previous fix in this area corrected one of those readings and
 * left the other looking somewhere else.
 *
 * Read live rather than remembered from the highlight, because the answer
 * changes under the step: the control a user is being asked to press is often
 * disabled until they have done something else, and it may be enabled — or gone
 * — while the popover is still on screen.
 *
 * The states a gated step can be in, and nothing else:
 *
 * - NO CONTROL NAMED — `action-required`. A centred step gated on an action has
 *   nothing that could be missing, so the only thing holding the user is the
 *   action itself, which the caller reports when it lands.
 * - NAMED BUT NOT THERE — `target-missing`. The user is not declining anything;
 *   there is nothing on screen to decline. It is decided here rather than only
 *   in `handleHighlightStarted` because a control can go away AFTER it resolved:
 *   `#symbol` lives in the new-position dialog, so cancelling that dialog
 *   unmounts the control the step is pointing at while the tour still runs on it.
 * - THERE BUT UNUSABLE — nothing. A GATE THE USER CANNOT OPEN IS NOT A GATE, IT
 *   IS A TRAP: the rest of the page is `pointer-events: none` under a running
 *   tour, so a gated step whose control is disabled would leave Escape as the
 *   only way out, and Escape ends the walkthrough rather than continuing it.
 *   The close set reaches exactly that state — "It closes itself" highlights
 *   Close Position, disabled until the whole entered quantity has been exited,
 *   and the step before it advances on any exit fill, so a user who records the
 *   PARTIAL exit it invites arrives at a control they cannot press. Returning
 *   nothing hands them "Next", and there is then nothing to explain either: they
 *   had a way on.
 * - THERE AND USABLE — `action-required`. The gate holds, which is the whole
 *   point of an action step, and a user who leaves anyway declined something
 *   they could have done.
 *
 * TWO THINGS PUT A STEP IN THAT POSITION, AND `holdsNext` IS WHERE THEY MEET —
 * the authored `advanceOnAction`, and an `advanceOnAppearanceOf` control that
 * has not arrived yet. They are one question here because they have one answer:
 * either way the user is being asked to do something, and either way "Next" must
 * not pretend otherwise. A step held by neither is never blocking: "Next" moves
 * it, so whatever the user did, they had a way on.
 */
function holdsNext(step: TourStep): boolean {
  if (step.advanceOnAction === true) return true;
  // Held only while the control is still to come. Once it is on screen the step
  // is an ordinary one again: "Next" would land on a step that exists, so there
  // is nothing left to hold the user for.
  return (
    step.advanceOnAppearanceOf !== undefined &&
    document.querySelector(step.advanceOnAppearanceOf) === null
  );
}

function blockOn(index: number): TourBlock | undefined {
  const step = activeSteps[index];
  if (step === undefined || !holdsNext(step)) return undefined;
  if (step.target === undefined) return { cause: 'action-required', step };

  const element = document.querySelector(step.target);
  if (element === null) return { cause: 'target-missing', step };
  if (element.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return undefined;
  return { cause: 'action-required', step };
}

/**
 * Whether "Next" (or its key) is suppressed on this step.
 *
 * Being blocked at all is the test, NOT which cause it is: a control that has
 * gone is no more pressable than one that never worked, and handing "Next" back
 * there would advance a tour whose step the user was never shown. The gate is
 * released by exactly one state — a control that is on screen and unusable —
 * which is `blockOn`'s to decide, so the gate and the explanation cannot come
 * apart. It costs the happy path nothing: an enabled control keeps its gate, so
 * the step still ignores "Next" for every user who can do the thing it asks.
 */
function isGatedStep(index: number): boolean {
  return blockOn(index) !== undefined;
}

/**
 * The input types a caret cannot live in. Everything else an `<input>` renders
 * is something the user types into — text, number, search, email and the rest —
 * and the two behaviours below treat "typed into" as one question with one
 * answer.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * A CONTROL THE USER TYPES IN — one predicate for two decisions that must not
 * come apart: which highlighted target the tour moves the caret into
 * (`focusStepTarget`), and which focused element's arrow keys belong to the
 * caret rather than the tour (`handleKeyup`). Deciding them separately is how
 * the tour could put focus somewhere and then fight the user for the keys.
 *
 * Buttons, radios, checkboxes and Radix's trigger buttons are deliberately NOT
 * here: focusing them invites Enter and arrow presses the step never asked for.
 */
function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.matches('[contenteditable="true"]');
}

/**
 * MOVE THE CARET WHERE THE TOUR IS POINTING — for a step highlighting a field
 * the user is being asked to type into, and for nothing else.
 *
 * The reported gap: the account set walks `#name`, then the selects, then
 * `#startingBalance`, and a user whose last click was the name field is still
 * typing THERE when the tour says "initial balance". The popover's copy moved;
 * the caret did not. So a text-entry target takes focus when highlighted, and a
 * prefilled value is selected so typing replaces it — "0" in a balance field
 * must not become "01000" for a user doing exactly what the step asked.
 *
 * Called from `handleHighlighted`, which is AFTER driver.js has rendered the
 * popover and focused its own first button — the only ordering that lets this
 * write win. driver.js's Tab trap already cycles between the popover and the
 * highlighted element, so focus starting in the field stays inside the trap.
 *
 * Skipped for a control that is disabled or gone — a caret in a dead field is
 * an instruction to type into something that will not take it.
 */
function focusStepTarget(index: number): void {
  const target = activeSteps[index]?.target;
  if (target === undefined) return;

  const element = document.querySelector(target);
  if (element === null || !isTextEntry(element)) return;
  if (element.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return;
  if (element === document.activeElement) return;

  (element as HTMLElement).focus();
  if (
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    element.value !== ''
  ) {
    element.select();
  }
}

/**
 * Classify the step the user left from, so the ending can be explained rather
 * than merely happening.
 *
 * Called from the three paths a user turns the tour down by — Escape, the close
 * button, the overlay — and from nowhere else. A PROGRAMMATIC `stop()` MUST NOT
 * RECORD ONE: `startTour` ends the previous tour through it and so does the
 * caller's own "end the walkthrough", and neither is the user failing to get
 * past anything. Reporting those would put an explanation on screen for a tour
 * the app itself took away, which is noise at exactly the moment the next one
 * is starting.
 */
function recordBlock(index: number): void {
  blocked = blockOn(index);
}

/**
 * THE WALKTHROUGH'S KEYBOARD CONTROLS ARE OURS, NOT DRIVER.JS'S, AND THAT IS A
 * BUG FIX.
 *
 * driver.js 1.8.0 guards its own arrow-key handlers on `__transitionCallback`
 * and drops the press when one is in flight — `return`, not queue. A transition
 * is in flight for the WHOLE of `duration` (400ms by default), and the incoming
 * step's title is swapped in halfway through it, so every press within ~400ms of
 * the last one is silently swallowed, and so is the very first press after the
 * tour opens, because the opening highlight is a transition too. Measured
 * against the real stack: two presses 0/150/250/350ms apart move ONE step; at
 * 450ms both land.
 *
 * That is an accessibility defect rather than a nicety, because the pointer path
 * has no such guard: "Next" advances on every click however fast they come, so a
 * keyboard user is the only user who loses input, and loses it silently. Escape
 * is unaffected — driver.js routes it straight to its close handler — but it is
 * handled here too, because `allowKeyboardControl` is one switch for all three
 * keys and half-owning them would leave two handlers racing for the arrows.
 *
 * Everything below routes through the SAME functions the popover's own buttons
 * do, so the two paths cannot drift: the gate is `isGatedStep`, advancing is
 * `advanceFromUser()`, and exiting is `stop()`. `keyup` rather than `keydown` matches
 * what driver.js listened for, so holding a key still moves one step rather than
 * racing through the set. THE ARROWS are filtered by event target, and only
 * the arrows: the engine itself moves focus into a text-entry target
 * (`focusStepTarget`), so a caret move in the very field a step asked the user
 * to fill must not double as tour navigation. Escape is not filtered — it ends
 * the tour from anywhere, exactly as before.
 */
function handleKeyup(event: KeyboardEvent): void {
  const running = instance;
  if (!running?.isActive()) return;

  if (event.key === 'Escape') {
    exitReason = 'dismissed';
    recordBlock(running.getActiveIndex() ?? -1);
    stop();
    return;
  }
  // Arrows in a field are the caret's, not the tour's — see the comment above.
  if (event.target instanceof Element && isTextEntry(event.target)) return;
  if (event.key === 'ArrowRight') {
    if (isGatedStep(running.getActiveIndex() ?? -1)) return;
    advanceFromUser();
    return;
  }
  // Never off the front of the set: driver.js's own left-arrow handler stops at
  // the first step, while `movePrevious()` there tears the tour down.
  if (event.key === 'ArrowLeft' && running.hasPreviousStep()) {
    // Going back leaves the step too, so its watch goes with it — the highlight
    // that re-arms is the one for the step being moved to.
    disarmStepWatch();
    running.movePrevious();
  }
}

/**
 * EXACTLY ONE CONTROL IS THE HIGHLIGHTED ONE — which driver.js 1.8.0 does not
 * guarantee, and the gap is a control the tour has walked away from that stays
 * live and outlined for the rest of the walkthrough.
 *
 * `driver-active-element` is what the lock turns on. `driver.css` takes
 * `pointer-events` off `.driver-active *` and hands them back to
 * `.driver-active .driver-active-element` and its descendants, and `tour.css`
 * draws the focus ring on the same selector. So the class is both "this is the
 * control the step is about" and "this is the one thing on the page you may
 * still press".
 *
 * driver.js decides which element to take it OFF by reading `__activeElement`,
 * and it only writes that value when a step's 400ms highlight transition runs to
 * completion — from a `requestAnimationFrame` loop that abandons itself the
 * moment a newer transition starts. So a step change that lands inside the
 * previous step's 400ms reads a stale `__activeElement`, strips the class from
 * an element that never had it, and leaves it on the one the abandoned
 * transition had just added it to. Nothing removes it again until the tour is
 * destroyed.
 *
 * Reproduced against the real stack: two "Next" presses in one tick leave the
 * middle step's control carrying the class, `pointer-events: auto` and the focus
 * ring, six steps after the tour moved off it — and a walkthrough opened onto a
 * busy page does the same to its FIRST control, because the opening highlight is
 * a transition too and the user's first press beats its commit. It shows up as a
 * ring on the wrong control, and it means a control the dimming says is locked
 * is not.
 *
 * Fixed here rather than upstream because this hook is the one moment we know a
 * new highlight is starting: driver.js calls it BEFORE it moves the class, so
 * clearing every stale copy leaves it to add the one that belongs, and the end
 * state is the same one it intended. `element` is skipped so a re-highlight of
 * the step already showing does not blink its own ring off and on.
 */
function releaseStaleHighlights(element: Element | undefined): void {
  for (const stale of document.querySelectorAll('.driver-active-element')) {
    if (stale === element) continue;
    stale.classList.remove('driver-active-element', 'driver-no-interaction');
    // driver.js sets these three alongside the class and takes them off the same
    // stale reference, so they are left behind by the same race: a control the
    // tour has left would keep announcing itself as the popover's trigger.
    stale.removeAttribute('aria-haspopup');
    stale.removeAttribute('aria-expanded');
    stale.removeAttribute('aria-controls');
  }
}

const handleHighlightStarted: DriverHook = (element, _driveStep, opts) => {
  // Before anything that can return: a step whose target went missing ends the
  // tour, and the control the PREVIOUS step highlighted must not outlive it.
  releaseStaleHighlights(element);

  const index = opts.index ?? -1;
  const step = activeSteps[index];
  if (!step) return;

  // driver.js passes `undefined` when it could not resolve the step's target and
  // fell back to its own hidden, centred placeholder. For a step that DECLARES a
  // target that means the `waitForElement` window expired, so end the tour
  // rather than float a popover over nothing or drift onto a neighbour.
  if (step.target !== undefined && element === undefined) {
    // The step we gave up on and why, kept for `onExit`: this is the ONLY moment
    // anyone knows which one it was. `onStepChange` is not called below, so the
    // caller's current step stays the one before this. The reason reported to
    // the caller is derived from this in `stop()` rather than set beside it —
    // one value, so the two cannot disagree.
    blocked = { cause: 'target-missing', step };
    // Deferred by a tick on purpose: driver.js writes its own step state
    // immediately AFTER calling this hook, so tearing down from inside it would
    // resurrect the tour we just destroyed.
    pendingStopTimer = window.setTimeout(stop, 0);
    return;
  }

  // Before the caller hears about the step, so a handler that reads the tour's
  // state finds the watch already in place.
  armStepWatch(index);
  activeHandlers.onStepChange?.(index, step);
};

/**
 * The popover EXISTS as of this hook, and not before it.
 *
 * `onHighlightStarted` runs ahead of the render, so the affordance sync armed
 * there has no popover to write to — the watch would pick it up a microtask
 * later when the node lands, but that leaves a frame in which "Next" is on
 * screen still looking pressable on a step that will not move. Syncing here
 * closes that window: driver.js has finished putting the popover up, so the
 * button is disabled and the instruction is present the first time either is
 * painted.
 *
 * The render this hook follows is also where driver.js focuses the popover's
 * own first button, which is why the caret move comes here and last: it is the
 * final write, so the field wins.
 */
const handleHighlighted: DriverHook = (_element, _driveStep, opts) => {
  const index = opts.index ?? -1;
  syncGateAffordance(index);
  focusStepTarget(index);
};

const handleNextClick: DriverHook = (_element, _driveStep, opts) => {
  // An action step advances on the action, never on "Next". The right-arrow key
  // is suppressed by the same gate in `handleKeyup`, which is why the test lives
  // in one function rather than in both callers.
  if (isGatedStep(opts.index ?? -1)) return;
  advanceFromUser();
};

/**
 * Advance because the USER asked to, rather than because the caller did.
 *
 * The difference is `onBeforeAdvance`: a caller that calls `advance()` has
 * already prepared for the move, while a "Next" press is the first anyone hears
 * of it — and the step after a press may live on a screen that has to be
 * navigated to before its target can ever resolve.
 */
function advanceFromUser(): void {
  const running = instance;
  if (!running?.isActive()) return;
  // Not on the last step: that press is "Done", and there is no next screen to
  // prepare. driver.js routes it to `onDoneClick`; the right-arrow key reaches
  // here, so the guard is needed either way.
  if (!running.isLastStep()) {
    activeHandlers.onBeforeAdvance?.(running.getActiveIndex() ?? -1);
  }
  advance();
}

const handleDoneClick: DriverHook = () => {
  exitReason = 'completed';
  stop();
};

const handleCloseClick: DriverHook = (_element, _driveStep, opts) => {
  exitReason = 'dismissed';
  recordBlock(opts.index ?? -1);
  stop();
};

/**
 * Configuring this hands teardown to us instead of letting driver.js do it, so
 * it is the one place that catches Escape, an overlay click and running off the
 * end alike. Routing them through `stop()` is what makes `onExit` fire exactly
 * once per tour, whatever ended it. `stop()` uses `destroy()`, which bypasses
 * this hook, so there is no loop.
 */
const handleDestroyStarted: DriverHook = (_element, _driveStep, opts) => {
  // The overlay click reaches here and nothing else the user does, so it is a
  // dismissal like the other two and is recorded the same way. `stop()`'s own
  // `destroy()` bypasses this hook, so a programmatic ending never lands here.
  recordBlock(opts.index ?? -1);
  stop();
};

/**
 * Start a tour. Any tour already running is ended first (its `onExit` fires
 * before the new one begins). Called with no steps, this is a no-op.
 */
export function startTour(steps: TourStep[], handlers: TourHandlers = {}): void {
  stop();
  if (steps.length === 0) return;

  activeSteps = steps;
  activeHandlers = handlers;
  exitReason = 'dismissed';
  blocked = undefined;

  instance = driver({
    steps: steps.map(toDriveStep),
    // The design system's reduced-motion gate. `tour.css` also disables the
    // transitions this option does not reach.
    animate: !prefersReducedMotion(),
    // Escapable in one action, by close button, overlay or Escape.
    allowClose: true,
    // OFF, so `handleKeyup` above is the only thing driving the tour from the
    // keyboard. Leaving it on would double-handle every arrow press that landed
    // outside driver.js's own transition guard, which is most of them.
    allowKeyboardControl: false,
    // The non-motion carrier of step state.
    showProgress: true,
    // The highlighted control stays usable.
    disableActiveInteraction: false,
    popoverClass: POPOVER_CLASS,
    onHighlightStarted: handleHighlightStarted,
    onHighlighted: handleHighlighted,
    onNextClick: handleNextClick,
    onDoneClick: handleDoneClick,
    onCloseClick: handleCloseClick,
    onDestroyStarted: handleDestroyStarted,
  });

  // After `drive()`, so a tour that failed to start leaves nothing bound.
  // `clearState()` removes it, which every ending goes through.
  instance.drive();
  window.addEventListener('keyup', handleKeyup);
}

/**
 * Move to the next step, or finish if this was the last one. This is what an
 * action step waits for: the caller calls it when the real event lands. A no-op
 * when no tour is running.
 */
export function advance(): void {
  if (!instance?.isActive()) return;
  // The step being left stops being waited for HERE rather than on the next
  // highlight: a step whose target has to be waited for is highlighted long
  // after the move, and the old watch would be live for all of it.
  disarmStepWatch();
  if (instance.isLastStep()) {
    exitReason = 'completed';
    stop();
    return;
  }
  instance.moveNext();
}

/**
 * End the tour and report why, exactly once. A no-op when none is running.
 *
 * `reason` is for an ending the tour itself cannot see: the caller knows the
 * session went away under it, and the tracked reason — set by whichever
 * driver.js hook last fired — would call that a dismissal. Left out, the
 * tracked reason stands, which is what every in-tour ending wants.
 */
export function stop(reason?: TourExitReason): void {
  const running = instance;
  if (!running) return;

  const handlers = activeHandlers;
  // A CALLER-NAMED ENDING CARRIES NO CLASSIFICATION. The tour did not stop
  // because the user was stuck on a step — the session went away under it, or
  // the app took it down — so there is nothing for the caller to explain and no
  // step to name. Forwarding one would put "you did not do this" on screen for a
  // user who was logged out mid-step.
  const block = reason === undefined ? blocked : undefined;
  // ONE VALUE ANSWERS BOTH QUESTIONS, WHICH IS WHY THE REASON IS DERIVED HERE
  // AND NOT TRACKED BESIDE THE CLASSIFICATION. A tour that stopped because the
  // control it was pointing at was not on screen ended on the missing target,
  // whichever way the user got out of it — reporting that as a dismissal is what
  // let the caller call an absent control a decision the user made. Read before
  // the teardown that clears it, like the caller's own step index.
  const ending = reason ?? (block?.cause === 'target-missing' ? 'target-missing' : exitReason);
  // Drop our state BEFORE tearing driver.js down: `instance` is null from here
  // on, so anything re-entering through a driver.js hook is a no-op rather than
  // a second exit.
  clearState();
  running.destroy();
  handlers.onExit?.(ending, block);
}

/** Whether a tour is currently running. */
export function isActive(): boolean {
  return instance?.isActive() ?? false;
}
