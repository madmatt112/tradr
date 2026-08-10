// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventBus } from '@/stores/event-bus.store';

import type { Checklist, ChecklistItemId } from '../lib/derive-checklist';
import { WALKTHROUGH_STEPS, type WalkthroughStep } from '../lib/steps';
import type { TourExitReason, TourHandlers, TourStep } from '../lib/tour-engine';

import {
  ACTION_SIGNALS,
  useWalkthrough,
  useWalkthroughStore,
  __resetWalkthroughForTests,
} from './useWalkthrough';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- doubles ----------------------------------------------------------------

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

// `useOnboarding` has its own 22 tests. What matters here is only what the
// checklist SAYS, so it is supplied directly — that keeps these tests about the
// walkthrough rather than about three composed queries.
let checklist: Checklist | null | undefined;
const setStatus = vi.fn();
const dismiss = vi.fn();
vi.mock('./useOnboarding', () => ({
  useOnboarding: () => ({ checklist, setStatus, dismiss }),
}));

// The positions list, supplied directly for the same reason. The walkthrough
// reads it for exactly one thing — which position the close set opens on — and
// the real hook would need a QueryClient and a fetch to say so.
let positions: { id: string; status: string }[] | undefined;
vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: () => ({ data: positions }),
}));

// The accounts list, supplied directly for the same reason again. The
// walkthrough reads it for one thing only — whether the screens two of the sets
// open on are the ones the user is actually looking at.
let accounts: { id: string }[] | undefined;
vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accounts }),
}));

// `lib/analytics` is the REAL module here — only the vendor-facing capture is a
// double. The interesting claims are about which events the walkthrough sends
// and when, and stubbing the analytics module would assert nothing but that the
// hook calls the function it plainly calls.
const captureClientEvent = vi.fn();
vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: (...args: unknown[]) => captureClientEvent(...args),
}));

let started: { steps: TourStep[]; handlers: TourHandlers } | null = null;
const engine = {
  startTour: vi.fn((steps: TourStep[], handlers: TourHandlers = {}) => {
    started = { steps, handlers };
    handlers.onStepChange?.(0, steps[0]);
  }),
  advance: vi.fn(),
  // FAITHFUL TO `lib/tour-engine.stop()`, DELIBERATELY. The real one fires
  // `onExit` exactly once for the tour it tears down, passing the caller's
  // reason when it was given one and the tracked reason otherwise, and no tour
  // at all is a no-op. A double that merely records the call cannot see an
  // ordering bug between the teardown and the exit handler that reads the live
  // session — and that is exactly the bug the logout path had.
  stop: vi.fn((reason?: TourExitReason) => {
    const session = started;
    if (!session) return;
    started = null;
    // 'dismissed' stands in for the tracked reason: with no driver.js here, an
    // ending nobody named is the one the real engine starts every tour with.
    session.handlers.onExit?.(reason ?? 'dismissed');
  }),
  isActive: vi.fn(() => started !== null),
};
vi.mock('../lib/tour-engine', () => engine);

// --- helpers ----------------------------------------------------------------

function aChecklist(...done: ChecklistItemId[]): Checklist {
  const ids: ChecklistItemId[] = ['account', 'calculator', 'position', 'close'];
  const items = ids.map((id) => ({ id, label: id, done: done.includes(id) }));
  return { items, allComplete: items.every((i) => i.done) };
}

/** Start a walkthrough and wait for the lazy runtime import to settle. */
async function start(itemId?: ChecklistItemId, params?: Record<string, string>) {
  const { result } = renderHook(() => useWalkthrough());
  await act(async () => {
    result.current.start(itemId, params);
  });
  return result;
}

/** Drop the module-scoped session, wrapped so React sees the store change. */
function resetSession() {
  act(() => {
    __resetWalkthroughForTests();
  });
}

/** Drive the engine's step-change callback, as driver.js would. */
function highlight(index: number) {
  act(() => {
    started?.handlers.onStepChange?.(index, started.steps[index]);
  });
}

function currentTargets(): (string | undefined)[] {
  return (started?.steps ?? []).map((s) => s.target);
}

function gatedTargets(): (string | undefined)[] {
  return (started?.steps ?? []).filter((s) => s.advanceOnAction).map((s) => s.target);
}

