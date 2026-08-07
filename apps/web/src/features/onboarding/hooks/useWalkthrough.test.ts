// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventBus } from '@/stores/event-bus.store';

import type { Checklist, ChecklistItemId } from '../lib/derive-checklist';
import { WALKTHROUGH_STEPS, type WalkthroughStep } from '../lib/steps';
import type { TourHandlers, TourStep } from '../lib/tour-engine';

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

let started: { steps: TourStep[]; handlers: TourHandlers } | null = null;
const engine = {
  startTour: vi.fn((steps: TourStep[], handlers: TourHandlers = {}) => {
    started = { steps, handlers };
    handlers.onStepChange?.(0, steps[0]);
  }),
  advance: vi.fn(),
  stop: vi.fn(),
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

beforeEach(() => {
  checklist = aChecklist();
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

// --- opt-in (R5.2) ----------------------------------------------------------

describe('useWalkthrough — opt-in only (R5.2)', () => {
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

  it('going idle on exit, however the tour ended, writes no onboarding state (R5.3)', async () => {
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

// --- resume (R5.6) ----------------------------------------------------------

describe('useWalkthrough — resume (R5.6)', () => {
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

// --- advance on the real action (R5.5) --------------------------------------

describe('useWalkthrough — action-driven advance (R5.5)', () => {
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

  it('survives the component that started it unmounting mid-tour (R5.6)', async () => {
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
  it('downgrades exactly these four gated steps, and no others (R5.5)', () => {
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

  it('clears an unavailable runtime with no tour running (R5.8)', () => {
    act(() => {
      useWalkthroughStore.setState({ isUnavailable: true });
    });

    act(() => {
      eventBus.publish('auth:logout', {});
    });

    expect(useWalkthroughStore.getState().isUnavailable).toBe(false);
  });
});

// --- graceful failure (R5.8) ------------------------------------------------

describe('useWalkthrough — the runtime will not load (R5.8)', () => {
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
    // The user has not skipped anything, so nothing says they have (R5.8).
    expect(setStatus).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    act(() => {
      failing.__resetWalkthroughForTests();
    });
    consoleError.mockRestore();
  });
});
