// @vitest-environment jsdom
import type { AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingEvent } from './analytics';
import type { Checklist, ChecklistItemId } from './derive-checklist';

// THE VENDOR SDK IS THE DOUBLE, NOT THE TELEMETRY MODULE. Stubbing
// `@/lib/telemetry/posthog` would prove only that this file calls the function
// it obviously calls; the interesting claims are about what that module does
// with the call, and the loudest of them is R8.4 — with nothing configured, the
// SDK is never even loaded and nothing is sent. Mocking one level lower is what
// lets the same spy answer both "was it sent?" and "was it not?".
const { initSpy, captureSpy } = vi.hoisted(() => ({ initSpy: vi.fn(), captureSpy: vi.fn() }));

vi.mock('posthog-js', () => ({
  default: {
    init: initSpy,
    capture: captureSpy,
    startExceptionAutocapture: vi.fn(),
    captureException: vi.fn(),
    register: vi.fn(),
  },
}));

// A router that has resolved nothing, so `initPostHogClient` emits no entry
// pageview and every captured call in a test is one this file made.
const idleRouter = {
  state: { matches: [] },
  subscribe: () => () => {},
} as unknown as AnyRouter;

type AnalyticsModule = typeof import('./analytics');

/**
 * Load a fresh copy of the module graph, optionally with PostHog configured and
 * initialized. Fresh because both the completion baseline and the telemetry
 * module's SDK singleton are module state, and a test that starts with either
 * carried over from the last one is testing the wrong thing.
 */
async function load(options: { configured: boolean }): Promise<AnalyticsModule> {
  vi.resetModules();
  captureSpy.mockClear();
  initSpy.mockClear();

  if (options.configured) {
    window.__TRADR_CONFIG__ = { posthogPublicKey: 'phc_test' };
    const analytics = await import('./analytics');
    const { initPostHogClient } = await import('@/lib/telemetry/posthog');
    await initPostHogClient(idleRouter);
    return analytics;
  }
  return import('./analytics');
}

function aChecklist(...done: ChecklistItemId[]): Checklist {
  const ids: ChecklistItemId[] = ['account', 'calculator', 'position', 'close'];
  const items = ids.map((id) => ({ id, label: id, done: done.includes(id) }));
  return { items, allComplete: items.every((item) => item.done) };
}

/** The captured calls as `[name, properties]` pairs. */
function captured(): [string, Record<string, unknown>][] {
  return captureSpy.mock.calls as [string, Record<string, unknown>][];
}

afterEach(() => {
  delete window.__TRADR_CONFIG__;
});

// --- R8.4: nothing configured, nothing emitted ------------------------------

