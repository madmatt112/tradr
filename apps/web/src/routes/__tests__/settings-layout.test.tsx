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

import { Route as SettingsLayoutRoute } from '../_auth.settings';
import { Route as AdvisorRoute } from '../_auth.settings.advisor';
import { Route as ProfileRoute } from '../_auth.settings.profile';
import { Route as AccountRoute } from '../_auth.settings.account';

// The real routes are typed against the app's route registration; re-hosting
// them under a fresh root requires loosening those option types.
/* eslint-disable @typescript-eslint/no-explicit-any */
const layoutOpts = SettingsLayoutRoute.options as any;
const advisorOpts = AdvisorRoute.options as any;
const profileOpts = ProfileRoute.options as any;
const accountOpts = AccountRoute.options as any;

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

  const routeTree = rootRoute.addChildren([
    settingsLayout.addChildren([advisor, profile, account]),
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

  it('case 3: Account tab Logout button calls logout.mutate', async () => {
    renderAt('/settings/account');
    const btn = await screen.findByRole('button', { name: /Log out/i });
    fireEvent.click(btn);
    expect(logoutMutate).toHaveBeenCalledTimes(1);
  });
});
