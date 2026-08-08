// useWalkthrough — the guided walkthrough's whole behaviour (R5).
//
// It composes three things that were built separately and deliberately know
// nothing about each other: `lib/tour-engine.ts` (mechanics), `lib/steps/`
// (content), and `useOnboarding` (the user's real data). Everything below is
// the glue, and each rule it enforces is a requirement.
//
// THE RUNTIME IS LOADED DYNAMICALLY, AND THAT IS THE POINT (R5.7, R11.3). Both
// `lib/tour-engine` and `lib/steps` are reached ONLY through `import()` inside
// `run()` below — never a top-level import. `tour-engine` is the sole module
// that pulls in `driver.js` and `tour.css`, so a static edge from here would put
// the whole tour runtime into the dashboard route's initial chunk, which every
// returning user pays for and no returning user uses. Type-only imports are
// fine: they erase. This property is now enforced, not merely intended —
// `apps/web/scripts/check-bundle-size.mjs` fails the build if a driver.js marker
// appears in the entry chunk.
//
// THE SESSION IS MODULE-SCOPED, NOT COMPONENT-SCOPED (R5.6). A walkthrough
// crosses routes: the position set starts on `/positions` and finishes on
// `/positions/$positionId`, and the close set ends up back on `/dashboard`. The
// component that started it (`ZeroState`, on the dashboard) unmounts on the
// first of those navigations. If `isRunning`, the current step and the event
// subscription lived in component state they would all die there, mid-tour,
// while driver.js — whose own state is module-scoped — carried on painting an
// overlay nothing was driving. So the session lives in a store next to the
// engine's own module state, and the hook is a thin binding onto it. It is also
// what lets a component on a completely different route ask `isRunning` (the
// coach marks are suppressed while a walkthrough runs, R7.6).
//
// NOTHING AUTO-STARTS (R5.2). Mounting this hook has no effect whatsoever;
// `start()` is a user action, called from the zero-state's "Walk me through it"
// and the checklist's per-item buttons. There is no effect that reads the stored
// status and begins a tour, and there must never be one.
//
// RESUME IS JUST `start()` WITH NO ARGUMENT (R5.6). After a reload there is no
// step index to restore because none was ever stored — `nextIncompleteItem()`
// re-derives the set from the checklist, which is itself derived from the user's
// accounts and positions (R4.2). A user who reloads after creating their account
// resumes at the calculator set because their data says the account step is
// done, not because we wrote that down. Storing an index would be a second
// source of truth that could disagree with the first, and the first is the one
// that is right.
//
// EXITING DISCARDS NOTHING (R5.3), and it is structural rather than careful:
// this module never writes onboarding state at all. The opt-in record
// (`status: 'active'`) is the caller's, written when the user chooses to be
// guided; completion is derived. So there is nothing an exit — by the close
// button, Escape, an unresolvable target or a failed chunk load — could roll
// back. The checklist after a walkthrough is the same checklist as before it,
// plus whatever the user actually did.

import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';

import { eventBus } from '@/stores/event-bus.store';
import type { EventName } from '@/stores/events.types';

import { emitOnboardingEvent } from '../lib/analytics';
import type { ChecklistItemId, Checklist } from '../lib/derive-checklist';
import type { WalkthroughStep } from '../lib/steps';

import { useOnboarding } from './useOnboarding';

type TourEngineModule = typeof import('../lib/tour-engine');
type StepsModule = typeof import('../lib/steps');

/**
 * The real event that completes an action step, keyed by the step's target
 * selector (R5.5).
 *
 * KEYED BY TARGET, NOT BY INDEX, on purpose. The selectors are the step data's
 * own stable identity — `steps.test.ts` already fails if one is renamed or stops
 * matching anything the app renders — whereas an index would silently point at
 * the wrong step the first time a set gains a paragraph. `[data-tour=
 * "position-add-fill"]` appears in two sets and means the same thing in both,
 * which is exactly the behaviour keying by target gives for free.
 *
 * A step marked `advanceOnAction` whose action is NOT in here is handled by
 * `withObservableActionsOnly()` below — see the note there.
 */
