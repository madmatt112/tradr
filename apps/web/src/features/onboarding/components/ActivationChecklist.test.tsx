// @vitest-environment jsdom
//
// The hook is faked wholesale. This file is about what the component does with
// the three checklist values, and the hook's own behaviour (three composed
// reads, the derivation, the PATCH round trip) already has 22 tests of its own
// in hooks/useOnboarding.test.ts. Faking it here keeps the two suites from
// re-testing each other.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState, OnboardingStatus } from '@tradr/shared';

import { useOnboarding, type UseOnboardingResult } from '../hooks/useOnboarding';
import { deriveChecklist, type ChecklistItemId } from '../lib/derive-checklist';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useOnboarding', () => ({ useOnboarding: vi.fn() }));

import { ActivationChecklist, resolveChecklistView } from './ActivationChecklist';

const mockUseOnboarding = vi.mocked(useOnboarding);

function preference(status: OnboardingStatus): OnboardingState {
  return { status, coachMarksSeen: [] };
}

/** The REAL derivation — the component must never disagree with it. */
function checklistOf(over: Partial<Parameters<typeof deriveChecklist>[0]> = {}) {
  return deriveChecklist({
    accountCount: 0,
    positionsEverCreatedCount: 0,
    closedPositionCount: 0,
    ...over,
  });
}

const ALL_DONE = {
  accountCount: 1,
  positionsEverCreatedCount: 1,
  closedPositionCount: 1,
  calculatorFirstUsedAt: '2026-08-06T00:00:00.000Z',
};

function useHook(over: Partial<UseOnboardingResult> = {}): UseOnboardingResult {
  const value: UseOnboardingResult = {
    checklist: undefined,
    preference: undefined,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ActivationChecklist — the four items, in their fixed order', () => {
  it('renders exactly four items, in the derivation order', () => {
    useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist />);

    const items = [...document.querySelectorAll('[data-checklist-item]')];
    expect(items.map((el) => el.getAttribute('data-checklist-item'))).toEqual([
      'account',
      'calculator',
      'position',
      'close',
    ]);
    expect(items.map((el) => el.textContent)).toEqual([
      'Create a brokerage account — not completed',
      'Size a trade in the calculator — not completed',
      'Log a position — not completed',
      'Close it and see the stats — not completed',
    ]);
  });

  it('reflects per-item completion derived upstream, not recomputed here', () => {
    // Deliberately out of order: an account-less user who imported closed
    // positions by CSV is a legitimate state — the items do not gate on each
    // other — so the component must render whatever the derivation says rather
    // than assume a sequence.
    useHook({
      checklist: checklistOf({ positionsEverCreatedCount: 3, closedPositionCount: 3 }),
      preference: preference('active'),
    });
    render(<ActivationChecklist />);

    const done = [...document.querySelectorAll('[data-checklist-item]')].map((el) =>
      el.textContent?.includes('— completed'),
    );
    expect(done).toEqual([false, false, true, true]);
  });

  it('stays visible with item 1 incomplete when only demo data is present', () => {
    // Demo seeding gives positions but no account the user created, so the
    // hook's account count is still 0 and item 1 is still open.
    useHook({
      checklist: checklistOf({ positionsEverCreatedCount: 5 }),
      preference: preference('pending'),
    });
    render(<ActivationChecklist />);

    expect(screen.getByTestId('activation-checklist')).toBeTruthy();
    expect(document.querySelector('[data-checklist-item="account"]')?.textContent).toContain(
      '— not completed',
    );
  });

  it('reports progress as a count, so completion never rests on colour alone', () => {
    useHook({
      checklist: checklistOf({ accountCount: 1, positionsEverCreatedCount: 1 }),
      preference: preference('active'),
    });
    render(<ActivationChecklist />);

    expect(screen.getByTestId('activation-checklist-progress').textContent).toBe('2 of 4 complete');
  });
});

