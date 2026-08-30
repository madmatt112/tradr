// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/ui/sonner';
import { eventBus } from '@/stores/event-bus.store';

import type { Checklist, ChecklistItemId } from '../lib/derive-checklist';
import { WALKTHROUGH_STEPS, type WalkthroughStep } from '../lib/steps';
// The module under `vi.mock` below: `stop()` here is the double's, or the real
// engine's, on the same terms as everything else the hook calls.
import {
  stop as endRealTour,
  type TourBlock,
  type TourExitReason,
  type TourHandlers,
  type TourStep,
} from '../lib/tour-engine';

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
//
// ONLY THE HOOK IS REPLACED. `selectOwnRows` — the checklist's own rule for which
// rows are the user's — comes through untouched, because the whole claim of the
// sample-data case below is that `canStart` decides on that rule rather than on
// a second one written next to it.
let checklist: Checklist | null | undefined;
const setStatus = vi.fn();
const dismiss = vi.fn();
vi.mock('./useOnboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useOnboarding')>()),
  useOnboarding: () => ({ checklist, setStatus, dismiss }),
}));

// The positions list, supplied directly for the same reason. The walkthrough
// reads it for exactly one thing — which position the close set opens on — and
// the real hook would need a QueryClient and a fetch to say so.
let positions: { id: string; status: string; accountId?: string }[] | undefined;
vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: () => ({ data: positions }),
  // The launcher's click-time read reaches for the query DEFINITION rather than
  // the hook. Nothing in this file drives that path — `WalkthroughLauncher.test`
  // does, against a real QueryClient — but the export has to exist for the
  // module under test to import it.
  positionsListQuery: () => ({ queryKey: ['positions', 'list', undefined], queryFn: () => [] }),
}));

// The accounts list, supplied directly for the same reason again. The
// walkthrough reads it for one thing only — whether the screens two of the sets
// open on are the ones the user is actually looking at.
let accounts: { id: string; isDemo?: boolean }[] | undefined;
vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accounts }),
  accountsListQuery: () => ({ queryKey: ['accounts', 'list'], queryFn: () => [] }),
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

/**
 * The double above, OR the real engine — see `withRealEngine`.
 *
 * A double cannot check which cause the engine assigns a stop, because the
 * assignment is precisely what the test would be inventing. Only
 * `lib/tour-engine` reads the live DOM at the moment it gives up, and only it
 * knows that a step it gave up on is very often an action-gated one — every
 * gated step in the position and close sets also waits for its target, and both
 * of them live in dialogs the user can close. So the wording has to be pinned
 * against a stop the real engine actually produced.
 */
let realEngine = false;
vi.mock('../lib/tour-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/tour-engine')>();
  return {
    startTour: (steps: TourStep[], handlers?: TourHandlers) =>
      realEngine ? real.startTour(steps, handlers) : engine.startTour(steps, handlers),
    advance: () => (realEngine ? real.advance() : engine.advance()),
    stop: (reason?: TourExitReason) => (realEngine ? real.stop(reason) : engine.stop(reason)),
    isActive: () => (realEngine ? real.isActive() : engine.isActive()),
  };
});

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

/**
 * The engine giving up, as `lib/tour-engine` does: it ends the tour and hands
 * over its classification of why the user could not get past a step, or none
 * when nobody was stuck.
 *
 * WHICH step it was and WHICH cause held them belong to the engine and are
 * pinned there against the real driver.js. They arrive as one value, so a test
 * here cannot pair a cause with a step the engine would never have paired it
 * with. What belongs here is what the user is left looking at afterwards.
 */
function endTour(reason: TourExitReason, blocked?: TourBlock) {
  act(() => {
    const session = started;
    started = null;
    session?.handlers.onExit?.(reason, blocked);
  });
}

/** Put the app's real toaster on screen, so a notice can be READ rather than counted. */
function withToaster() {
  render(createElement(Toaster));
}

/** Some other notice, raised only to prove a render happened — see below. */
const A_MARKER = 'a notice raised by the test';