export const ACTION_SIGNALS: Readonly<Record<string, { event: EventName; reason: string }>> = {
  '[data-tour="account-submit"]': { event: 'accounts:cache-invalidate', reason: 'created' },
  '#symbol': { event: 'positions:cache-invalidate', reason: 'created' },
  '[data-tour="position-add-fill"]': { event: 'positions:cache-invalidate', reason: 'fill-added' },
  '[data-tour="position-open"]': { event: 'positions:cache-invalidate', reason: 'opened' },
  '[data-tour="position-close"]': { event: 'positions:cache-invalidate', reason: 'closed' },
};

interface WalkthroughStoreState {
  isRunning: boolean;
  /** The runtime failed to load and this session gave up on it (R5.8). */
  isUnavailable: boolean;
  /** Which checklist item's set is running, or `null`. */
  itemId: ChecklistItemId | null;
  currentStep: WalkthroughStep | null;
  stepIndex: number;
}

const IDLE: Omit<WalkthroughStoreState, 'isUnavailable'> = {
  isRunning: false,
  itemId: null,
  currentStep: null,
  stepIndex: -1,
};

/**
 * Session state, module-scoped for the reason given at the top of the file.
 * Exported for tests only — components go through `useWalkthrough()`.
 */
export const useWalkthroughStore = create<WalkthroughStoreState>(() => ({
  ...IDLE,
  isUnavailable: false,
}));

// The rest of the session: the steps being driven and the event subscriptions
// driving them. Plain module variables rather than store fields — nothing
// renders from them, and putting them in the store would re-render every
// consumer for a change no consumer can see.
let activeSteps: WalkthroughStep[] = [];
let unsubscribers: (() => void)[] = [];
let enginePromise: Promise<[TourEngineModule, StepsModule]> | null = null;

function endSession(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  activeSteps = [];
  useWalkthroughStore.setState(IDLE);
}

/**
 * Logging out ends the walkthrough, overlay and all.
 *
 * The session is module-scoped for the reason at the top of this file, which
 * means `queryClient.clear()` in `useAuth` does not touch it: without this the
 * next user to log in on the same tab would inherit the last one's tour. We
 * listen for `auth:logout` on the event bus rather than exporting something for
 * `useAuth` to call, so auth keeps knowing nothing about onboarding.
 *
 * Subscribed at MODULE scope, not from the hook: a walkthrough deliberately
 * outlives the component that started it, so the teardown has to outlive it too
 * — and a stale `isUnavailable` belongs to the departing session even when no
 * tour is running. The bus stores handlers in a `Set`, so re-arming is a no-op.
 */
function teardownOnLogout(): void {
  // THE ENGINE GOES DOWN BEFORE THE SESSION DOES, AND THE ORDER IS THE POINT
  // (R8.1). `engine.stop()` fires `onExit`, and `onExit` builds the abandonment
  // event out of the LIVE session — the step the user was on, and the size of
  // the set it was a step of. Clearing the session first would hand the funnel
  // `stepIndex: -1` in a tour of `stepCount: 0` for every user who ever logs
  // out mid-walkthrough: "abandoned at no step, of nothing", which is precisely
  // the measurement Requirement 8 exists to produce.
  //
  // A session ending IS a place a user stopped, so it is reported rather than
  // suppressed — under `session-ended`, its own reason. It used to arrive as
  // `dismissed`, which also means "the user turned the walkthrough down", and
  // R8 exists to find where users stop: a funnel that cannot tell someone who
  // declined the tour from someone whose session went away under them has
  // blurred the one thing it was built to see.
  //
  // `onExit` runs `endSession()` itself, so the teardown below is for the tour
  // that was NOT running: a session whose runtime never loaded, and a stale
  // `isUnavailable` belonging to the departing user. The engine is only
  // reachable once its chunk has loaded, and a tour can only be running if it
  // has, so the deferred branch is also the only one that can have a tour.
  if (enginePromise) {
    void enginePromise
      .then(([engine]) => engine.stop('session-ended'))
      .catch(() => {})
      .finally(finishLogoutTeardown);
    return;
  }
  finishLogoutTeardown();
}

