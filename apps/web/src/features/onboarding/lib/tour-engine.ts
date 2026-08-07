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
   * taken would leave no way out but Escape.
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
  /** The user left — close button, overlay click, or Escape (R5.3). */
  | 'dismissed'
  /** A step's target never appeared within its `waitForMs` (R5.4). */
  | 'target-missing';

export interface TourHandlers {
  /** Fires as each step is highlighted, before any animation. */
  onStepChange?: (index: number, step: TourStep) => void;
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
  instance = null;
  activeSteps = [];
  activeHandlers = {};
  exitReason = 'dismissed';
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
  // R5.5 — an action step advances on the action, never on "Next". driver.js
  // routes both the button and the right-arrow key through here, so suppressing
  // it once covers both.
  if (activeSteps[opts.index ?? -1]?.advanceOnAction) return;
  advance();
};

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

  instance.drive();
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

/** End the tour and report why, exactly once. A no-op when none is running. */
export function stop(): void {
  const running = instance;
  if (!running) return;

  const handlers = activeHandlers;
  const reason = exitReason;
  // Drop our state BEFORE tearing driver.js down: `instance` is null from here
  // on, so anything re-entering through a driver.js hook is a no-op rather than
  // a second exit.
  clearState();
  running.destroy();
  handlers.onExit?.(reason);
}

/** Whether a tour is currently running. */
export function isActive(): boolean {
  return instance?.isActive() ?? false;
}
