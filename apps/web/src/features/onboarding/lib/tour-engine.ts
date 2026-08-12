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
   * other. Four are, today — `[data-testid="zero-state-create-account"]`,
   * `[data-tour="calculator-risk"]`, `[data-tour="calculator-account"]` and
   * `[data-tour="position-new"]` — because each asks for a pure UI gesture that
   * changes no server data. `hooks/useWalkthrough.ts` owns both the mapping and
   * the downgrade, and a test there fails if a fifth step joins them unnoticed.
   */
  advanceOnAction?: boolean;
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

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function toDriveStep(step: TourStep): DriveStep {
  return {
    element: step.target,
    waitForElement: step.waitForMs,
    popover: {
      title: step.title,
      description: step.description,
      side: step.side,
      align: step.align,
    },
  };
}

function clearState(): void {
  if (pendingStopTimer !== undefined) {
    window.clearTimeout(pendingStopTimer);
    pendingStopTimer = undefined;
  }
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
 * A step with no `advanceOnAction` is never blocking: "Next" moves it, so
 * whatever the user did, they had a way on.
 */
function blockOn(index: number): TourBlock | undefined {
  const step = activeSteps[index];
  if (step?.advanceOnAction !== true) return undefined;
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
 * racing through the set. Nothing filters by event target, also as before: the
 * highlighted control is interactive (`disableActiveInteraction: false`) and a
 * user typing in it was already moving the tour with the arrow keys.
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
  if (event.key === 'ArrowRight') {
    if (isGatedStep(running.getActiveIndex() ?? -1)) return;
    advanceFromUser();
    return;
  }
  // Never off the front of the set: driver.js's own left-arrow handler stops at
  // the first step, while `movePrevious()` there tears the tour down.
  if (event.key === 'ArrowLeft' && running.hasPreviousStep()) {
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

  activeHandlers.onStepChange?.(index, step);
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