/** The property bags captured under one event name, in order. */
function eventsNamed(name: string): Record<string, unknown>[] {
  return captureClientEvent.mock.calls
    .filter(([sent]) => sent === name)
    .map(([, properties]) => properties as Record<string, unknown>);
}

beforeEach(() => {
  checklist = aChecklist();
  positions = [];
  accounts = [];
  started = null;
});

afterEach(() => {
  // Unmount first: the store is module-scoped, so a hook still mounted from an
  // earlier test would re-render on the reset below — outside `act`, and
  // attributed to whichever test came next.
  cleanup();
  // Bus before session, in that order: `__resetWalkthroughForTests` re-arms the
  // module's import-time `auth:logout` listener, and clearing the bus after
  // would take it straight back off again.
  eventBus.__resetForTests();
  resetSession();
  vi.clearAllMocks();
});

// --- opt-in -----------------------------------------------------------------

describe('useWalkthrough — opt-in only', () => {
  it('mounting starts nothing and navigates nowhere', async () => {
    const { result } = renderHook(() => useWalkthrough());

    // Give any stray effect a chance to fire before asserting it did not.
    await act(async () => {});

    expect(engine.startTour).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);
    expect(result.current.currentStep).toBeNull();
  });

  it('does nothing when the checklist has not loaded yet', async () => {
    checklist = undefined;
    await start();
    expect(engine.startTour).not.toHaveBeenCalled();
  });

  it('does nothing when every item is already done', async () => {
    checklist = aChecklist('account', 'calculator', 'position', 'close');
    await start();
    expect(engine.startTour).not.toHaveBeenCalled();
  });
});

// --- lifecycle --------------------------------------------------------------