function finishLogoutTeardown(): void {
  endSession();
  useWalkthroughStore.setState({ ...IDLE, isUnavailable: false });
}

function armLogoutTeardown(): void {
  eventBus.subscribe('auth:logout', teardownOnLogout);
}

armLogoutTeardown();

/**
 * Load the tour runtime and the step content, together and lazily.
 *
 * R5.8 / Principle 4: a rejection here is an ordinary outcome, not an
 * exception. The chunk can 404 after a deploy, be blocked, or simply be
 * unreachable offline. We mark the walkthrough unavailable, leave the stored
 * onboarding status ALONE — the user has not skipped anything and must not be
 * recorded as having done so — and return `null`. The zero-state and checklist
 * are untouched by all of this and keep working, which is the whole point: the
 * unguided path is the fallback, and it is the same path everyone else uses.
 *
 * The promise is cached on success and dropped on failure, so a later retry
 * genuinely retries rather than re-awaiting the rejection.
 */
async function loadRuntime(): Promise<[TourEngineModule, StepsModule] | null> {
  try {
    enginePromise ??= Promise.all([import('../lib/tour-engine'), import('../lib/steps')]);
    return await enginePromise;
  } catch (err) {
    enginePromise = null;
    console.error('[onboarding] the guided walkthrough could not be loaded', err);
    useWalkthroughStore.setState({ ...IDLE, isUnavailable: true });
    return null;
  }
}

/**
 * Subscribe to the events that advance this session's action steps.
 *
 * The current step decides: an event only advances the tour when the step on
 * screen is an action step AND the event is the one that step's action produces.
 * Every other event on the bus — a position updated elsewhere, a fill deleted —
 * passes through without touching the tour.
 */
function bindAdvance(engine: TourEngineModule): void {
  const advanceOn = (event: EventName) => (payload: { reason: string }) => {
    const step = useWalkthroughStore.getState().currentStep;
    if (!step?.advanceOnAction || step.target === undefined) return;
    const signal = ACTION_SIGNALS[step.target];
    if (signal?.event !== event || signal.reason !== payload.reason) return;
    engine.advance();
  };

  unsubscribers = [
    eventBus.subscribe('positions:cache-invalidate', advanceOn('positions:cache-invalidate')),
    eventBus.subscribe('accounts:cache-invalidate', advanceOn('accounts:cache-invalidate')),
  ];
}

/**
 * Hand the engine the steps it should gate on an action, and only those.
 *
 * A step marked `advanceOnAction` does not advance on "Next" — the engine
 * suppresses it — so a step whose action produces no event we can observe would
 * strand the user with a live tour and no way forward but Escape. Four of the
 * authored action steps are like that: their "action" is a pure UI gesture
 * (opening the account dialog, opening the new-position dialog, choosing the
 * Percent risk basis, picking an account in the calculator) which changes no
 * server data and publishes nothing.
 *
 * For those, the flag is turned off and "Next" advances normally. The highlighted
 * control stays interactive either way (`disableActiveInteraction: false`), so
 * the user still performs the gesture; they just also press Next afterwards, and
 * the following step's `waitForMs` covers a dialog that is still opening. That
 * is a narrower reading of R5.5 than those four steps were authored for, and it
 * is the honest one until a gesture has an event to advance on — being asked to
 * press Next is a worse tour, but a tour that cannot be advanced at all is a
 * broken one.
 */
function withObservableActionsOnly(steps: WalkthroughStep[]): WalkthroughStep[] {
  return steps.map((step) => {
    if (!step.advanceOnAction) return step;
    if (step.target !== undefined && step.target in ACTION_SIGNALS) return step;
    return { ...step, advanceOnAction: false };
  });
}

/** The first item the user has not done — the set to run, and the resume point (R5.6). */
export function nextIncompleteItem(
  checklist: Checklist | null | undefined,
): ChecklistItemId | null {
  return checklist?.items.find((item) => !item.done)?.id ?? null;
}

