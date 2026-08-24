// @vitest-environment jsdom
/* eslint-disable import-x/order */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Mocks ----------------------------------------------------------------

// useAuth — the Account tab calls logout.mutate(). Expose the spy so case 3 asserts it.
const logoutMutate = vi.fn();
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logout: { mutate: logoutMutate, isPending: false } }),
}));

// The Profile tab pulls in the FX components, which fetch on mount; stub them out so
// the layout tests stay focused on routing/tabs (they are not under test here).
vi.mock('@/features/accounting/components/DisplayCurrencySelect', () => ({
  DisplayCurrencySelect: () => <div data-slot="display-currency" />,
}));
vi.mock('@/features/accounting/components/ExchangeRatesPage', () => ({
  ExchangeRatesPage: () => <div data-slot="exchange-rates" />,
}));

// The instance posture (GET /api/config), switchable per test: the Advisor tab
// and the `/settings` default redirect both follow it.
const posture = { advisorEnabled: true };
vi.mock('@/hooks/useRegistrationEnabled', () => ({
  useAdvisorEnabled: () => posture.advisorEnabled,
  useRegistrationEnabled: () => ({ registrationEnabled: true, isPending: false }),
  isAdvisorEnabledForRoute: async () => posture.advisorEnabled,
}));

import { Route as SettingsLayoutRoute } from '../_auth.settings';
import { Route as AdvisorRoute } from '../_auth.settings.advisor';
import { Route as ProfileRoute } from '../_auth.settings.profile';
import { Route as AccountRoute } from '../_auth.settings.account';
import { Route as HelpRoute } from '../_auth.settings.help';

// The real routes are typed against the app's route registration; re-hosting
// them under a fresh root requires loosening those option types.
/* eslint-disable @typescript-eslint/no-explicit-any */
const layoutOpts = SettingsLayoutRoute.options as any;
const advisorOpts = AdvisorRoute.options as any;
const profileOpts = ProfileRoute.options as any;
const accountOpts = AccountRoute.options as any;
const helpOpts = HelpRoute.options as any;

// ---- Test router ----------------------------------------------------------
// Re-host the real Settings routes under a fresh root so we can exercise the
// layout's Outlet, the tab Links, and the `/settings` → `/settings/advisor`
// beforeLoad redirect with an in-memory history.

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();

  const settingsLayout = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/settings',
    beforeLoad: layoutOpts.beforeLoad,
    component: layoutOpts.component,
  });
  const advisor = createRoute({
    getParentRoute: () => settingsLayout as any,
    path: '/advisor',
    component: advisorOpts.component,
  });
  const profile = createRoute({
    getParentRoute: () => settingsLayout as any,
    path: '/profile',
    validateSearch: profileOpts.validateSearch,
    component: profileOpts.component,
  });
  const account = createRoute({
    getParentRoute: () => settingsLayout as any,
    path: '/account',
    component: accountOpts.component,
  });

  const help = createRoute({
    getParentRoute: () => settingsLayout as any,
    path: '/help',
    component: helpOpts.component,
  });
  // A stub, not the real Billing tab (which polls the tier): it exists only as
  // the redirect target when the advisor is withdrawn.
  const billing = createRoute({
    getParentRoute: () => settingsLayout as any,
    path: '/billing',
    component: () => <div data-testid="billing-stub" />,
  });

  const routeTree = rootRoute.addChildren([
    settingsLayout.addChildren([advisor, billing, profile, account, help]),
  ]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function renderAt(initialPath: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = buildRouter(initialPath);
  const result = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router, ...result };
}

afterEach(() => {
  cleanup();
  logoutMutate.mockClear();
  posture.advisorEnabled = true;
});

// ---- Tests ----------------------------------------------------------------

describe('Settings tabbed layout', () => {
  it('case 1: renders the three tab triggers (Advisor, Profile, Account)', async () => {
    renderAt('/settings/advisor');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Advisor/i })).toBeTruthy();
    });
    expect(screen.getByRole('tab', { name: /Profile/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Account/i })).toBeTruthy();
  });

  it('case 2: navigating to /settings redirects to /settings/advisor', async () => {
    const { router } = renderAt('/settings');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/advisor');
    });
    expect(screen.getByText('Manage provider keys and personas for the AI advisor.')).toBeTruthy();
  });

  // DISABLE_ADVISOR: the tab goes with the advisor, and `/settings` no longer
  // lands on a tab the instance does not show.
  it('case 2b: with the advisor withdrawn, the tab is absent and /settings picks the next tab', async () => {
    posture.advisorEnabled = false;
    const { router } = renderAt('/settings');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/billing');
    });
    expect(screen.queryByRole('tab', { name: /Advisor/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /Profile/i })).toBeTruthy();
  });

  it('case 3: Account tab Logout button calls logout.mutate', async () => {
    renderAt('/settings/account');
    const btn = await screen.findByRole('button', { name: /Log out/i });
    fireEvent.click(btn);
    expect(logoutMutate).toHaveBeenCalledTimes(1);
  });

  // The walkthrough's permanent door. Every other one is temporary — the
  // zero-state goes with the first account, and the activation checklist retires
  // when all four items are complete — so it has to be reachable from a tab that
  // is always there, for a user who has no checklist left.
  it('case 4: the Help tab is reachable and offers all four walkthrough sets', async () => {
    renderAt('/settings/advisor');

    const tab = await screen.findByRole('tab', { name: /Help/i });
    fireEvent.click(tab.querySelector('a') ?? tab);

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-launcher')).toBeTruthy();
    });
    const sets = [...document.querySelectorAll('[data-walkthrough-set]')];
    expect(sets.map((el) => el.getAttribute('data-walkthrough-set'))).toEqual([
      'account',
      'calculator',
      'position',
      'close',
    ]);
  });
});