/**
 * NO NOTICE APPEARED, AND THIS CAN FAIL WHEN ONE DID.
 *
 * Querying straight after the tour ends proves nothing: sonner renders on its
 * own schedule, so the toaster is still empty on that tick whether a notice was
 * raised or not. Every "says nothing" test here read as green with the notice
 * firing — checked by raising one deliberately and watching them pass.
 *
 * So the silence is measured against a notice that IS expected. Raising a marker
 * and waiting for it puts the toaster through a render, and sonner renders its
 * whole queue in one pass — so anything raised before the marker is on screen by
 * the time the marker is. If the walkthrough spoke, this sees it.
 */
async function expectNoStopNotice(): Promise<void> {
  toast.info(A_MARKER);
  expect(await screen.findByText(A_MARKER)).toBeTruthy();
  expect(screen.queryByText('The walkthrough stopped')).toBeNull();
}

/**
 * Drive the next tour with the REAL engine — driver.js, the real gate, the real
 * classification read off the live DOM — instead of the double.
 *
 * jsdom is enough, as it is for the engine's own tests: driver.js reads only
 * `getBoundingClientRect`, which returns zeroes here. Reduced motion keeps its
 * rendering synchronous, so the popover is on screen the moment a tour starts.
 */
function withRealEngine() {
  realEngine = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Put the control a step anchors to on screen, so the real engine can find it. */
function mountTarget(step: WalkthroughStep): void {
  const attribute = /^\[([\w-]+)="([^"]+)"\]$/.exec(step.target ?? '');
  if (!attribute) throw new Error(`the step under test has no attribute target: ${step.target}`);
  const control = document.createElement('button');
  control.setAttribute(attribute[1], attribute[2]);
  document.body.appendChild(control);
}