describe('ActivationChecklist — undefined vs null are different answers', () => {
  it('renders a skeleton while the checklist is not known yet, never four unticked boxes', () => {
    // The status is KNOWN to be one that still shows a checklist; only the two
    // gated reads behind it are outstanding. That is the one case a skeleton is
    // honest, because it is going to resolve into a card.
    useHook({ checklist: undefined, preference: preference('pending'), isLoading: true });
    render(<ActivationChecklist />);

    expect(screen.getByTestId('activation-checklist-loading')).toBeTruthy();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    expect(document.querySelectorAll('[data-checklist-item]').length).toBe(0);
    // Not the dismissed footprint either — nothing has been dismissed.
    expect(screen.queryByTestId('activation-checklist-reopen')).toBeNull();
  });

  it('renders a skeleton for an `active` user whose gated reads are in flight', () => {
    useHook({ checklist: undefined, preference: preference('active'), isLoading: true });
    render(<ActivationChecklist />);

    expect(screen.getByTestId('activation-checklist-loading')).toBeTruthy();
  });

  it('occupies no space at all while the status itself is unknown', () => {
    // The preference read has not landed, so `undefined` here does NOT mean "a
    // checklist is loading" — it means we do not yet know whether this user
    // gets one. Most do not. A skeleton would paint a four-row card on every
    // established user's dashboard and then collapse it: a layout jump on the
    // primary screen, which the design system forbids of a loading state.
    useHook({ checklist: undefined, preference: undefined, isLoading: true });
    const { container } = render(<ActivationChecklist />);

    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
    expect(screen.queryByTestId('activation-checklist-reopen')).toBeNull();
    // Not merely invisible — no node, so no box, so nothing to reflow when the
    // status lands and the real answer takes its place.
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing — not a skeleton — for a gated-off `done` user', () => {
    useHook({ checklist: null, preference: preference('done') });
    const { container } = render(<ActivationChecklist />);

    // A skeleton here would spin forever: the reads it waits on are never sent.
    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders the reopen affordance — not a skeleton — for a `skipped` user', () => {
    useHook({ checklist: null, preference: preference('skipped') });
    render(<ActivationChecklist />);

    expect(screen.getByTestId('activation-checklist-reopen')).toBeTruthy();
    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
    expect(screen.queryByTestId('activation-checklist')).toBeNull();
  });

  it('renders nothing on a terminal read failure', () => {
    // `checklist` is undefined on error too, but an unticked box we cannot
    // substantiate is worse than no box — and a skeleton would never resolve.
    // The preference is present so this exercises the error branch itself, not
    // the status-unknown gate that sits behind it.
    useHook({ checklist: undefined, preference: preference('active'), isError: true });
    const { container } = render(<ActivationChecklist />);

    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('activation-checklist-loading')).toBeNull();
  });
});