describe('useWalkthrough — start and exit', () => {
  it('runs the named set and reports the step it is on', async () => {
    const result = await start('account');

    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());
    expect(currentTargets()).toEqual(WALKTHROUGH_STEPS.account.map((s) => s.target));
    expect(result.current.isRunning).toBe(true);
    expect(result.current.itemId).toBe('account');
    expect(result.current.stepIndex).toBe(0);
    expect(result.current.currentStep?.title).toBe(WALKTHROUGH_STEPS.account[0].title);

    highlight(3);
    expect(result.current.stepIndex).toBe(3);
    expect(result.current.currentStep?.title).toBe(WALKTHROUGH_STEPS.account[3].title);
  });

  it('navigates to the screen the set starts on before the tour starts', async () => {
    await start('calculator');

    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledWith({ to: '/calculator' });
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(
      engine.startTour.mock.invocationCallOrder[0],
    );
  });

  it('navigates a parameterised route only when the caller supplies the values', async () => {
    await start('close');
    expect(navigate).not.toHaveBeenCalled();

    resetSession();
    await start('close', { positionId: 'pos-1' });

    expect(navigate).toHaveBeenCalledWith({
      to: '/positions/$positionId',
      params: { positionId: 'pos-1' },
    });
  });

  // The checklist's "Start" can only name the SET — it knows item 4 is
  // outstanding, never which row that is about — so a set that opens on a
  // position has to find one, or it opens wherever the user happens to be and
  // exits `target-missing`.
  it('opens a set that needs a position on the one the user still has open', async () => {
    positions = [
      { id: 'pos-closed', status: 'closed' },
      { id: 'pos-open', status: 'open' },
    ];
    await start('close');

    expect(navigate).toHaveBeenCalledWith({
      to: '/positions/$positionId',
      params: { positionId: 'pos-open' },
    });
  });

  it('prefers the caller`s own position over the one it would have found', async () => {
    positions = [{ id: 'pos-open', status: 'open' }];
    await start('close', { positionId: 'pos-asked-for' });

    expect(navigate).toHaveBeenCalledWith({
      to: '/positions/$positionId',
      params: { positionId: 'pos-asked-for' },
    });
  });

  it('going idle on exit, however the tour ended, writes no onboarding state', async () => {
    const result = await start('account');
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    act(() => {
      started?.handlers.onExit?.('dismissed');
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.currentStep).toBeNull();
    expect(result.current.itemId).toBeNull();
    // Nothing about the user's onboarding record moved — there is nothing an
    // exit could discard, because this hook never writes any of it.
    expect(setStatus).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('stop() ends the running tour', async () => {
    const result = await start('account');

    await act(async () => {
      result.current.stop();
    });

    expect(engine.stop).toHaveBeenCalled();
  });

  it('ends a session already running before it builds the next one', async () => {
    const result = await start('account');
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    await act(async () => {
      result.current.start('position');
    });

    await waitFor(() => expect(result.current.itemId).toBe('position'));
    expect(result.current.isRunning).toBe(true);
    expect(engine.startTour).toHaveBeenCalledTimes(2);
  });
});

// --- resume -----------------------------------------------------------------

describe('useWalkthrough — resume', () => {
  it('re-derives the set from the checklist rather than a stored step', async () => {
    checklist = aChecklist('account');
    await start();

    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());
    expect(useWalkthroughStore.getState().itemId).toBe('calculator');
  });

  it('after a reload it resumes from the same data, having stored nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    checklist = aChecklist('account', 'calculator');

    const result = await start();
    await waitFor(() => expect(result.current.itemId).toBe('position'));
    highlight(3);
    expect(result.current.stepIndex).toBe(3);

    // The reload: every scrap of in-memory session state goes away.
    resetSession();
    expect(useWalkthroughStore.getState().isRunning).toBe(false);

    const resumed = await start();
    await waitFor(() => expect(resumed.current.itemId).toBe('position'));
    // Back at the top of the same set — no index survived, because none was kept.
    expect(resumed.current.stepIndex).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('moves on to the next set once the user has done the current one', async () => {
    checklist = aChecklist('account', 'calculator', 'position');
    const result = await start();

    await waitFor(() => expect(result.current.itemId).toBe('close'));
  });
});

// --- which sets can start from here -----------------------------------------
//
// A set whose first step targets a control that is not on screen exits
// `target-missing` in silence, which is a button that did nothing. `canStart` is
// what stops the checklist offering one, so these are about the four answers it
// gives rather than about anything the engine does.

describe('useWalkthrough — canStart', () => {
  function canStartAll(): Record<ChecklistItemId, boolean> {
    const { result } = renderHook(() => useWalkthrough());
    const ids: ChecklistItemId[] = ['account', 'calculator', 'position', 'close'];
    return Object.fromEntries(ids.map((id) => [id, result.current.canStart(id)])) as Record<
      ChecklistItemId,
      boolean
    >;
  }

  it('offers the account set only while the zero-state is the screen the user is on', () => {
    accounts = [];
    expect(canStartAll().account).toBe(true);

    // One account — of any kind, sample data included — and the dashboard shows
    // the grid instead, so the button that set opens on is gone.
    accounts = [{ id: 'acct-1' }];
    expect(canStartAll().account).toBe(false);
  });

  it('offers the position set only once an account exists to book against', () => {
    accounts = [];
    expect(canStartAll().position).toBe(false);

    accounts = [{ id: 'acct-1' }];
    expect(canStartAll().position).toBe(true);
  });

  it('offers the close set only when there is an open position to open it on', () => {
    positions = [{ id: 'pos-1', status: 'closed' }];
    expect(canStartAll().close).toBe(false);

    positions = [{ id: 'pos-1', status: 'open' }];
    expect(canStartAll().close).toBe(true);
  });

  it('always offers the calculator set, which needs nothing of the user', () => {
    accounts = [];
    positions = [];
    expect(canStartAll().calculator).toBe(true);
  });

  it('offers nothing that depends on an account count it does not have', () => {
    accounts = undefined;
    const answers = canStartAll();
    expect(answers.account).toBe(false);
    expect(answers.position).toBe(false);
  });

  // Completion is about the user's progress; `canStart` is about whether the
  // screen the set opens on is there. A user who has logged a position can ask
  // to be shown the calculator again.
  it('is about the set, not about whether the item is ticked', () => {
    checklist = aChecklist('account', 'calculator', 'position');
    accounts = [{ id: 'acct-1' }];
    const answers = canStartAll();
    expect(answers.calculator).toBe(true);
    expect(answers.position).toBe(true);
  });
});

// --- advance on the real action ---------------------------------------------

describe('useWalkthrough — action-driven advance', () => {
  it('advances the "create the account" step when the account is created', async () => {
    await start('account');
    const index = WALKTHROUGH_STEPS.account.findIndex(
      (s) => s.target === '[data-tour="account-submit"]',
    );
    highlight(index);

    act(() => {
      eventBus.publish('accounts:cache-invalidate', { reason: 'created' });
    });

    expect(engine.advance).toHaveBeenCalledOnce();
  });

  it('advances the symbol step when the position is created, and not before', async () => {
    await start('position');
    const index = WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol');
    highlight(index);

    act(() => {
      // The wrong reason on the right event is still the wrong event.
      eventBus.publish('positions:cache-invalidate', { reason: 'updated' });
    });
    expect(engine.advance).not.toHaveBeenCalled();

    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    });
    expect(engine.advance).toHaveBeenCalledOnce();
  });

  it('advances the fill, open and close steps on their own events', async () => {
    await start('close');
    const closeSet = WALKTHROUGH_STEPS.close;

    highlight(closeSet.findIndex((s) => s.target === '[data-tour="position-add-fill"]'));
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'fill-added' });
    });
    expect(engine.advance).toHaveBeenCalledTimes(1);

    highlight(closeSet.findIndex((s) => s.target === '[data-tour="position-close"]'));
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'closed' });
    });
    expect(engine.advance).toHaveBeenCalledTimes(2);
  });

  // The close set ends on the dashboard, and nothing else can put the user
  // there: the overlay is up, so the sidebar is not theirs to click. The
  // navigation has to happen as the tour MOVES — driver.js only reports a step
  // change once it has resolved that step's target, which for a target on a
  // screen nobody navigated to is after the wait expired and the tour gave up.
  it('puts the user on the next step`s screen before moving onto it', async () => {
    await start('close', { positionId: 'pos-1' });
    const closeSet = WALKTHROUGH_STEPS.close;
    navigate.mockClear();

    highlight(closeSet.findIndex((s) => s.target === '[data-tour="position-close"]'));
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'closed' });
    });

    expect(navigate).toHaveBeenCalledWith({ to: '/dashboard' });
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(
      engine.advance.mock.invocationCallOrder[0],
    );
  });

  it('navigates nowhere when the next step is on the same screen', async () => {
    await start('account');
    navigate.mockClear();

    highlight(
      WALKTHROUGH_STEPS.account.findIndex((s) => s.target === '[data-tour="account-submit"]'),
    );
    act(() => {
      eventBus.publish('accounts:cache-invalidate', { reason: 'created' });
    });

    expect(engine.advance).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  // `/positions` → `/positions/$positionId`, the position set's one change of
  // screen. NOTHING ELSE MAKES IT: creating a position leaves the user on the
  // list, so without this the set stops on `/positions`, the next step's target
  // never appears and steps 3 to 5 are unreachable — which is what shipped.
  //
  // The id can only come from the event. It did not exist when the tour started,
  // and the position the user is logging is not the one they already had open —
  // so the fallback below must NOT be what is navigated to.
  it('follows the user onto the position they just created', async () => {
    positions = [{ id: 'pos-open', status: 'open' }];
    await start('position');
    navigate.mockClear();

    highlight(WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol'));
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'created', positionId: 'pos-new' });
    });

    expect(engine.advance).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({
      to: '/positions/$positionId',
      params: { positionId: 'pos-new' },
    });
    // Before the tour moves, for the reason the close set needed it: the step's
    // wait has to cover the route mounting, not start after it.
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(
      engine.advance.mock.invocationCallOrder[0],
    );
  });

  // And the guarantee that survives it: a parameterised route is never navigated
  // to with values nobody supplied. An event that names no row leaves the tour
  // where it is, which degrades to a clean `target-missing` rather than to a URL
  // built out of a guess.
  it('leaves a route it has no values for alone', async () => {
    positions = [{ id: 'pos-open', status: 'open' }];
    await start('position');
    navigate.mockClear();

    highlight(WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol'));
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    });

    expect(engine.advance).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  // The rest of the position set stays on the page it just arrived at: an id
  // carried in by the create must not make every later step re-navigate, which
  // would remount the screen under the fill dialog the step before opened.
  it('does not re-navigate once it is already on the position', async () => {
    await start('position');
    highlight(WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol'));
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'created', positionId: 'pos-new' });
    });
    navigate.mockClear();

    highlight(
      WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '[data-tour="position-open"]'),
    );
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'opened', positionId: 'pos-new' });
    });

    expect(engine.advance).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a step that is not action-gated alone', async () => {
    await start('account');
    const index = WALKTHROUGH_STEPS.account.findIndex((s) => s.target === '#currency');
    highlight(index);

    act(() => {
      eventBus.publish('accounts:cache-invalidate', { reason: 'created' });
    });

    expect(engine.advance).not.toHaveBeenCalled();
  });

  it('stops listening once the tour has ended', async () => {
    await start('position');
    highlight(WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol'));

    act(() => {
      started?.handlers.onExit?.('dismissed');
    });
    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    });

    expect(engine.advance).not.toHaveBeenCalled();
  });

  it('survives the component that started it unmounting mid-tour', async () => {
    const { result, unmount } = renderHook(() => useWalkthrough());
    await act(async () => {
      result.current.start('position');
    });
    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());
    highlight(WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol'));

    // The tour navigates off /positions and the zero-state goes with it.
    unmount();

    act(() => {
      eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    });
    expect(engine.advance).toHaveBeenCalledOnce();
    expect(useWalkthroughStore.getState().isRunning).toBe(true);
  });
});

