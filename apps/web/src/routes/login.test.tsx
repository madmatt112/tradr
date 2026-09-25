// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { Route as LoginRoute } from './login';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTICE = 'Your account was deleted.';

// A browser history, not a memory one: login.tsx reads the deleted flag off
// window.location, so the URL under assertion has to be the real one.
/* eslint-disable @typescript-eslint/no-explicit-any */
function buildRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: (LoginRoute.options as any).component,
  });
  // The form links to both; they only need to exist for the links to build.
  const register = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/register',
    component: () => null,
  });
  const forgotPassword = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/forgot-password',
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([login, register, forgotPassword]);
  return createRouter({ routeTree: routeTree as any, history: createBrowserHistory() });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let fetchSpy: MockInstance;

beforeEach(() => {
  // useRegistrationEnabled reads /config on mount; answer it so nothing throws.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ registrationEnabled: true, advisorEnabled: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  window.history.replaceState(null, '', '/');
});

function renderLogin() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = buildRouter();
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('login page — deleted-account notice', () => {
  it('shows a muted notice on /login?deleted=true, never text-destructive', async () => {
    window.history.replaceState(null, '', '/login?deleted=true');
    renderLogin();

    const notice = await screen.findByText(NOTICE);
    // Deletion is not an error: muted, not the expiry's destructive styling.
    expect(notice.className).toContain('text-muted-foreground');
    expect(notice.className).not.toContain('text-destructive');
  });

  it('shows no deleted notice on a plain /login', async () => {
    window.history.replaceState(null, '', '/login');
    renderLogin();

    expect(
      await screen.findByText('Log in', { selector: '[data-slot="card-title"]' }),
    ).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
