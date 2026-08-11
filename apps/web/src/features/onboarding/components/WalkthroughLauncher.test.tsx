// @vitest-environment jsdom
//
// THE CLAIM UNDER TEST IS "PERMANENT". The activation checklist retires when
// all four items are complete, and it must — the `status: 'done'` write it makes
// is what switches the two expensive onboarding reads off. This card is what a
// user has left afterwards, so the tests below are written from the seat of a
// user whose checklist has already gone: all four sets are still offered, they
// still start, and reaching them costs the server nothing and changes nothing.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState } from '@tradr/shared';

import { api } from '@/lib/api';

import { __resetWalkthroughForTests, useWalkthroughStore } from '../hooks/useWalkthrough';
import { WALKTHROUGH_STEPS, type WalkthroughStep } from '../lib/steps';
import type { TourHandlers } from '../lib/tour-engine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

// Only the one call that would put an overlay on screen is a double; the rest of
// the engine is real, so the launcher is driving the same runtime the checklist
// drives.
const startTour = vi.fn();
vi.mock('../lib/tour-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/tour-engine')>();
  return {
    ...real,
    startTour: (steps: WalkthroughStep[], handlers?: TourHandlers) => startTour(steps, handlers),
  };
});

import { WalkthroughLauncher } from './WalkthroughLauncher';

/**
 * A retired user, as the server would report them. Nothing below should ever
 * ask for it — that is the point of case 2 — but a spy that answers correctly is
 * the honest way to prove the question was never put.
 */
const RETIRED: OnboardingState = { status: 'done', coachMarksSeen: [] };

function renderLauncher() {
  const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path === '/users/me/onboarding') return Promise.resolve(RETIRED) as never;
    if (path === '/accounts' || path === '/positions') return Promise.resolve([]) as never;
    return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
  });
  const patch = vi.spyOn(api, 'patch').mockResolvedValue(RETIRED as never);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <WalkthroughLauncher />
    </QueryClientProvider>,
  );
  return { get, patch };
}

afterEach(() => {
  cleanup();
  __resetWalkthroughForTests();
  vi.restoreAllMocks();
  navigate.mockReset();
  startTour.mockReset();
});

describe('WalkthroughLauncher — the entry point that outlives the checklist', () => {
  it('offers all four sets, in the checklist order, to a user who has retired', () => {
    renderLauncher();

    const rows = [...document.querySelectorAll('[data-walkthrough-set]')];
    expect(rows.map((el) => el.getAttribute('data-walkthrough-set'))).toEqual([
      'account',
      'calculator',
      'position',
      'close',
    ]);
    // Named, not just present: four buttons all reading "Start" would be four
    // unnamed controls to a screen reader.
    expect(screen.getByRole('button', { name: 'Start walkthrough: Log a position' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Start walkthrough: Close it and see the stats' }),
    ).toBeTruthy();
  });

  it('asks the server nothing — the retired user’s read gate stays shut', async () => {
    const { get, patch } = renderLauncher();

    await userEvent.click(
      screen.getByRole('button', { name: 'Start walkthrough: Size a trade in the calculator' }),
    );
    await waitFor(() => expect(startTour).toHaveBeenCalled());

    // Not "no expensive read" but no read AT ALL, including the cheap
    // preference one. The card offers every set to everybody, so it has no
    // question to put — and a version of it built on a hook that reads
    // onboarding state would fail here, which is exactly what this pins.
    expect(get).not.toHaveBeenCalled();
    // And no write. The other two doors into the walkthrough record the opt-in
    // with `status: 'active'`; doing that here would un-retire the user — both
    // gated reads back on, and the checklist back on their dashboard — for
    // asking to see a walkthrough again.
    expect(patch).not.toHaveBeenCalled();
  });

  it('starts the set that was asked for, and navigates to where it opens', async () => {
    renderLauncher();

    await userEvent.click(
      screen.getByRole('button', { name: 'Start walkthrough: Log a position' }),
    );

    await waitFor(() => expect(startTour).toHaveBeenCalledTimes(1));
    const [steps] = startTour.mock.calls[0] as [WalkthroughStep[]];
    expect(steps.map((step) => step.title)).toEqual(
      WALKTHROUGH_STEPS.position.map((step) => step.title),
    );
    expect(useWalkthroughStore.getState().itemId).toBe('position');
    // The position set opens on `/positions`, and the user pressed this from
    // Settings — so the launcher is what has to get them there.
    expect(navigate).toHaveBeenCalledWith({ to: '/positions' });
  });

  it('offers the two action-gated sets on the same terms as the rest', async () => {
    renderLauncher();

    // `close` is the set the checklist withholds unless the user has an open
    // position of their own, because it opens on one. This card cannot know
    // that and does not ask: it starts the set, and a set that then cannot
    // carry on says so itself.
    await userEvent.click(
      screen.getByRole('button', { name: 'Start walkthrough: Close it and see the stats' }),
    );

    await waitFor(() => expect(startTour).toHaveBeenCalledTimes(1));
    expect(useWalkthroughStore.getState().itemId).toBe('close');
  });

  it('withdraws the buttons, with a reason, when the tour runtime will not load', () => {
    useWalkthroughStore.setState({ isUnavailable: true });
    renderLauncher();

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByTestId('walkthrough-launcher-unavailable')).toBeTruthy();
  });
});