// --- the signal table itself ------------------------------------------------

describe('useWalkthrough — action signals', () => {
  const allSteps: WalkthroughStep[] = Object.values(WALKTHROUGH_STEPS).flat();

  it('every signal names a target some action step actually uses', () => {
    const gated = new Set(
      allSteps.filter((s) => s.advanceOnAction).map((s) => s.target ?? '(centred)'),
    );
    for (const target of Object.keys(ACTION_SIGNALS)) {
      expect(gated).toContain(target);
    }
  });

  it('hands the engine only the action steps it can actually advance', async () => {
    // Each of these asks for a UI GESTURE — opening a dialog, choosing a tab,
    // picking an account — which writes nothing and publishes nothing, so no
    // event exists to advance them and "Next" has to. If one of them ever gains
    // a signal, move it here and to ACTION_SIGNALS in the same change.
    await start('calculator');
    expect(gatedTargets()).toEqual([]);

    resetSession();
    await start('position');
    expect(gatedTargets()).toEqual([
      '#symbol',
      '[data-tour="position-add-fill"]',
      '[data-tour="position-open"]',
    ]);

    resetSession();
    await start('account');
    expect(gatedTargets()).toEqual(['[data-tour="account-submit"]']);
  });

  // The test above pins the targets that survive the override, so it stays green
  // when a NEW action step is authored without a signal — the new step is simply
  // absent from the lists it compares. This one is the guard for that: the
  // override is a general rule, and the set of steps it silently downgrades is
  // enumerated here by name. A fifth turns this red, which is the whole point.
  it('downgrades exactly these four gated steps, and no others', () => {
    const downgraded = allSteps
      .filter((s) => s.advanceOnAction)
      .map((s) => s.target ?? '(centred)')
      .filter((target) => !(target in ACTION_SIGNALS))
      .sort();

    expect(downgraded).toEqual(
      [
        // Opens the account dialog.
        '[data-testid="zero-state-create-account"]',
        // Chooses the Percent risk basis.
        '[data-tour="calculator-risk"]',
        // Picks the account to size against.
        '[data-tour="calculator-account"]',
        // Opens the new-position dialog.
        '[data-tour="position-new"]',
      ].sort(),
    );
  });

  it('does not otherwise alter the authored steps', async () => {
    await start('close');
    expect(currentTargets()).toEqual(WALKTHROUGH_STEPS.close.map((s) => s.target));
    expect(started?.steps.map((s) => s.title)).toEqual(WALKTHROUGH_STEPS.close.map((s) => s.title));
  });
});