type NavigateFn = (opts: { to: string; params?: Record<string, string> }) => unknown;

/**
 * Put the user on the screen the set starts on, before the tour starts, so the
 * first step's `waitForMs` covers the route mounting rather than a navigation
 * that has not been asked for yet.
 *
 * A parameterised route (`/positions/$positionId`) needs values only the caller
 * has — the id of the position the user just created — so it navigates only when
 * they were supplied. Without them we start where the user already is, which is
 * right when they got here from that very position's page and degrades to a
 * clean `target-missing` exit when they did not.
 */
function navigateToStart(
  step: WalkthroughStep,
  params: Record<string, string> | undefined,
  navigate: NavigateFn,
): void {
  const needed = step.routeParams ?? [];
  if (needed.some((name) => params?.[name] === undefined)) return;
  navigate(needed.length > 0 ? { to: step.route, params } : { to: step.route });
}

async function run(
  itemId: ChecklistItemId,
  params: Record<string, string> | undefined,
  navigate: NavigateFn,
): Promise<void> {
  const runtime = await loadRuntime();
  if (!runtime) return;
  const [engine, steps] = runtime;

  const set = steps.WALKTHROUGH_STEPS[itemId];
  if (!set || set.length === 0) return;

  // Any session already running ends HERE, before anything new is set up.
  // `startTour` ends the previous tour itself, but it does so from inside the
  // new start — and the old session's `onExit` would then run `endSession()`
  // over the session we had just built, unsubscribing it. Ending first means
  // that teardown lands on the old session, which is whose it is.
  engine.stop();
  endSession();

  activeSteps = withObservableActionsOnly(set);
  bindAdvance(engine);
  navigateToStart(activeSteps[0], params, navigate);

  useWalkthroughStore.setState({
    isRunning: true,
    isUnavailable: false,
    itemId,
    currentStep: null,
    stepIndex: -1,
  });

  // Emitted here rather than from `start()`: this is the first line at which a
  // tour genuinely begins. A runtime that would not load, or a set with no
  // steps, has already returned above, so "started" never counts a walkthrough
  // the user did not get.
  emitOnboardingEvent({
    name: 'onboarding_walkthrough_started',
    item: itemId,
    stepCount: activeSteps.length,
  });

  engine.startTour(activeSteps, {
    onStepChange: (index) => {
      useWalkthroughStore.setState({ stepIndex: index, currentStep: activeSteps[index] ?? null });
    },
    // Every ending arrives here — completed, dismissed, or a target that never
    // appeared — and all three do the same thing to the user's data, because
    // none of them has any work to undo (R5.3). They are told apart only for the
    // funnel.
    onExit: (reason) => {
      // THE STEP INDEX COMES FROM THE LIVE SESSION, AND IS READ BEFORE THE
      // TEARDOWN THAT CLEARS IT (R8.1). Nothing stores a step index — resume
      // re-derives its position from the checklist instead (R5.6), and adding a
      // stored one for the sake of an event would be a second source of truth
      // that could disagree with the first. The running session already tracks
      // where the tour is, because the overlay has to be somewhere; the
      // abandonment event is just that number, taken on the way out. It is `-1`
      // when no step was ever highlighted.
      const { stepIndex } = useWalkthroughStore.getState();
      const stepCount = activeSteps.length;
      endSession();

      if (reason === 'completed') {
        emitOnboardingEvent({ name: 'onboarding_walkthrough_completed', item: itemId, stepCount });
        return;
      }
      emitOnboardingEvent({
        name: 'onboarding_walkthrough_abandoned',
        item: itemId,
        stepIndex,
        stepCount,
        reason,
      });
    },
  });
}

