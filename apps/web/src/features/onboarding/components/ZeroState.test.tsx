// @vitest-environment jsdom
//
// `useOnboarding` is faked wholesale — the hook has 22 tests of its own and
// ActivationChecklist has 24, so this file is only about what the ZERO-STATE
// does: the three forward actions, the not-connected copy, and the guarantee
// that neither fork leaves the user with less than they started with.
//
// ActivationChecklist is deliberately NOT mocked. "Neither fork is a dead end"
// is a claim about the composed screen ("declining guidance leaves the
// checklist and a docs link in place"), and a stubbed checklist would let that
// claim pass while the real one rendered nothing. The single `useOnboarding`
// mock reaches both components, since both import it from the same path.
//
// AccountDialog IS mocked, to a marker that respects `open`. It pulls in
// brokerages, tier state and the API client, none of which this screen's
// behaviour depends on — what matters here is only that the primary action
// opens it. (AccountList.test.tsx stubs it the same way.)
//
// `useWalkthrough` is faked too. It has 26 tests of its own covering the
// lifecycle — dynamic import, advance-on-event, exit, resume — so what belongs
// HERE is only the wiring: which call site passes which argument, and what the
// screen does when the runtime will not load. Faking it also keeps this suite
// free of the router and the module-scoped tour session the real hook drives.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState, OnboardingStatus } from '@tradr/shared';

import { DOCS_BASE_URL, docsUrl } from '@/lib/docs';

import { useDemoAccount, type UseDemoAccountResult } from '../hooks/useDemoAccount';
import { useOnboarding, type UseOnboardingResult } from '../hooks/useOnboarding';
import { useWalkthrough, type UseWalkthroughResult } from '../hooks/useWalkthrough';
import { deriveChecklist } from '../lib/derive-checklist';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useOnboarding', () => ({ useOnboarding: vi.fn() }));
vi.mock('../hooks/useWalkthrough', () => ({ useWalkthrough: vi.fn() }));
// Faked for the same reason as the other two: it has its own tests, and the
// real one issues an accounts read and two mutations that would need a
// QueryClientProvider here. What belongs in THIS file is the wiring — that the
// control calls `seed` and what it looks like while the seed is in flight.
vi.mock('../hooks/useDemoAccount', () => ({ useDemoAccount: vi.fn() }));

vi.mock('@/features/accounts/components/AccountDialog', () => ({
  AccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="account-dialog" /> : null,
}));

import { ZeroState } from './ZeroState';

const mockUseOnboarding = vi.mocked(useOnboarding);
const mockUseWalkthrough = vi.mocked(useWalkthrough);
const mockUseDemoAccount = vi.mocked(useDemoAccount);

function preference(status: OnboardingStatus): OnboardingState {
  return { status, coachMarksSeen: [] };
}

/** A fresh user: no accounts, no positions, the calculator untouched. */
function freshChecklist() {
  return deriveChecklist({
    accountCount: 0,
    positionsEverCreatedCount: 0,
    closedPositionCount: 0,
  });
}

function useHook(over: Partial<UseOnboardingResult> = {}): UseOnboardingResult {
  const value: UseOnboardingResult = {
    checklist: freshChecklist(),
    preference: preference('pending'),
    isLoading: false,
    isError: false,
    isSaving: false,
    setStatus: vi.fn(),
    dismiss: vi.fn(),
    markCoachMarkSeen: vi.fn(),
    ...over,
  };
  mockUseOnboarding.mockReturnValue(value);
  return value;
}

/** Idle by default — nothing on this screen starts a tour on its own. */
function useTour(over: Partial<UseWalkthroughResult> = {}): UseWalkthroughResult {
  const value: UseWalkthroughResult = {
    start: vi.fn(),
    // Every set startable by default: which ones genuinely are is
    // `useWalkthrough`'s own question and has its own tests. What belongs here
    // is that this screen passes the answer through, which the case below pins
    // by handing back a different one.
    canStart: () => true,
    stop: vi.fn(),
    isRunning: false,
    isUnavailable: false,
    itemId: null,
    currentStep: null,
    stepIndex: -1,
    ...over,
  };
  mockUseWalkthrough.mockReturnValue(value);
  return value;
}

/** Idle by default: no sample data present, nothing in flight. */
function useDemo(over: Partial<UseDemoAccountResult> = {}): UseDemoAccountResult {
  const value: UseDemoAccountResult = {
    isDemoPresent: false,
    demoAccount: undefined,
    seed: vi.fn(),
    teardown: vi.fn(),
    isPending: false,
    ...over,
  };
  mockUseDemoAccount.mockReturnValue(value);
  return value;
}

