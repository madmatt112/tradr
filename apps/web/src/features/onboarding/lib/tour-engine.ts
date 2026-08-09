/**
 * The walkthrough's tour engine — a thin adapter over `driver.js`.
 *
 * This is the ONLY module in the codebase permitted to import `driver.js`
 * (design.md, "Modular Design Principles"). Everything a caller touches is
 * declared here: `TourStep`, `TourHandlers`, `TourExitReason`. No `driver.js`
 * type crosses the boundary, so swapping the library out is a change to this
 * file and nothing else.
 *
 * It also owns the ONE `import '../tour.css'` (R5.7, R11.3). That stylesheet
 * `@import`s the vendor CSS itself, so this module must not import
 * `driver.js/dist/driver.css` as well — doing so would put the vendor rules
 * after the token overrides and lose the cascade. Because the stylesheet is
 * reached only from here, and `useWalkthrough` reaches here only through a
 * dynamic import, neither the tour runtime nor its CSS lands in the dashboard
 * route's initial payload.
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
   * (R6.10) without this module knowing anything about documentation. Step copy
   * is author-written and lives in the repo; NEVER interpolate user input here.
   */
  description: string;
  side?: TourStepSide;
  align?: TourStepAlign;
  /**
   * How long to wait for `target` to appear, in ms, before giving up (R5.4).
   * Set it on any step whose target is created by the step before it — a dialog
   * opening, a route still navigating. Omitted means "must already be there";
   * on a miss the tour ends rather than pointing at nothing.
   */
  waitForMs?: number;
  /**
   * R5.5. When true, "Next" does NOT advance the tour: the caller calls
   * `advance()` when the real event lands. The highlighted control stays
   * interactive either way (`disableActiveInteraction: false`).
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
   * click, or Escape (R5.3). It means they did not want the tour, which is why
   * it does NOT cover a tour that ended because the session did: R8 exists to
   * find where users stop, and "declined the walkthrough" and "left the app"
   * are different answers to that question.
   */
  | 'dismissed'
  /** A step's target never appeared within its `waitForMs` (R5.4). */
  | 'target-missing'
  /**
   * The session ended under the tour — a logout, or an expiry — and took it
   * down with it. Not a judgement on the walkthrough: the user was still in it.
   */
  | 'session-ended';

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
  /** Fires exactly once per tour, however it ended. */
  onExit?: (reason: TourExitReason) => void;
}

let instance: Driver | null = null;
let activeSteps: TourStep[] = [];
let activeHandlers: TourHandlers = {};
let exitReason: TourExitReason = 'dismissed';
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
}

/**
 * Whether the control a step points at can be used at all right now.
 *
 * Read live rather than remembered from the highlight, because the answer
 * changes under the step: the control a user is being asked to press is often
 * disabled until they have done something else, and that something else may
 * happen while the popover is on screen.
 */
function isTargetUnusable(target: string | undefined): boolean {
  if (target === undefined) return false;
  const element = document.querySelector(target);
  // A target that is not there at all is `handleHighlightStarted`'s to deal
  // with — it ends the tour. Not knowing is not the same as knowing it is dead,
  // so the gate stands.
  if (element === null) return false;
  return element.matches(':disabled, [aria-disabled="true"], [data-disabled]');
}

/**
 * R5.5 — the one step state that decides whether "Next" (or its key) advances.
 *
 * A GATE THE USER CANNOT OPEN IS NOT A GATE, IT IS A TRAP. Suppressing "Next"
 * is only safe while the highlighted control is one the user can actually
 * press: the rest of the page is `pointer-events: none` under a running tour,
 * so a gated step whose control is disabled leaves Escape as the only way out —
 * and Escape ends the walkthrough rather than continuing it.
 *
 * The close set reaches exactly that state. "It closes itself" highlights Close
 * Position, which is disabled until the whole entered quantity has been exited
 * ("Exit the full quantity first"), and the step before it advances on any exit
 * fill — so a user who records a PARTIAL exit, which the step before explicitly
 * invites, arrives at a control they cannot press waiting for a `closed` event
 * that will not come. Releasing the gate here hands them "Next" instead, which
 * is what a step whose action is unavailable owes them.
 *
 * It costs the happy path nothing: an enabled control keeps its gate, so the
 * step still ignores "Next" for every user who can do the thing it asks.
 */
function isGatedStep(index: number): boolean {
  const step = activeSteps[index];
  if (step?.advanceOnAction !== true) return false;
  return !isTargetUnusable(step.target);
}

/**
 * THE WALKTHROUGH'S KEYBOARD CONTROLS ARE OURS, NOT DRIVER.JS'S, AND THAT IS A
 * BUG FIX (R5.9).
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

const handleHighlightStarted: DriverHook = (element, _driveStep, opts) => {
  const index = opts.index ?? -1;
  const step = activeSteps[index];
  if (!step) return;

  // driver.js passes `undefined` when it could not resolve the step's target and
  // fell back to its own hidden, centred placeholder. For a step that DECLARES a
  // target that means the `waitForElement` window expired, so end the tour
  // rather than float a popover over nothing or drift onto a neighbour (R5.4).
  if (step.target !== undefined && element === undefined) {
    exitReason = 'target-missing';
    // Deferred by a tick on purpose: driver.js writes its own step state
    // immediately AFTER calling this hook, so tearing down from inside it would
    // resurrect the tour we just destroyed.
    pendingStopTimer = window.setTimeout(stop, 0);
    return;
  }

  activeHandlers.onStepChange?.(index, step);
};

const handleNextClick: DriverHook = (_element, _driveStep, opts) => {
  // R5.5 — an action step advances on the action, never on "Next". The
  // right-arrow key is suppressed by the same gate in `handleKeyup`, which is
  // why the test lives in one function rather than in both callers.
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

const handleCloseClick: DriverHook = () => {
  exitReason = 'dismissed';
  stop();
};

/**
 * Configuring this hands teardown to us instead of letting driver.js do it, so
 * it is the one place that catches Escape, an overlay click and running off the
 * end alike. Routing them through `stop()` is what makes `onExit` fire exactly
 * once per tour, whatever ended it. `stop()` uses `destroy()`, which bypasses
 * this hook, so there is no loop.
 */
const handleDestroyStarted: DriverHook = () => {
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

  instance = driver({
    steps: steps.map(toDriveStep),
    // R5.9 — the design system's reduced-motion gate. `tour.css` also disables
    // the transitions this option does not reach.
    animate: !prefersReducedMotion(),
    // R5.3 — escapable in one action, by close button, overlay or Escape.
    allowClose: true,
    // OFF, so `handleKeyup` above is the only thing driving the tour from the
    // keyboard. Leaving it on would double-handle every arrow press that landed
    // outside driver.js's own transition guard, which is most of them.
    allowKeyboardControl: false,
    // The non-motion carrier of step state.
    showProgress: true,
    // R5.5 — the highlighted control stays usable.
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
 * action step waits for: the caller calls it when the real event lands (R5.5).
 * A no-op when no tour is running.
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
  const ending = reason ?? exitReason;
  // Drop our state BEFORE tearing driver.js down: `instance` is null from here
  // on, so anything re-entering through a driver.js hook is a no-op rather than
  // a second exit.
  clearState();
  running.destroy();
  handlers.onExit?.(ending);
}

/** Whether a tour is currently running. */
export function isActive(): boolean {
  return instance?.isActive() ?? false;
}