export interface UseWalkthroughResult {
  /**
   * Start a walkthrough. With no argument it runs the set for the first
   * incomplete checklist item, which is both "start me at the beginning" and
   * "resume where I was" (R5.6) — the two are the same question asked of the
   * same data. `params` supplies the values a parameterised route needs.
   *
   * Never throws, and never rejects: a runtime that will not load leaves
   * `isUnavailable` true and everything else exactly as it was (R5.8).
   */
  start: (itemId?: ChecklistItemId, params?: Record<string, string>) => void;
  /** End the running walkthrough. A no-op when none is running. */
  stop: () => void;
  isRunning: boolean;
  /** The tour runtime failed to load; offer the unguided path instead (R5.8). */
  isUnavailable: boolean;
  /** Which set is running, or `null`. */
  itemId: ChecklistItemId | null;
  currentStep: WalkthroughStep | null;
  /** Zero-based index into the running set; `-1` between steps and when idle. */
  stepIndex: number;
}

/**
 * Just the R7.6 signal: is a walkthrough on screen right now?
 *
 * A separate hook rather than `useWalkthrough().isRunning` because the full
 * hook composes `useOnboarding()` — which pulls the entire unfiltered positions
 * list down to count it — and the coach marks that ask this question sit on
 * ordinary working surfaces that have no use for a checklist. Reading one
 * boolean should not cost a request.
 *
 * Synchronous, from the module-scoped store, so a consumer can decide not to
 * render AT ALL on the same tick. A mark that mounts and then withdraws in an
 * effect still paints a frame over the highlight the tour is pointing at.
 */
export function useIsWalkthroughRunning(): boolean {
  return useWalkthroughStore((state) => state.isRunning);
}

export function useWalkthrough(): UseWalkthroughResult {
  const navigate = useNavigate();
  const { checklist } = useOnboarding();
  const state = useWalkthroughStore();

  // R8.1's "offered": there is a walkthrough behind the button and the user
  // could press it. Mounting this hook IS the offer — `ZeroState` is the only
  // thing that mounts it, and it does so precisely to put "Walk me through it"
  // and the checklist's per-item "Start" on screen — so the condition here is
  // the same one `ZeroState` disables its control on: a runtime that will load,
  // and a checklist naming an outstanding item.
  //
  // This does not weaken R5.2. Nothing below starts anything; it counts an
  // opportunity that was on screen either way, and the tour still only ever
  // begins from a click.
  //
  // The ref makes it the OFFER that is counted rather than the render. Emitting
  // on every render would report a few dozen offers per screen, and emitting
  // once per mount would miss the genuinely new offer a user is given when they
  // finish one item and the next becomes outstanding under them.
  const offeredItem = state.isUnavailable ? null : nextIncompleteItem(checklist);
  const lastOffered = useRef<ChecklistItemId | null>(null);
  useEffect(() => {
    if (offeredItem === null || offeredItem === lastOffered.current) return;
    lastOffered.current = offeredItem;
    emitOnboardingEvent({ name: 'onboarding_walkthrough_offered', item: offeredItem });
  }, [offeredItem]);

  const start = useCallback(
    (itemId?: ChecklistItemId, params?: Record<string, string>) => {
      const target = itemId ?? nextIncompleteItem(checklist);
      // Nothing to guide: the checklist has not loaded, this user has none, or
      // every item is already done. Silence is right — there is no failure here
      // to report.
      if (!target) return;
      void run(target, params, navigate as NavigateFn);
    },
    [checklist, navigate],
  );

  const stop = useCallback(() => {
    // The engine is only reachable once it has loaded, and it can only be
    // running if it has. `endSession()` covers the case where it never did.
    if (!enginePromise) {
      endSession();
      return;
    }
    void enginePromise.then(([engine]) => engine.stop()).catch(() => endSession());
  }, []);

  return {
    start,
    stop,
    isRunning: state.isRunning,
    isUnavailable: state.isUnavailable,
    itemId: state.itemId,
    currentStep: state.currentStep,
    stepIndex: state.stepIndex,
  };
}

/** Test seam: drop the module-scoped session and the cached runtime import. */
export function __resetWalkthroughForTests(): void {
  endSession();
  enginePromise = null;
  useWalkthroughStore.setState({ ...IDLE, isUnavailable: false });
  // Restore the module's import-time state in full: a test that clears the
  // event bus has taken the logout listener with it.
  armLogoutTeardown();
}
