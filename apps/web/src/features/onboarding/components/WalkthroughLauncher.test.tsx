// @vitest-environment jsdom
//
// THE CLAIM UNDER TEST IS "PERMANENT". The activation checklist retires when
// all four items are complete, and it must — the `status: 'done'` write it makes
// is what switches the two expensive onboarding reads off. This card is what a
// user has left afterwards, so the tests below are written from the seat of a
// user whose checklist has already gone: all four sets are still offered, the
// ones that can run do, the ones that cannot say so, and rendering the card
// costs the server nothing and changes nothing.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState } from '@tradr/shared';

import { Toaster } from '@/components/ui/sonner';
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
 * ask for it — that is the point of the read-gate case — but a spy that answers
 * correctly is the honest way to prove the question was never put.
 */
const RETIRED: OnboardingState = { status: 'done', coachMarksSeen: [] };

/** An account the user made, and one open position booked against it. */
const OWN_ACCOUNT = { id: 'acct-own', isDemo: false };
const OWN_OPEN = { id: 'pos-own', accountId: 'acct-own', status: 'open' };

/**
 * The card, with the two lists the server would answer with. They are supplied
 * per test because what the user HAS is the whole question three of these sets
 * turn on.
 */
function renderLauncher(
  data: { accounts?: unknown[]; positions?: unknown[] } = {
    accounts: [OWN_ACCOUNT],
    positions: [OWN_OPEN],
  },
) {
  const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path === '/users/me/onboarding') return Promise.resolve(RETIRED) as never;
    if (path === '/accounts') return Promise.resolve(data.accounts ?? []) as never;
    if (path === '/positions') return Promise.resolve(data.positions ?? []) as never;
    return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
  });
  const patch = vi.spyOn(api, 'patch').mockResolvedValue(RETIRED as never);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <WalkthroughLauncher />
      <Toaster />
    </QueryClientProvider>,
  );
  return { get, patch };
}

function startSet(label: string) {
  return userEvent.click(screen.getByRole('button', { name: `Start walkthrough: ${label}` }));
}

afterEach(() => {
  // sonner's queue is module-scoped, so a notice raised in one test would still
  // be there for the next one's toaster to render.
  toast.dismiss();
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

  it('asks the server nothing to render — the retired user’s read gate stays shut', async () => {
    const { get, patch } = renderLauncher();

    // Not "no expensive read" but no read AT ALL, including the cheap preference
    // one. Mounting the card puts no question to the server, which is what lets
    // it live on an ordinary settings screen; a version built on a hook that
    // reads onboarding state would fail here.
    await waitFor(() => expect(screen.getByTestId('walkthrough-launcher')).toBeTruthy());
    expect(get).not.toHaveBeenCalled();
    // And no write. The other two doors into the walkthrough record the opt-in
    // with `status: 'active'`; doing that here would un-retire the user — both
    // gated reads back on, and the checklist back on their dashboard — for
    // asking to see a walkthrough again.
    expect(patch).not.toHaveBeenCalled();
  });

  it('starts the set that was asked for, and navigates to where it opens', async () => {
    renderLauncher();

    await startSet('Log a position');

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

  /**
   * THE SET THAT OPENS ON A POSITION GETS ONE, WHICH IS THE WHOLE OF THIS FIX.
   *
   * `close` starts on `/positions/$positionId`, and nobody pressing a button in
   * Settings can name that row. Without an id the set navigated nowhere, waited
   * out its first step against a screen that has none of its controls, and
   * disappeared — a button that did nothing. The checklist path had already
   * solved this by falling back to the user's own most recently touched open
   * position; this reads the same lists to answer the same question, only from
   * the click rather than from a mounted hook.
   */
  it('opens the close set on the user’s own open position', async () => {
    renderLauncher();

    await startSet('Close it and see the stats');

    await waitFor(() => expect(startTour).toHaveBeenCalledTimes(1));
    expect(useWalkthroughStore.getState().itemId).toBe('close');
    expect(navigate).toHaveBeenCalledWith({
      to: '/positions/$positionId',
      params: { positionId: OWN_OPEN.id },
    });
  });

  /**
   * The sample account's rows are not the user's, on the checklist's own terms —
   * `selectOwnRows`. Closing one of the fixture's positions would teach the right
   * gesture and tick nothing, so the set is refused rather than run over data the
   * user did not create.
   */
  it('will not open the close set on the sample account’s position', async () => {
    renderLauncher({
      accounts: [{ id: 'acct-demo', isDemo: true }],
      positions: [{ id: 'pos-demo', accountId: 'acct-demo', status: 'open' }],
    });

    await startSet('Close it and see the stats');

    expect(await screen.findByText('That walkthrough cannot start yet')).toBeTruthy();
    expect(startTour).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  /**
   * A SET THAT CANNOT BEGIN SAYS SO, AND SAYS SOMETHING TRUE.
   *
   * The account set is a tour of the zero-state, which the dashboard renders only
   * while the user has no accounts — so for the retired user this card exists for
   * it has no first step to show. It used to navigate them off Settings to a
   * dashboard that showed nothing and then tell them to go back to the setup
   * checklist, the one surface that has certainly retired.
   */
  it('explains the account set instead of walking a settled user into nothing', async () => {
    renderLauncher();

    await startSet('Create a brokerage account');

    const notice = await screen.findByText('That walkthrough cannot start yet');
    expect(notice).toBeTruthy();
    const why = await screen.findByText(/tour of the welcome screen/);
    expect(why.textContent).toContain('Accounts in the sidebar');
    // The remedy names somewhere that still exists for this user.
    expect(why.textContent).not.toContain('checklist');
    // Nothing started, and — the other half of the complaint — the user is still
    // where they pressed the button.
    expect(startTour).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  /**
   * The click may read the two lists, because the user asked for a walkthrough
   * and one of the sets opens on a row only those lists can name. It must not
   * reach for the onboarding PREFERENCE: that is the value the retirement gate is
   * keyed on, and this card must never have an opinion about it.
   */
  it('reads only the two lists when a set is started, and never the preference', async () => {
    const { get, patch } = renderLauncher();

    await startSet('Size a trade in the calculator');
    await waitFor(() => expect(startTour).toHaveBeenCalled());

    expect(get.mock.calls.map(([path]) => path).sort()).toEqual(['/accounts', '/positions']);
    expect(patch).not.toHaveBeenCalled();
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