// --- logout ------------------------------------------------------------------

describe('useWalkthrough — logging out ends the session', () => {
  it('drops the session and stops the tour', async () => {
    const result = await start('account');
    await waitFor(() => expect(result.current.isRunning).toBe(true));

    await act(async () => {
      eventBus.publish('auth:logout', {});
    });

    // The overlay goes with it — clearing the store alone would leave driver.js
    // painting over the login screen.
    expect(engine.stop).toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);
    expect(result.current.itemId).toBeNull();
    expect(result.current.currentStep).toBeNull();
    expect(result.current.stepIndex).toBe(-1);
  });

  it('stops listening for the events that were advancing it', async () => {
    await start('position');
    highlight(WALKTHROUGH_STEPS.position.findIndex((s) => s.target === '#symbol'));

    await act(async () => {
      eventBus.publish('auth:logout', {});
    });
    act(() => {
      // The next user creating a position must not advance the last one's tour.
      eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    });

    expect(engine.advance).not.toHaveBeenCalled();
  });

  // The engine here is the double, but its `stop()` drives `onExit` the way the
  // real one does, so this exercises the ordering rather than asserting around
  // it. Tearing the session down before the engine reported `stepIndex: -1` of
  // a `stepCount: 0` tour — an abandonment at no step, in a walkthrough of
  // nothing — for every logout mid-tour.
  // The reason is `session-ended`, not `dismissed`. This replaces the version
  // of this test that pinned `dismissed`, which was the conflation itself: the
  // funnel asks where users stop, and a user whose session went away under them
  // did not decline the walkthrough. The assertion is otherwise the same one,
  // and narrower — it now names which of the two it was.
  it('reports the step the user was actually on when they logged out', async () => {
    const result = await start('account');
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    highlight(2);

    await act(async () => {
      eventBus.publish('auth:logout', {});
    });

    expect(eventsNamed('onboarding_walkthrough_abandoned')).toEqual([
      {
        item: 'account',
        stepIndex: 2,
        stepCount: WALKTHROUGH_STEPS.account.length,
        reason: 'session-ended',
      },
    ]);
    // And the session is still gone afterwards — the event is read on the way
    // out, not kept.
    expect(result.current.stepIndex).toBe(-1);
    expect(result.current.isRunning).toBe(false);
  });

  // The other half of the distinction: the reason the session teardown passes
  // must not become the reason for every ending. Stopping the tour from the UI
  // names none, so the engine reports the one it was tracking.
  it('leaves a walkthrough the user turned down reported as dismissed', async () => {
    const result = await start('account');
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    highlight(1);

    await act(async () => {
      result.current.stop();
    });

    expect(eventsNamed('onboarding_walkthrough_abandoned')).toEqual([
      {
        item: 'account',
        stepIndex: 1,
        stepCount: WALKTHROUGH_STEPS.account.length,
        reason: 'dismissed',
      },
    ]);
  });

  it('reports nothing when the runtime never loaded and no tour was running', async () => {
    act(() => {
      eventBus.publish('auth:logout', {});
    });

    expect(captureClientEvent).not.toHaveBeenCalled();
  });

  it('clears an unavailable runtime with no tour running', () => {
    act(() => {
      useWalkthroughStore.setState({ isUnavailable: true });
    });

    act(() => {
      eventBus.publish('auth:logout', {});
    });

    expect(useWalkthroughStore.getState().isUnavailable).toBe(false);
  });
});

