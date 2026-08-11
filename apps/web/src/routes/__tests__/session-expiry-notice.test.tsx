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
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { api, markSessionEnded, markSessionStarted, setRouter } from '@/lib/api';

import { Route as LoginRoute } from '../login';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTICE = 'Session expired. Please log in again.';

// THE WRITER AND THE READER, IN ONE PASS.
//
// The notice is a handshake between two files that never see each other:
// lib/api's 401 interception writes the `expired` search param onto /login, and
// login.tsx reads it back off the URL. Neither looks wrong alone, and the pair
// was broken for its whole life — the router serializes a STRING value as JSON,
// so `search: { expired: 'true' }` reached the address bar as
// `?expired=%22true%22`, and the page's `=== 'true'` never matched. A user
// thrown out mid-task got a bare login form and no explanation.
//
// So nothing here hands the login page a hand-written query string: the URL
// under assertion is the one the real interception produces, and the notice
// under assertion is what the real page makes of that URL. Break either side
// and this fails.

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });

  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: (LoginRoute.options as any).component,
  });
  // The login form links to both; they only need to exist for the links to build.
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
  const dashboard = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/dashboard',
    component: () => <div>dashboard-stub</div>,
  });

  const routeTree = rootRoute.addChildren([login, register, forgotPassword, dashboard]);

  // A BROWSER history, not a memory one: login.tsx reads window.location, and a
  // memory history would leave it untouched — the page would then miss a notice
  // it shows perfectly well in a browser, or show one for a URL the browser
  // never had. main.tsx builds the real router this way too (the default).
  return createRouter({ routeTree: routeTree as any, history: createBrowserHistory() });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let fetchSpy: MockInstance;

beforeEach(() => {
  window.history.replaceState(null, '', '/dashboard');

  // lib/api's latch and session flag are module-scoped, and a fresh page load is
  // what normally resets them; this pair is that reset through its own exports.
  markSessionStarted();
  markSessionEnded();

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  setRouter(null);
  markSessionEnded();
  window.history.replaceState(null, '', '/');
});

describe('a session that expires says so on the login page', () => {
  it('redirects to a URL the login page reads as expiry, and shows the notice', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = buildRouter();
    // main.tsx hands the real router to lib/api; same here, or the interception
    // would assign window.location instead of navigating.
    setRouter(router);
    render(
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('dashboard-stub')).toBeTruthy();

    // A session the server has confirmed, then a request that finds it gone —
    // the ordinary way an expiry is discovered.
    markSessionStarted();
    await act(async () => {
      await api.get('/positions').catch(() => undefined);
    });

    // What the address bar actually holds. Written by the interception, and the
    // only input the page gets.
    expect(window.location.pathname).toBe('/login');
    expect(window.location.search).toBe('?expired=true');

    // And what the page makes of it.
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });

  it('shows nothing on a /login the expiry did not send anyone to', async () => {
    // The other half of the pair: the notice belongs to a session that ended,
    // not to every visit to the login page.
    window.history.replaceState(null, '', '/login');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = buildRouter();
    setRouter(router);
    render(
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText('Log in', { selector: '[data-slot="card-title"]' }),
    ).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