describe('with analytics unconfigured (the self-hosted default)', () => {
  it('emits nothing, for any event, and returns normally', async () => {
    const { emitOnboardingEvent } = await load({ configured: false });

    emitOnboardingEvent({ name: 'onboarding_walkthrough_offered', item: 'account' });
    emitOnboardingEvent({ name: 'onboarding_walkthrough_started', item: 'account', stepCount: 5 });
    emitOnboardingEvent({
      name: 'onboarding_walkthrough_completed',
      item: 'account',
      stepCount: 5,
    });
    emitOnboardingEvent({
      name: 'onboarding_walkthrough_abandoned',
      item: 'account',
      stepIndex: 2,
      stepCount: 5,
      reason: 'dismissed',
    });
    emitOnboardingEvent({ name: 'onboarding_checklist_item_completed', item: 'close' });

    expect(initSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('reports checklist completions to nobody, and still tracks the baseline', async () => {
    const { reportChecklistCompletions } = await load({ configured: false });

    reportChecklistCompletions(aChecklist());
    reportChecklistCompletions(aChecklist('account'));

    expect(captureSpy).not.toHaveBeenCalled();
  });
});

// --- the five events --------------------------------------------------------

describe('emitOnboardingEvent', () => {
  let emit: AnalyticsModule['emitOnboardingEvent'];

  beforeEach(async () => {
    ({ emitOnboardingEvent: emit } = await load({ configured: true }));
  });

  it('sends the offered event under its own name', () => {
    emit({ name: 'onboarding_walkthrough_offered', item: 'calculator' });

    expect(captured()).toEqual([['onboarding_walkthrough_offered', { item: 'calculator' }]]);
  });

  it('sends the started and completed events with the set size', () => {
    emit({ name: 'onboarding_walkthrough_started', item: 'position', stepCount: 7 });
    emit({ name: 'onboarding_walkthrough_completed', item: 'position', stepCount: 7 });

    expect(captured()).toEqual([
      ['onboarding_walkthrough_started', { item: 'position', stepCount: 7 }],
      ['onboarding_walkthrough_completed', { item: 'position', stepCount: 7 }],
    ]);
  });

  it('carries the step index and the reason on abandonment (R8.1)', () => {
    emit({
      name: 'onboarding_walkthrough_abandoned',
      item: 'close',
      stepIndex: 3,
      stepCount: 6,
      reason: 'target-missing',
    });

    expect(captured()).toEqual([
      [
        'onboarding_walkthrough_abandoned',
        { item: 'close', stepIndex: 3, stepCount: 6, reason: 'target-missing' },
      ],
    ]);
  });

  it('never lets a capture failure reach the caller', () => {
    captureSpy.mockImplementationOnce(() => {
      throw new Error('vendor SDK exploded');
    });

    expect(() => emit({ name: 'onboarding_walkthrough_offered', item: 'account' })).not.toThrow();
  });
});

// --- R8.5: what an event may carry ------------------------------------------

describe('event payloads carry no trade or monetary data (R8.5)', () => {
  // One of every variant, with the widest payload each one has.
  const EVERY_EVENT: OnboardingEvent[] = [
    { name: 'onboarding_walkthrough_offered', item: 'account' },
    { name: 'onboarding_walkthrough_started', item: 'calculator', stepCount: 5 },
    { name: 'onboarding_walkthrough_completed', item: 'position', stepCount: 5 },
    {
      name: 'onboarding_walkthrough_abandoned',
      item: 'close',
      stepIndex: 1,
      stepCount: 5,
      reason: 'dismissed',
    },
    { name: 'onboarding_checklist_item_completed', item: 'account' },
  ];

  it('emits only step identifiers and counts, across every event there is', async () => {
    const { emitOnboardingEvent } = await load({ configured: true });

    for (const event of EVERY_EVENT) emitOnboardingEvent(event);

    const properties = captured().map(([, props]) => props);
    expect(properties).toHaveLength(EVERY_EVENT.length);

    const keys = new Set(properties.flatMap((props) => Object.keys(props)));
    expect([...keys].sort()).toEqual(['item', 'reason', 'stepCount', 'stepIndex']);

    for (const props of properties) {
      // `item` and `reason` are closed literal sets; the two numbers are an
      // index into a step array and its length. There is no third kind of value,
      // so there is nowhere a symbol, a quantity or a price could sit.
      if ('item' in props) {
        expect(['account', 'calculator', 'position', 'close']).toContain(props.item);
      }
      if ('reason' in props) {
        expect(['dismissed', 'target-missing']).toContain(props.reason);
      }
      for (const key of ['stepIndex', 'stepCount'] as const) {
        if (key in props) expect(Number.isInteger(props[key])).toBe(true);
      }
    }
  });

  it('has no field a caller could put a symbol or an amount in', () => {
    // The runtime assertion above describes what is sent today; THIS is what
    // stops it changing. `OnboardingEvent` is a closed union with no property
    // bag, so an extra key is a compile error — and if that ever stopped being
    // true, the unused `@ts-expect-error` below fails the typecheck instead.
    const event: OnboardingEvent = {
      name: 'onboarding_checklist_item_completed',
      item: 'position',
      // @ts-expect-error -- R8.5: there is no field for trade or monetary data.
      symbol: 'AAPL',
    };

    expect(event.name).toBe('onboarding_checklist_item_completed');
  });
});

// --- R8.2: per-item completion, on the transition ---------------------------

describe('reportChecklistCompletions', () => {
  let report: AnalyticsModule['reportChecklistCompletions'];
  let arm: AnalyticsModule['armChecklistCompletion'];
  let reset: AnalyticsModule['__resetOnboardingAnalyticsForTests'];

  beforeEach(async () => {
    const mod = await load({ configured: true });
    report = mod.reportChecklistCompletions;
    arm = mod.armChecklistCompletion;
    reset = mod.__resetOnboardingAnalyticsForTests;
  });

  it('says nothing about the items the first checklist already had done', () => {
    // A user who signed up last month and reloaded the dashboard has completed
    // nothing just now.
    report(aChecklist('account', 'calculator', 'position', 'close'));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('emits once per item as it becomes complete', () => {
    report(aChecklist());
    report(aChecklist('account'));
    report(aChecklist('account', 'position'));

    expect(captured()).toEqual([
      ['onboarding_checklist_item_completed', { item: 'account' }],
      ['onboarding_checklist_item_completed', { item: 'position' }],
    ]);
  });

  it('does not re-emit for an item that is still complete', () => {
    report(aChecklist());
    report(aChecklist('calculator'));
    captureSpy.mockClear();

    // The re-renders a derived checklist produces on every settled query.
    report(aChecklist('calculator'));
    report(aChecklist('calculator'));
    report(aChecklist('calculator'));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('reports every item of a checklist that completes in one step', () => {
    report(aChecklist('account'));
    report(aChecklist('account', 'calculator', 'position', 'close'));

    expect(captured().map(([, props]) => props.item)).toEqual(['calculator', 'position', 'close']);
  });

  it('treats "not known yet" and "no checklist" as non-observations', () => {
    report(aChecklist('account'));

    // `undefined` while a read is in flight, `null` once the checklist retires
    // or is dismissed. Neither is a checklist in which nothing is done, so
    // neither may reset the baseline and replay every completion afterwards.
    report(undefined);
    report(null);
    report(aChecklist('account'));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('emits nothing when seeded sample data leaves the counts alone', () => {
    // Adding sample data completes no item, because `useOnboarding` excludes the
    // demo account and its rows from every count (R4.8). So the checklist the
    // seed produces is the same checklist, and there is no transition here.
    report(aChecklist());
    report(aChecklist());

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('forgets the baseline when the session ends', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');
    report(aChecklist('account', 'position'));
    captureSpy.mockClear();

    eventBus.publish('auth:logout', {});

    // The next user's first checklist is their baseline, not a run of
    // completions inherited from whoever was logged in before them.
    report(aChecklist('account', 'position'));
    expect(captureSpy).not.toHaveBeenCalled();

    report(aChecklist('account', 'position', 'close'));
    expect(captured()).toEqual([['onboarding_checklist_item_completed', { item: 'close' }]]);
  });

  // --- first-visit completions (R8.2) ---------------------------------------
  //
  // "The first checklist is the baseline" is right for the items a user arrived
  // with and wrong for the ones they finished on the way here. The bus is what
  // separates them: a cache-invalidate is published only once the server took
  // the write, so an item it names was completed during THIS session whatever
  // the first checklist says.

  it('emits an item completed on another route before the dashboard was ever opened', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');

    // Created the account on /accounts, then opened the dashboard: the FIRST
    // checklist this tab derives already has item 1 done.
    eventBus.publish('accounts:cache-invalidate', { reason: 'created' });
    report(aChecklist('account'));

    expect(captured()).toEqual([['onboarding_checklist_item_completed', { item: 'account' }]]);
  });

  it('still baselines away the items it did not watch the user complete', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');

    eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    report(aChecklist('account', 'calculator', 'position'));

    // The account and the calculator predate this session; only the position
    // was logged in it.
    expect(captured()).toEqual([['onboarding_checklist_item_completed', { item: 'position' }]]);
  });

  it('reports a close that happened before the checklist was first derived', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');

    eventBus.publish('positions:cache-invalidate', { reason: 'closed' });
    report(aChecklist('account', 'position', 'close'));

    expect(captured()).toEqual([['onboarding_checklist_item_completed', { item: 'close' }]]);
  });

  it('does not repeat an armed completion on the renders that follow', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');

    eventBus.publish('positions:cache-invalidate', { reason: 'created' });
    report(aChecklist('position'));
    captureSpy.mockClear();

    report(aChecklist('position'));
    report(aChecklist('position'));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('arms nothing on an event that completes no item', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');

    // Sample data is seeded under its own reason and its rows are excluded from
    // every count (R4.8), so it can arm nothing and complete nothing.
    eventBus.publish('accounts:cache-invalidate', { reason: 'demo-seeded' });
    eventBus.publish('positions:cache-invalidate', { reason: 'updated' });
    report(aChecklist('account', 'position'));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('emits the calculator item the patch armed by hand', () => {
    // Item 2 has no cache-invalidate behind it — the calculator is stateless, so
    // writing `calculatorFirstUsedAt` is the only signal there is.
    arm('calculator');
    report(aChecklist('calculator'));

    expect(captured()).toEqual([['onboarding_checklist_item_completed', { item: 'calculator' }]]);
  });

  it('drops the armed completions along with the baseline when the session ends', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');

    eventBus.publish('accounts:cache-invalidate', { reason: 'created' });
    eventBus.publish('auth:logout', {});

    // The next user's account is one they arrived with, not the departing
    // user's event finding a new owner.
    report(aChecklist('account'));

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('re-arms the logout listener after the test reset', async () => {
    const { eventBus } = await import('@/stores/event-bus.store');
    eventBus.__resetForTests();
    reset();

    report(aChecklist('account'));
    eventBus.publish('auth:logout', {});
    report(aChecklist('account'));

    expect(captureSpy).not.toHaveBeenCalled();
  });
});