/** The step in the running set that will only move on the real action. */
function aGatedStep(): TourStep {
  const step = started?.steps.find((s) => s.advanceOnAction);
  if (!step) throw new Error('the set under test has no action-gated step');
  return step;
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
  // sonner's queue is module-scoped like the session is, so a notice raised in
  // one test would still be there for the next one's toaster to render.
  toast.dismiss();
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

  it('never falls back onto a position the sample account owns', async () => {
    accounts = [{ id: 'demo-acct', isDemo: true }];
    positions = [{ id: 'demo-open', status: 'open', accountId: 'demo-acct' }];
    await start('close');

    // There is nowhere to open it: the only open position is the fixture's, and
    // closing that completes nothing the checklist can see.
    expect(navigate).not.toHaveBeenCalled();
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

// --- a tour that cannot carry on -------------------------------------------

/**
 * A WALKTHROUGH THAT VANISHES WITH NOTHING ON SCREEN IS THIS AREA'S RECURRING
 * DEFECT, and these are about what is left in front of the user, not about
 * which function ran. They render the app's real toaster and read the words in
 * it for that reason: "a handler was called" is exactly the evidence that would
 * have passed while the screen stayed blank.
 *
 * The position and close sets each ask the user to do the real thing — create
 * the position, record the exit fill — and replaying one still does. That is
 * the walkthrough working as intended. What was broken was that a user who did
 * not want to place another trade was shown nothing at all when it stopped.
 */
describe('useWalkthrough — the tour says why it stopped', () => {
  it('tells the user an action-gated step needs them to actually do it', async () => {
    withToaster();
    await start('position');
    const gated = aGatedStep();

    // The decline: the user closed the tour on a step whose control was there
    // and pressable, which is the only stop that is theirs to clear.
    endTour('dismissed', { cause: 'action-required', step: gated });

    const notice = await screen.findByText('The walkthrough stopped');
    expect(notice).toBeTruthy();

    const why = await screen.findByText(/only moves on once you have actually done it/);
    // The step it stopped at, named, so "which one?" is not left to the user.
    expect(why.textContent).toContain(gated.title);
    expect(why.textContent).toContain('the walkthrough cannot take that step for you');
    // Both ways out, said plainly.
    expect(why.textContent).toContain('carry on without it');
    expect(why.textContent).toContain('start it again whenever you want from Settings → Help');
  });

  /**
   * THE WAY BACK IN HAS TO STILL BE THERE WHEN THEY GET THERE.
   *
   * This notice used to send the reader to the setup checklist, which is the one
   * surface in the product that goes away for good: it retires the moment all
   * four items are complete, and a user replaying a set from settings has by
   * definition finished. Directing them to a screen that no longer exists is
   * worse than saying nothing — they go looking for it.
   */
  it('does not send the reader back to a checklist that may have retired', async () => {
    withToaster();
    await start('close');

    endTour('target-missing', { cause: 'target-missing', step: aGatedStep() });

    const why = await screen.findByText(/is not on screen/);
    expect(why.textContent).not.toContain('checklist');
    expect(why.textContent).toContain('Settings → Help');
  });

  /**
   * THE SAME STEP, THE OTHER CAUSE, AND IT MUST NOT READ THE SAME. Every gated
   * step in these two sets also waits for its target, so a slow load or a
   * navigation that never happened stops the tour on one of them having shown
   * the user no control at all. Wording that keyed off the gate blamed them for
   * not pressing a button that was never there.
   */
  it('does not blame the user when a gated step was the one that never appeared', async () => {
    withToaster();
    await start('close');
    const gated = aGatedStep();

    endTour('target-missing', { cause: 'target-missing', step: gated });

    const why = await screen.findByText(/is not on screen/);
    expect(why.textContent).toContain(gated.title);
    expect(why.textContent).toContain('the walkthrough could not carry on from there');
    expect(screen.queryByText(/only moves on once you have actually done it/)).toBeNull();
  });

  // The general case, and the reason this is one path rather than a special
  // case on the gate: the same silence has come from a set left on the wrong
  // route and from a control that unmounted mid-tour.
  it('explains an ordinary step that was never on screen', async () => {
    withToaster();
    await start('position');
    const plain = started!.steps.find((s) => !s.advanceOnAction && s.target !== undefined)!;

    endTour('target-missing', { cause: 'target-missing', step: plain });

    const why = await screen.findByText(/is not on screen/);
    expect(why.textContent).toContain(plain.title);
    expect(why.textContent).toContain('start it again whenever you want from Settings → Help');
  });

  // The fallback that used to sit here — a `target-missing` naming no step —
  // has no test because it has no case: the engine hands over one value
  // carrying both the cause and the step it happened on, so "gave up, said
  // which reason, named no step" is not a thing that can be constructed. The
  // engine's own tests pin that every give-up produces one.

  it('says nothing when the user simply closed the tour', async () => {
    withToaster();
    await start('position');

    endTour('dismissed');

    await expectNoStopNotice();
  });

  it('says nothing when the user finished it', async () => {
    withToaster();
    await start('position');

    endTour('completed');

    await expectNoStopNotice();
  });

  // The session went away under the tour; the notice would land on the login
  // screen, addressed to nobody.
  it('says nothing when the session ended under it', async () => {
    withToaster();
    await start('position');

    endTour('session-ended');

    await expectNoStopNotice();
  });
});

/**
 * THE SAME NOTICE, WITH NOTHING INVENTED IN BETWEEN.
 *
 * Everything above hands `onExit` a classification chosen by the test, which is
 * how the wrong cause reached the screen twice: what the engine actually
 * produces was never driven. These run the REAL engine over the REAL close set
 * and read what is on screen at the end, so a classification that stops matching
 * its wording fails here rather than in front of a user.
 *
 * The close set is the one that reaches every stop. Its first step is
 * action-gated AND waits five seconds for a control on a route that has to load
 * first, so the SAME step produces all three endings: the user declining an
 * action they could have taken, a control that never arrived, and a control that
 * arrived and then went away under them.
 */
describe('useWalkthrough — the real engine says why it stopped', () => {
  const gated = WALKTHROUGH_STEPS.close[0];

  afterEach(() => {
    // The engine's own module state, which the hook's reset does not reach.
    // Runs before the file-wide teardown, so the toaster is still up for it.
    endRealTour();
    realEngine = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('blames the user for nothing when the control never rendered', async () => {
    // The step really is gated — the pairing that used to pick the wording.
    expect(gated.advanceOnAction).toBe(true);
    expect(gated.waitForMs).toBeGreaterThan(0);
    withToaster();
    withRealEngine();
    // Only `setTimeout`, so React and sonner keep their own scheduling: the
    // wait for a target is a plain timer inside driver.js, and it is the only
    // clock this test wants to move.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // Nothing is mounted, so the control never appears — the position page
    // still loading, or a navigation that did not happen.
    await start('close');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(gated.waitForMs! + 100);
    });
    vi.useRealTimers();

    const why = await screen.findByText(/is not on screen/);
    expect(why.textContent).toContain(gated.title);
    expect(screen.queryByText(/only moves on once you have actually done it/)).toBeNull();
  });

  it('says that same step needs them when they close the tour on it', async () => {
    withToaster();
    withRealEngine();
    // The control is there and pressable, so the gate is really holding.
    mountTarget(gated);

    await start('close');
    expect(document.querySelector('.driver-popover-title')?.textContent).toBe(gated.title);

    // The close button is the only control that answers on a gated step.
    act(() => {
      document.querySelector<HTMLButtonElement>('.driver-popover-close-btn')?.click();
    });

    const why = await screen.findByText(/only moves on once you have actually done it/);
    expect(why.textContent).toContain(gated.title);
  });

  /**
   * THE CONTROL WENT AWAY UNDER THE STEP, AND THE USER DID NOT DECLINE ANYTHING.
   *
   * The third ending, and the one that read as the first: the engine recorded a
   * gate for a step whose control had unmounted, so the tour told a user who had
   * just cancelled a dialog that they had failed to do the thing inside it. It
   * is the ordinary shape of every gated step in the product — `#symbol` and Add
   * Fill both live in dialogs — which is why the classification is read from the
   * live DOM at the moment the tour ends rather than from the step's own flag.
   */
  it('does not blame the user when the control was dismissed with its dialog', async () => {
    withToaster();
    withRealEngine();
    mountTarget(gated);

    await start('close');
    expect(document.querySelector('.driver-popover-title')?.textContent).toBe(gated.title);

    // The dialog the control lived in, cancelled; then the tour closed.
    document.querySelector(gated.target!)!.remove();
    act(() => {
      document.querySelector<HTMLButtonElement>('.driver-popover-close-btn')?.click();
    });

    const why = await screen.findByText(/is not on screen/);
    expect(why.textContent).toContain(gated.title);
    expect(screen.queryByText(/only moves on once you have actually done it/)).toBeNull();
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

  // THE ACCOUNT SET IS OFFERED TO A USER WHO ALREADY HAS ACCOUNTS, and that is
  // the whole of why it was moved off the dashboard's welcome screen. Anchored
  // there it could only run for a user with nothing, which is to say it could
  // never be run twice; anchored on the Accounts page's "New Account" — a
  // control `AccountList` renders for everybody — the only state it is withheld
  // in is the one the product itself blocks, which is sample data (below).
  it('offers the account set whether or not the user already has one', () => {
    accounts = [];
    expect(canStartAll().account).toBe(true);

    accounts = [{ id: 'acct-1' }];
    expect(canStartAll().account).toBe(true);

    // Their own account alongside the sample one is still the sample state:
    // creating another still starts by removing the sample data.
    accounts = [{ id: 'acct-1' }, { id: 'demo-acct', isDemo: true }];
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

  // THE SAMPLE-DATA STATE, WHICH IS A STATE THE CHECKLIST ALREADY HAS AN OPINION
  // ABOUT. Everything on screen belongs to the fixture, and the checklist counts
  // none of it, so a tour over those rows would end with the item exactly as
  // unticked as it started and nothing to tell the user why. `canStart` says so
  // too, from the same selector the counts come from.
  it('offers no set that would run over sample data and complete nothing', () => {
    accounts = [{ id: 'demo-acct', isDemo: true }];
    positions = [
      { id: 'demo-open', status: 'open', accountId: 'demo-acct' },
      { id: 'demo-closed', status: 'closed', accountId: 'demo-acct' },
    ];

    const answers = canStartAll();
    // Logging a position would book it against the sample account, and closing
    // one of the fixture's trades is not closing one of the user's.
    expect(answers.position).toBe(false);
    expect(answers.close).toBe(false);
    // The account set is withheld here too, and for the product's own reason
    // rather than the tour's: "New Account" asks to remove the sample data
    // before it opens the form, the server refuses the create until it is gone,
    // and that confirmation sits under the walkthrough's overlay where a click
    // for it ends the walkthrough instead. That leaves the calculator as this
    // user's one guided entry point until they remove the sample data.
    expect(answers.account).toBe(false);
    expect(answers.calculator).toBe(true);
  });

  // The same two sets, once the rows are the user's. Nothing about the demo
  // account being absent is what decides it — having their own data is.
  it('offers both again once the user has rows of their own', () => {
    accounts = [{ id: 'demo-acct', isDemo: true }, { id: 'acct-1' }];
    positions = [
      { id: 'demo-open', status: 'open', accountId: 'demo-acct' },
      { id: 'pos-open', status: 'open', accountId: 'acct-1' },
    ];

    const answers = canStartAll();
    expect(answers.position).toBe(true);
    expect(answers.close).toBe(true);
  });

  it('always offers the calculator set, which needs nothing of the user', () => {
    accounts = [];
    positions = [];
    expect(canStartAll().calculator).toBe(true);
  });

  it('offers nothing that depends on an account count it does not have', () => {
    accounts = undefined;
    const answers = canStartAll();
    expect(answers.position).toBe(false);
    // The one that turns on no count at all is unaffected by not having one.
    expect(answers.calculator).toBe(true);
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
        '[data-tour="account-new"]',
        // Chooses the Percent risk basis.
        '[data-tour="calculator-risk"]',
        // Picks the account to size against.
        '[data-tour="calculator-account"]',
        // Opens the new-position dialog.
        '[data-tour="position-new"]',
      ].sort(),
    );
  });

  // THE OTHER HALF OF THE DOWNGRADE, AND THE REASON IT IS NOT JUST "PRESS NEXT".
  //
  // Two of those four open a dialog, and the step after each names a field
  // inside it. "Next" cannot move a tour onto a target that is not on screen —
  // it strands driver.js in that step's wait with the previous popover still up,
  // which is the "the next button does nothing" both sets were reported for. So
  // the dialog arriving is named as the signal instead, and the engine holds the
  // step until it does.
  it('names the control that advances each downgraded step, or nothing', async () => {
    const signals = async (item: ChecklistItemId): Promise<[string, string | undefined][]> => {
      resetSession();
      await start(item);
      return (started?.steps ?? [])
        .filter((step) => step.advanceOnAppearanceOf !== undefined)
        .map((step) => [step.target ?? '(centred)', step.advanceOnAppearanceOf]);
    };

    expect(await signals('account')).toEqual([['[data-tour="account-new"]', '#name']]);
    expect(await signals('position')).toEqual([['[data-tour="position-new"]', '#symbol']]);

    // The calculator's two are named as well — both point at a control
    // `/calculator` already renders, so the engine finds it present, leaves the
    // gate open and "Next" moves them exactly as it always did.
    expect(await signals('calculator')).toEqual([
      ['[data-tour="calculator-risk"]', '[data-tour="calculator-account"]'],
      ['[data-tour="calculator-account"]', '#riskPercent, #dollarRisk'],
    ]);

    // Nothing in the close set: neither of its action steps is downgraded, and
    // its one step that changes screen is reached by NAVIGATING, which nothing
    // does until the tour moves. Waiting for that target would be waiting for
    // something the wait itself prevents.
    expect(await signals('close')).toEqual([]);
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