describe('ActivationChecklist — dismissal round-trips and is recoverable', () => {
  it('calls dismiss from the dismiss control', async () => {
    const hook = useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss checklist' }));

    expect(hook.dismiss).toHaveBeenCalledTimes(1);
  });

  it('round-trips: dismissed -> reopen affordance -> active', async () => {
    const first = useHook({ checklist: checklistOf(), preference: preference('pending') });
    const { rerender } = render(<ActivationChecklist />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss checklist' }));
    expect(first.dismiss).toHaveBeenCalledTimes(1);

    // What the hook reports once `status: 'skipped'` has landed: the gated
    // reads are off, so the checklist is `null`.
    const dismissed = useHook({ checklist: null, preference: preference('skipped') });
    rerender(<ActivationChecklist />);

    const reopen = screen.getByRole('button', { name: /reopen setup checklist/i });
    await userEvent.click(reopen);
    expect(dismissed.setStatus).toHaveBeenCalledWith('active');

    // And the checklist comes back with its items intact — nothing was lost,
    // because no progress was ever stored.
    useHook({ checklist: checklistOf({ accountCount: 1 }), preference: preference('active') });
    rerender(<ActivationChecklist />);
    expect(document.querySelectorAll('[data-checklist-item]').length).toBe(4);
    expect(screen.queryByTestId('activation-checklist-reopen')).toBeNull();
  });

  it('disables both write controls while a preference write is in flight', () => {
    useHook({ checklist: checklistOf(), preference: preference('pending'), isSaving: true });
    const { rerender } = render(<ActivationChecklist />);
    expect(screen.getByRole('button', { name: 'Dismiss checklist' }).hasAttribute('disabled')).toBe(
      true,
    );

    useHook({ checklist: null, preference: preference('skipped'), isSaving: true });
    rerender(<ActivationChecklist />);
    expect(
      screen.getByRole('button', { name: /reopen setup checklist/i }).hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('ActivationChecklist — retirement', () => {
  it('stops rendering and persists `done` when all four are complete', () => {
    const hook = useHook({ checklist: checklistOf(ALL_DONE), preference: preference('active') });
    const { container } = render(<ActivationChecklist />);

    expect(container.textContent).toBe('');
    expect(hook.setStatus).toHaveBeenCalledTimes(1);
    expect(hook.setStatus).toHaveBeenCalledWith('done');
  });

  it('writes `done` only once across re-renders while the status catches up', () => {
    const hook = useHook({
      checklist: checklistOf(ALL_DONE),
      preference: preference('active'),
      isSaving: true,
    });
    const { rerender } = render(<ActivationChecklist />);
    rerender(<ActivationChecklist />);
    rerender(<ActivationChecklist />);

    expect(hook.setStatus).toHaveBeenCalledTimes(1);
  });

  it('does not write `done` while any item is outstanding', () => {
    const hook = useHook({
      checklist: checklistOf({ accountCount: 1, positionsEverCreatedCount: 1 }),
      preference: preference('active'),
    });
    render(<ActivationChecklist />);

    expect(hook.setStatus).not.toHaveBeenCalled();
  });

  it('leaves no reopen affordance behind — retirement is permanent', () => {
    useHook({ checklist: null, preference: preference('done') });
    render(<ActivationChecklist />);

    expect(screen.queryByTestId('activation-checklist-reopen')).toBeNull();
  });
});

describe('ActivationChecklist — per-item action', () => {
  it('fires onStartStep with that item id', async () => {
    const onStartStep = vi.fn<(id: ChecklistItemId) => void>();
    useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist onStartStep={onStartStep} />);

    await userEvent.click(screen.getByRole('button', { name: 'Start: Log a position' }));

    expect(onStartStep).toHaveBeenCalledTimes(1);
    expect(onStartStep).toHaveBeenCalledWith('position');
  });

  // THE COMPLETED ITEM IS THE POINT OF THIS ONE. Its button used to be withdrawn
  // on completion, which took the walkthrough's per-item door away at exactly
  // the moment the user left the zero-state — the only other door — and left the
  // later sets with no entry point at all. Guidance is repeatable; progress is
  // what the tick is for.
  it('offers an action for every item, a completed one included', () => {
    useHook({ checklist: checklistOf({ accountCount: 1 }), preference: preference('pending') });
    render(<ActivationChecklist onStartStep={vi.fn()} />);

    const actions = [...document.querySelectorAll('[data-checklist-action]')].map((el) =>
      el.getAttribute('data-checklist-action'),
    );
    expect(actions).toEqual(['account', 'calculator', 'position', 'close']);
  });

  it('withholds the action for a set that cannot run from here', () => {
    useHook({ checklist: checklistOf({ accountCount: 1 }), preference: preference('pending') });
    render(<ActivationChecklist onStartStep={vi.fn()} canStartStep={(id) => id !== 'account'} />);

    const actions = [...document.querySelectorAll('[data-checklist-action]')].map((el) =>
      el.getAttribute('data-checklist-action'),
    );
    expect(actions).toEqual(['calculator', 'position', 'close']);
    // And the item itself is untouched: it is the shortcut that is unavailable,
    // not the step.
    expect(document.querySelectorAll('[data-checklist-item]').length).toBe(4);
  });

  // An icon with no accessible name is four unnamed buttons to a screen reader,
  // one per row, and the word "Start" next to the item's own label read as a
  // second label competing with it.
  it('names the play button for a screen reader and shows only the icon', () => {
    useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist onStartStep={vi.fn()} />);

    const action = screen.getByRole('button', { name: 'Start: Log a position' });
    expect(action.textContent).toBe('');
    expect(action.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders no dead buttons when no handler is supplied', () => {
    useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist />);

    expect(document.querySelectorAll('[data-checklist-action]').length).toBe(0);
    expect(document.querySelectorAll('[data-checklist-item]').length).toBe(4);
  });
});

describe('ActivationChecklist — keyboard and design-system gates', () => {
  it('is fully operable from the keyboard', async () => {
    const onStartStep = vi.fn<(id: ChecklistItemId) => void>();
    const hook = useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist onStartStep={onStartStep} />);

    // Tab order: dismiss (in the header) first, then each item's action.
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss checklist');
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-checklist-action')).toBe('account');

    await userEvent.keyboard('{Enter}');
    expect(onStartStep).toHaveBeenCalledWith('account');

    await userEvent.keyboard(' ');
    expect(onStartStep).toHaveBeenCalledTimes(2);

    // And the dismiss control activates from the keyboard too.
    await userEvent.tab({ shift: true });
    await userEvent.keyboard('{Enter}');
    expect(hook.dismiss).toHaveBeenCalledTimes(1);
  });

  it('puts cursor-pointer on every button', () => {
    useHook({ checklist: checklistOf(), preference: preference('pending') });
    const { rerender } = render(<ActivationChecklist onStartStep={vi.fn()} />);
    for (const button of document.querySelectorAll('button')) {
      expect(button.className).toContain('cursor-pointer');
    }

    useHook({ checklist: null, preference: preference('skipped') });
    rerender(<ActivationChecklist />);
    for (const button of document.querySelectorAll('button')) {
      expect(button.className).toContain('cursor-pointer');
    }
  });

  it('never colours completion with the gain/loss financial tokens', () => {
    useHook({
      checklist: checklistOf({ accountCount: 1, positionsEverCreatedCount: 1 }),
      preference: preference('active'),
    });
    render(<ActivationChecklist />);

    const markup = screen.getByTestId('activation-checklist').outerHTML;
    // Money direction only — a green tick borrowing `gain` would read as P&L.
    expect(markup).not.toMatch(/\b(text|bg|fill|stroke|border)-(gain|loss|flat)\b/);
    expect(markup).toContain('text-success');
    // No hardcoded colours: every colour is a semantic role.
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\b(text|bg)-(green|red|emerald|rose)-\d{2,3}\b/);
  });

  it('carries no primary (amber) action — the zero-state owns the one per view', () => {
    useHook({ checklist: checklistOf(), preference: preference('pending') });
    render(<ActivationChecklist onStartStep={vi.fn()} />);

    for (const button of document.querySelectorAll('button')) {
      expect(button.getAttribute('data-variant')).toBe('ghost');
    }
  });

  it('holds its animation still under prefers-reduced-motion', () => {
    useHook({ checklist: undefined, preference: preference('pending'), isLoading: true });
    render(<ActivationChecklist />);

    for (const el of document.querySelectorAll('[data-slot="skeleton"]')) {
      expect(el.className).toContain('motion-reduce:animate-none');
    }
  });
});

// ---------------------------------------------------------------------------
// `resolveChecklistView` — the one statement of which of the four things the
// checklist shows. The route reads it too (to tell the grid whether to make
// room), so it is pinned here against the same cases the component is.
// ---------------------------------------------------------------------------

describe('resolveChecklistView', () => {
  it('answers `card` for an outstanding checklist and `none` for a finished one', () => {
    expect(
      resolveChecklistView({
        checklist: checklistOf(),
        preference: preference('pending'),
        isError: false,
      }),
    ).toBe('card');
    expect(
      resolveChecklistView({
        checklist: checklistOf(ALL_DONE),
        preference: preference('active'),
        isError: false,
      }),
    ).toBe('none');
  });

  it('answers `loading` only once the status is known and the reads are still out', () => {
    expect(
      resolveChecklistView({
        checklist: undefined,
        preference: preference('pending'),
        isError: false,
      }),
    ).toBe('loading');
    expect(
      resolveChecklistView({ checklist: undefined, preference: undefined, isError: false }),
    ).toBe('none');
    expect(
      resolveChecklistView({
        checklist: undefined,
        preference: preference('pending'),
        isError: true,
      }),
    ).toBe('none');
  });

  it('answers `reopen` for a dismissal and `none` for a retirement', () => {
    expect(
      resolveChecklistView({ checklist: null, preference: preference('skipped'), isError: false }),
    ).toBe('reopen');
    expect(
      resolveChecklistView({ checklist: null, preference: preference('done'), isError: false }),
    ).toBe('none');
  });

  it('agrees with the component on every case', () => {
    const cases = [
      { checklist: checklistOf(), preference: preference('pending') },
      { checklist: checklistOf(ALL_DONE), preference: preference('active') },
      { checklist: undefined, preference: preference('pending') },
      { checklist: undefined, preference: undefined },
      { checklist: null, preference: preference('skipped') },
      { checklist: null, preference: preference('done') },
    ] as const;
    const testIdFor = {
      card: 'activation-checklist',
      loading: 'activation-checklist-loading',
      reopen: 'activation-checklist-reopen',
    } as const;
    for (const c of cases) {
      useHook({ ...c });
      const { unmount } = render(<ActivationChecklist />);
      const view = resolveChecklistView({ ...c, isError: false });
      for (const [name, testId] of Object.entries(testIdFor)) {
        expect(screen.queryByTestId(testId) !== null, `${name} for ${JSON.stringify(c)}`).toBe(
          view === name,
        );
      }
      unmount();
    }
  });
});