// --- the funnel events ------------------------------------------------------

describe('useWalkthrough — analytics', () => {
  it('reports the walkthrough as offered once per item on offer', () => {
    const { rerender } = renderHook(() => useWalkthrough());

    expect(eventsNamed('onboarding_walkthrough_offered')).toEqual([{ item: 'account' }]);

    // Re-renders of the same offer are the same offer.
    rerender();
    rerender();
    expect(eventsNamed('onboarding_walkthrough_offered')).toHaveLength(1);

    // Finishing an item puts a genuinely different one on offer.
    checklist = aChecklist('account');
    rerender();
    expect(eventsNamed('onboarding_walkthrough_offered')).toEqual([
      { item: 'account' },
      { item: 'calculator' },
    ]);
  });

  it('reports nothing offered when there is nothing behind the button', () => {
    checklist = undefined;
    const { rerender } = renderHook(() => useWalkthrough());
    expect(captureClientEvent).not.toHaveBeenCalled();

    checklist = null;
    rerender();
    expect(captureClientEvent).not.toHaveBeenCalled();

    checklist = aChecklist('account', 'calculator', 'position', 'close');
    rerender();
    expect(captureClientEvent).not.toHaveBeenCalled();
  });

  it('reports a start only once a tour actually begins', async () => {
    await start('account');

    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());
    expect(eventsNamed('onboarding_walkthrough_started')).toEqual([
      { item: 'account', stepCount: WALKTHROUGH_STEPS.account.length },
    ]);
  });

  it('reports a completion when the tour runs to the end', async () => {
    await start('calculator');
    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());

    act(() => {
      started?.handlers.onExit?.('completed');
    });

    expect(eventsNamed('onboarding_walkthrough_completed')).toEqual([
      { item: 'calculator', stepCount: WALKTHROUGH_STEPS.calculator.length },
    ]);
    expect(eventsNamed('onboarding_walkthrough_abandoned')).toEqual([]);
  });

  it('carries the step the user was on when they left, without storing one', async () => {
    const result = await start('account');
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    highlight(3);

    act(() => {
      started?.handlers.onExit?.('dismissed');
    });

    // The index comes from the live session — the same number the overlay was
    // painting — read on the way out. Nothing wrote it down, which is why the
    // session is back at -1 immediately afterwards.
    expect(eventsNamed('onboarding_walkthrough_abandoned')).toEqual([
      {
        item: 'account',
        stepIndex: 3,
        stepCount: WALKTHROUGH_STEPS.account.length,
        reason: 'dismissed',
      },
    ]);
    expect(eventsNamed('onboarding_walkthrough_completed')).toEqual([]);
    expect(result.current.stepIndex).toBe(-1);
  });

  it('reports a target that never appeared as an abandonment with its own reason', async () => {
    await start('position');
    await waitFor(() => expect(engine.startTour).toHaveBeenCalledOnce());
    highlight(1);

    act(() => {
      started?.handlers.onExit?.('target-missing');
    });

    expect(eventsNamed('onboarding_walkthrough_abandoned')).toEqual([
      {
        item: 'position',
        stepIndex: 1,
        stepCount: WALKTHROUGH_STEPS.position.length,
        reason: 'target-missing',
      },
    ]);
  });

  it('sends no trade or monetary data on any of them', async () => {
    const result = await start('close', { positionId: 'pos-1' });
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    highlight(2);
    act(() => {
      started?.handlers.onExit?.('dismissed');
    });

    // The position id the caller handed `start()` is used to NAVIGATE and never
    // reaches a payload.
    const properties = captureClientEvent.mock.calls.map(
      ([, props]) => props as Record<string, unknown>,
    );
    const keys = new Set(properties.flatMap((props) => Object.keys(props)));
    expect([...keys].sort()).toEqual(['item', 'reason', 'stepCount', 'stepIndex']);
    expect(properties.flatMap((props) => Object.values(props))).not.toContain('pos-1');
  });

  it('a failing capture changes nothing about the tour', async () => {
    captureClientEvent.mockImplementation(() => {
      throw new Error('vendor SDK exploded');
    });

    const result = await start('account');

    // Started, ran and ended exactly as it would have with nobody counting.
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    expect(engine.startTour).toHaveBeenCalledOnce();

    act(() => {
      started?.handlers.onExit?.('completed');
    });
    expect(result.current.isRunning).toBe(false);
    expect(result.current.itemId).toBeNull();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

// --- graceful failure -------------------------------------------------------

describe('useWalkthrough — the runtime will not load', () => {
  afterEach(() => {
    vi.doUnmock('../lib/tour-engine');
    vi.resetModules();
  });

  it('degrades to the unguided path without throwing', async () => {
    vi.resetModules();
    vi.doMock('../lib/tour-engine', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const failing = await import('./useWalkthrough');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => failing.useWalkthrough());
    await act(async () => {
      // The success criterion is literally this line not throwing.
      result.current.start('account');
    });

    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(result.current.isRunning).toBe(false);
    expect(result.current.currentStep).toBeNull();
    // The user has not skipped anything, so nothing says they have.
    expect(setStatus).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    act(() => {
      failing.__resetWalkthroughForTests();
    });
    consoleError.mockRestore();
  });
});