beforeEach(() => {
  // The idle walkthrough is the backdrop every test but the failed-runtime
  // ones want.
  useTour();
  useDemo();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ZeroState — the three forward actions', () => {
  it('renders all three, and the sample-data option alongside the real one', () => {
    useHook();
    render(<ZeroState />);

    expect(screen.getByRole('button', { name: 'Create my first account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Walk me through it' })).toBeTruthy();
    // Alongside, never instead of — the real account action is still the one
    // that comes first and the one that carries the weight.
    expect(screen.getByRole('button', { name: 'Add sample data' })).toBeTruthy();
  });

  it('opens the account dialog from the primary action', async () => {
    useHook();
    render(<ZeroState />);

    expect(screen.queryByTestId('account-dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create my first account' }));

    expect(screen.getByTestId('account-dialog')).toBeTruthy();
  });

  it('starts nothing at all on mount — the walkthrough is only ever asked for', () => {
    const tour = useTour();
    const hook = useHook();
    render(<ZeroState />);

    // This is one of the two call sites in the product that can start a tour, so
    // opt-in is only structural for as long as MOUNTING this screen does nothing.
    // An effect added here — "resume the active user", "guide the brand-new one" —
    // would break this and nothing else would notice.
    expect(tour.start).not.toHaveBeenCalled();
    expect(hook.setStatus).not.toHaveBeenCalled();
  });

  it('records the guided opt-in as `active`', async () => {
    const hook = useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Walk me through it' }));

    expect(hook.setStatus).toHaveBeenCalledTimes(1);
    expect(hook.setStatus).toHaveBeenCalledWith('active');
  });

  it('records the opt-in before handing off, and never records a refusal', async () => {
    const tour = useTour();
    const hook = useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Walk me through it' }));

    // PINNED ORDER, not incidental. The write lands before `start()` gets the
    // chance to fail on its lazy chunk, because what is recorded is the user's
    // CHOICE — made in full by the time the import is requested — not the
    // chunk's fate. Leaving the status alone on a failed load forbids recording
    // a REFUSAL the user never made; `active` is not one, and `skipped` is the
    // value that would cost them the checklist. Reordering this to write only
    // on success would need tour lifecycle outside `useWalkthrough`, so it is a
    // decision, and this is what says so.
    const optInAt = vi.mocked(hook.setStatus).mock.invocationCallOrder[0] ?? 0;
    const handOffAt = vi.mocked(tour.start).mock.invocationCallOrder[0] ?? 0;
    expect(optInAt).toBeGreaterThan(0);
    expect(optInAt).toBeLessThan(handOffAt);
    expect(vi.mocked(hook.setStatus).mock.calls.flat()).not.toContain('skipped');
  });

  it('starts the walkthrough from the guided fork, with no step of its own to name', async () => {
    const tour = useTour();
    useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Walk me through it' }));

    expect(tour.start).toHaveBeenCalledTimes(1);
    // No id: the hook resolves the first outstanding item itself, which is what
    // makes "begin" and "resume after a reload" the same call. A click event
    // must not arrive here as a step id either.
    expect(tour.start).toHaveBeenCalledWith(undefined);
  });

  it('does not re-record the opt-in while the write is in flight', () => {
    useHook({ isSaving: true });
    render(<ZeroState />);

    expect(
      screen.getByRole('button', { name: 'Walk me through it' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('seeds sample data on click, and says nothing about it beforehand', async () => {
    useHook();
    const demo = useDemo();
    render(<ZeroState />);

    expect(screen.queryByTestId('zero-state-sample-data-note')).toBeNull();
    await userEvent.click(screen.getByTestId('zero-state-sample-data'));

    expect(demo.seed).toHaveBeenCalledTimes(1);
  });

  it('never carries the `disabled` attribute, in flight or otherwise', async () => {
    // The regression this exists for: while the seeder was unbuilt this control
    // shipped `disabled`, which takes it out of the tab order — a keyboard user
    // never met it and never learned the option existed. An inert state uses
    // `aria-disabled` and stays focusable instead.
    useHook();
    useDemo({ isPending: true });
    render(<ZeroState />);

    const sample = screen.getByTestId('zero-state-sample-data');
    expect(sample.hasAttribute('disabled')).toBe(false);
    expect(sample.getAttribute('aria-disabled')).toBe('true');
    sample.focus();
    expect(document.activeElement).toBe(sample);
  });

  it('states the in-flight reason in markup the control points at, and seeds only once', async () => {
    useHook();
    const demo = useDemo({ isPending: true });
    render(<ZeroState />);

    const sample = screen.getByTestId('zero-state-sample-data');
    const noteId = sample.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent).toContain('Adding sample data');

    // `aria-disabled` is still clickable — the guard is what makes it inert.
    await userEvent.click(sample);
    expect(demo.seed).not.toHaveBeenCalled();
  });

  it('says nothing about guidance while the runtime is fine', async () => {
    useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Walk me through it' }));

    expect(screen.queryByTestId('zero-state-guidance-note')).toBeNull();
  });
});

describe('ZeroState — the checklist starts the walkthrough per item', () => {
  it('runs the set for the item whose action was pressed', async () => {
    const tour = useTour();
    useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Start: Log a position' }));

    expect(tour.start).toHaveBeenCalledTimes(1);
    expect(tour.start).toHaveBeenCalledWith('position');
  });

  it('records the same opt-in a per-item start is, not a different one', async () => {
    const hook = useHook();
    render(<ZeroState />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Start: Size a trade in the calculator' }),
    );

    expect(hook.setStatus).toHaveBeenCalledWith('active');
  });

  it('offers an action for every item, a completed one included', () => {
    useHook({
      checklist: deriveChecklist({
        accountCount: 1,
        positionsEverCreatedCount: 0,
        closedPositionCount: 0,
      }),
    });
    render(<ZeroState />);

    expect(
      [...document.querySelectorAll('[data-checklist-action]')].map((el) =>
        el.getAttribute('data-checklist-action'),
      ),
    ).toEqual(['account', 'calculator', 'position', 'close']);
  });

  it('withholds the action for a set the walkthrough says cannot run', () => {
    useTour({ canStart: (id) => id === 'calculator' });
    useHook();
    render(<ZeroState />);

    expect(
      [...document.querySelectorAll('[data-checklist-action]')].map((el) =>
        el.getAttribute('data-checklist-action'),
      ),
    ).toEqual(['calculator']);
  });
});

// `useWalkthrough().start()` returns silently when the checklist names no
// outstanding item, so a click made in that window used to record `active` and
// run nothing. These pin the two states in which that is reachable from this
// screen, and the honest behaviour that replaced it.
describe('ZeroState — the guided fork with no step behind it', () => {
  it('does not offer a guided start while the checklist is still in flight', async () => {
    const tour = useTour();
    const hook = useHook({ checklist: undefined, isLoading: true });
    render(<ZeroState />);

    const button = screen.getByRole('button', { name: 'Walk me through it' });
    expect(button.getAttribute('aria-disabled')).toBe('true');

    await userEvent.click(button);

    // Nothing started AND nothing written: an opt-in recorded here would leave
    // the user `active` with no walkthrough to show for it.
    expect(tour.start).not.toHaveBeenCalled();
    expect(hook.setStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId('zero-state-guidance-note').textContent).toContain(
      'waiting for your setup checklist',
    );
  });

  it('becomes live again the moment the checklist arrives with a step outstanding', async () => {
    const tour = useTour();
    const hook = useHook();
    render(<ZeroState />);

    const button = screen.getByRole('button', { name: 'Walk me through it' });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByTestId('zero-state-guidance-note')).toBeNull();

    await userEvent.click(button);

    expect(hook.setStatus).toHaveBeenCalledWith('active');
    expect(tour.start).toHaveBeenCalledWith(undefined);
  });

  it('points a dismissed checklist at reopening it rather than starting nothing', async () => {
    const tour = useTour();
    const hook = useHook({ checklist: null, preference: preference('skipped') });
    render(<ZeroState />);

    const button = screen.getByRole('button', { name: 'Walk me through it' });
    expect(button.getAttribute('aria-disabled')).toBe('true');

    await userEvent.click(button);

    expect(tour.start).not.toHaveBeenCalled();
    expect(hook.setStatus).not.toHaveBeenCalled();
    // The route out is on screen and named, and it is the checklist's own.
    expect(screen.getByTestId('zero-state-guidance-note').textContent).toContain('Reopen');
    expect(screen.getByTestId('activation-checklist-reopen')).toBeTruthy();
  });
});

describe('ZeroState — the runtime failed to load', () => {
  it('says what happened rather than leaving a button that does nothing', () => {
    useTour({ isUnavailable: true });
    useHook();
    render(<ZeroState />);

    const note = screen.getByTestId('zero-state-guidance-note').textContent ?? '';
    expect(note).toContain('could not be loaded');
    expect(note).toContain('checklist');
  });

  it('marks the walkthrough action unavailable, keeps it focusable, and links it to the reason', async () => {
    const tour = useTour({ isUnavailable: true });
    const hook = useHook();
    render(<ZeroState />);

    const button = screen.getByRole('button', { name: 'Walk me through it' });
    // `disabled` would take the control out of the tab order, so a keyboard user
    // would never meet the option or learn why it is gone. `aria-disabled` says
    // the same thing and keeps the tab stop.
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');

    // The same join the sample-data control uses: the explanation is markup the
    // button points at, not a paragraph that happens to sit nearby.
    const noteId = button.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent).toContain('could not be loaded');

    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(button);

    // Focusable and clickable, but inert: an aria-disabled button still fires,
    // so the handler is what has to hold the line.
    await userEvent.keyboard('{Enter}');
    expect(hook.setStatus).not.toHaveBeenCalled();
    expect(tour.start).not.toHaveBeenCalled();
  });

  it('withdraws the per-item actions, and nothing else', () => {
    useTour({ isUnavailable: true });
    useHook();
    render(<ZeroState />);

    // The shortcut goes; the list, the primary action and the docs stay. That
    // is the unguided path, which is the same path every other user takes.
    expect(document.querySelectorAll('[data-checklist-action]').length).toBe(0);
    expect(document.querySelectorAll('[data-checklist-item]').length).toBe(4);
    expect(screen.getByRole('button', { name: 'Create my first account' })).toBeTruthy();
    expect(screen.getByTestId('zero-state-docs-link')).toBeTruthy();
  });
});

describe('ZeroState — what the screen says', () => {
  it('names the brokerage account as the prerequisite for everything else', () => {
    useHook();
    render(<ZeroState />);

    const text = screen.getByTestId('onboarding-zero-state').textContent ?? '';
    expect(text).toContain('Start with a brokerage account');
    expect(text).toContain('booked against one');
  });

  it('states that Tradr accounts mirror real ones but are not connected to them', () => {
    useHook();
    render(<ZeroState />);

    const statement = screen.getByTestId('zero-state-not-connected').textContent ?? '';
    expect(statement).toContain('mirrors a real brokerage account');
    expect(statement).toContain('not connected to your broker');
  });

  it('states that Tradr never places or executes trades', () => {
    useHook();
    render(<ZeroState />);

    expect(screen.getByTestId('zero-state-not-connected').textContent).toContain(
      'never places or executes trades',
    );
  });
});

describe('ZeroState — neither fork is a dead end', () => {
  it('leaves the checklist and the docs link in place after declining guidance', async () => {
    useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Walk me through it' }));

    // Both survive the choice, and so does the action that actually unblocks
    // the product — nothing on this screen is spent by taking a fork.
    expect(screen.getByTestId('activation-checklist')).toBeTruthy();
    expect(document.querySelectorAll('[data-checklist-item]').length).toBe(4);
    expect(screen.getByTestId('zero-state-docs-link')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create my first account' })).toBeTruthy();
  });

  it('leaves the checklist and the docs link in place on the unguided path', async () => {
    useHook();
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Create my first account' }));

    expect(screen.getByTestId('activation-checklist')).toBeTruthy();
    expect(screen.getByTestId('zero-state-docs-link')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Walk me through it' })).toBeTruthy();
  });

  it('keeps the docs link when the checklist itself has been dismissed', () => {
    // A dismissed checklist collapses to its own reopen row; the docs link is a
    // sibling of the checklist, not a child, so it cannot go with it.
    useHook({ checklist: null, preference: preference('skipped') });
    render(<ZeroState />);

    expect(screen.getByTestId('zero-state-docs-link')).toBeTruthy();
    expect(screen.getByTestId('activation-checklist-reopen')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create my first account' })).toBeTruthy();
  });

  it('links to the docs through docsUrl(), with the host written down nowhere here', () => {
    useHook();
    render(<ZeroState />);

    const link = screen.getByTestId('zero-state-docs-link');
    expect(link.getAttribute('href')).toBe(docsUrl('gettingStarted'));
    expect(link.getAttribute('href')?.startsWith(DOCS_BASE_URL)).toBe(true);
    // Mid-task reader: a new tab rather than losing the page they were on.
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });
});

describe('ZeroState — design-system gates', () => {
  it('carries exactly one primary (amber) action, and it is the account', () => {
    useHook();
    render(<ZeroState />);

    const primaries = [...document.querySelectorAll('button[data-variant="default"]')];
    expect(primaries.length).toBe(1);
    expect(primaries[0]?.getAttribute('data-testid')).toBe('zero-state-create-account');

    // Everything else, including the checklist's own controls, stays quiet.
    for (const button of document.querySelectorAll('button')) {
      if (button === primaries[0]) continue;
      expect(['outline', 'ghost']).toContain(button.getAttribute('data-variant'));
    }
  });

  it('does not spend a second amber on the docs link', () => {
    // ImportPage and the sidebar colour their docs links `text-primary`; those
    // surfaces have no amber button competing with them and this one does.
    useHook();
    render(<ZeroState />);

    expect(screen.getByTestId('zero-state-docs-link').className).not.toContain('text-primary');
  });

  it('puts cursor-pointer on every button and on the link', () => {
    useHook();
    render(<ZeroState />);

    for (const button of document.querySelectorAll('button')) {
      expect(button.className).toContain('cursor-pointer');
    }
    expect(screen.getByTestId('zero-state-docs-link').className).toContain('cursor-pointer');
  });

  it('uses semantic roles only — no financial-semantic tokens, no hardcoded colours', () => {
    useHook();
    render(<ZeroState />);

    const markup = screen.getByTestId('onboarding-zero-state').outerHTML;
    // gain/loss/flat mean money direction. Nothing on a welcome screen does.
    expect(markup).not.toMatch(/\b(text|bg|fill|stroke|border)-(gain|loss|flat)\b/);
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\b(text|bg)-(green|red|amber|emerald|rose|yellow)-\d{2,3}\b/);
  });

  it('holds its transitions still under prefers-reduced-motion', () => {
    useHook();
    render(<ZeroState />);

    // The hover/focus transition on the three action buttons is the only motion
    // this screen has, and it is the only thing that has to stand still.
    for (const testid of [
      'zero-state-create-account',
      'zero-state-walkthrough',
      'zero-state-sample-data',
    ]) {
      expect(screen.getByTestId(testid).className).toContain('motion-reduce:transition-none');
    }
  });

  it('is fully operable from the keyboard', async () => {
    const tour = useTour();
    const hook = useHook();
    render(<ZeroState />);

    // Space activates the primary action, and the unguided fork writes nothing.
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('zero-state-create-account');
    await userEvent.keyboard(' ');
    expect(screen.getByTestId('account-dialog')).toBeTruthy();
    expect(hook.setStatus).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('zero-state-walkthrough');
    await userEvent.keyboard('{Enter}');
    expect(hook.setStatus).toHaveBeenCalledWith('active');
    expect(tour.start).toHaveBeenCalledWith(undefined);

    // The sample-data control is a tab stop like any other — it carries no
    // `disabled` attribute, so a keyboard user meets the third option instead
    // of being skipped past it.
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('zero-state-sample-data');
    await userEvent.keyboard(' ');
    expect(hook.setStatus).toHaveBeenCalledTimes(1); // still only the walkthrough's write

    await userEvent.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss checklist');

    // Then the checklist's own per-item actions, in item order.
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-checklist-action')).toBe('account');
    await userEvent.keyboard('{Enter}');
    expect(tour.start).toHaveBeenLastCalledWith('account');

    for (const id of ['calculator', 'position', 'close']) {
      await userEvent.tab();
      expect(document.activeElement?.getAttribute('data-checklist-action')).toBe(id);
    }

    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('zero-state-docs-link');
  });
});

describe('ZeroState — mobile widths', () => {
  it('renders every part of the screen at a 320px viewport', () => {
    window.innerWidth = 320;
    useHook();
    render(<ZeroState />);

    // jsdom does not lay out, so this pins the CONTENT contract: nothing is
    // hidden or dropped at the narrowest width the app supports.
    expect(screen.getByTestId('onboarding-zero-state')).toBeTruthy();
    expect(screen.getByTestId('zero-state-not-connected')).toBeTruthy();
    expect(screen.getByTestId('zero-state-create-account')).toBeTruthy();
    expect(screen.getByTestId('zero-state-walkthrough')).toBeTruthy();
    expect(screen.getByTestId('zero-state-sample-data')).toBeTruthy();
    expect(screen.getByTestId('activation-checklist')).toBeTruthy();
    expect(screen.getByTestId('zero-state-docs-link')).toBeTruthy();
  });

  it('stacks the actions full-width below `sm` and only then puts them in a row', () => {
    useHook();
    render(<ZeroState />);

    const row = screen.getByTestId('zero-state-create-account').parentElement;
    expect(row?.className).toContain('flex-col');
    expect(row?.className).toContain('sm:flex-row');

    for (const testid of [
      'zero-state-create-account',
      'zero-state-walkthrough',
      'zero-state-sample-data',
    ]) {
      const className = screen.getByTestId(testid).className;
      expect(className).toContain('w-full');
      expect(className).toContain('sm:w-auto');
    }
  });

  it('sets no fixed or minimum width anywhere, so nothing can overflow a narrow viewport', () => {
    useHook();
    render(<ZeroState />);

    const root = screen.getByTestId('onboarding-zero-state');
    expect(root.className).toContain('w-full');
    // A max is fine — it only bites on wide screens. A fixed or minimum width
    // is what forces a horizontal scrollbar on a phone.
    expect(root.outerHTML).not.toMatch(/\bmin-w-\[/);
    expect(root.outerHTML).not.toMatch(/\bw-\[\d/);
  });
});

// The welcome view no longer retires on the first account: the dashboard keeps
// it up until the core steps are done or the user explicitly skips, so this
// screen now has a second face. These cases pin what that face says and does —
// the stage rule itself (derived item 1, so demo data cannot flip it) lives in
// the component.
describe('ZeroState — the carry-on stage, once the account exists', () => {
  function accountDoneChecklist() {
    return deriveChecklist({
      accountCount: 1,
      positionsEverCreatedCount: 0,
      closedPositionCount: 0,
    });
  }

  it('swaps the create-stage furniture for the carry-on card', () => {
    useHook({ checklist: accountDoneChecklist(), preference: preference('active') });
    render(<ZeroState />);

    expect(screen.getByText('Your account is ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue the walkthrough' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip to my dashboard' })).toBeTruthy();
    // The create-stage pieces are gone: the account exists, the seeder would
    // refuse to run beside it, and the not-connected copy has been met.
    expect(screen.queryByRole('button', { name: 'Create my first account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add sample data' })).toBeNull();
    expect(screen.queryByTestId('zero-state-not-connected')).toBeNull();
  });

  it("gives the walkthrough the stage's one amber action", () => {
    useHook({ checklist: accountDoneChecklist(), preference: preference('active') });
    render(<ZeroState />);

    expect(screen.getByTestId('zero-state-walkthrough').getAttribute('data-variant')).toBe(
      'default',
    );
    expect(screen.getByTestId('zero-state-skip-setup').getAttribute('data-variant')).toBe(
      'outline',
    );
  });

  it('continue records the opt-in and starts the first outstanding set', async () => {
    const tour = useTour();
    const hook = useHook({ checklist: accountDoneChecklist(), preference: preference('active') });
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Continue the walkthrough' }));

    expect(hook.setStatus).toHaveBeenCalledExactlyOnceWith('active');
    expect(tour.start).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("skip writes the checklist's own dismissal value, and starts nothing", async () => {
    const tour = useTour();
    const hook = useHook({ checklist: accountDoneChecklist(), preference: preference('active') });
    render(<ZeroState />);

    await userEvent.click(screen.getByRole('button', { name: 'Skip to my dashboard' }));

    expect(hook.dismiss).toHaveBeenCalledTimes(1);
    expect(tour.start).not.toHaveBeenCalled();
  });

  it('is still no dead end: the checklist and the docs link stay', () => {
    useHook({ checklist: accountDoneChecklist(), preference: preference('active') });
    render(<ZeroState />);

    expect(screen.getByTestId('activation-checklist')).toBeTruthy();
    expect(screen.getByTestId('zero-state-docs-link')).toBeTruthy();
  });

  it('a failed runtime blocks the walkthrough with its reason, and leaves the skip live', async () => {
    useTour({ isUnavailable: true });
    const hook = useHook({ checklist: accountDoneChecklist(), preference: preference('active') });
    render(<ZeroState />);

    const walkthrough = screen.getByTestId('zero-state-walkthrough');
    expect(walkthrough.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('zero-state-guidance-note')).toBeTruthy();
    await userEvent.click(walkthrough);
    expect(hook.setStatus).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Skip to my dashboard' }));
    expect(hook.dismiss).toHaveBeenCalledTimes(1);
  });
});
