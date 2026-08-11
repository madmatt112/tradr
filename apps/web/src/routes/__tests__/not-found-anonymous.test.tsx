// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  api,
  markSessionConfirmed,
  markSessionEnded,
  markSessionStarted,
  setRouter,
} from '@/lib/api';

import { Route as RootRoute } from '../__root';
import { Route as LoginRoute } from '../login';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));

// An unknown URL asks who you are, and a 401 is an ANSWER to that, not an expiry.
//
// __root's notFoundComponent is a dispatcher: what a 404 should show differs for
// a signed-in user and an anonymous one, so unlike the public routes it cannot
// avoid the question by not asking it. Asking it through `useAuth` meant the
// me-query 401'd on a logged-out visitor and lib/api's global interception
// navigated to `/login?expired=true` — a mistyped address, or any stale external
// link, told people their session had expired when they never had one.
//
// The anonymous case below is the regression these tests exist for. The
// signed-in case sits beside it so a later change cannot quietly collapse the
// two back into one.

/* eslint-disable @typescript-eslint/no-explicit-any */
// The REAL root, carrying the real notFoundComponent, so an unmatched path
// renders what the app renders (the public-routes cold-load test's pattern).
function buildRouter(initialPath: string) {
  const rootOptions = RootRoute.options as any;
  const rootRoute = createRootRoute({
    component: rootOptions.component,
    notFoundComponent: rootOptions.notFoundComponent,
  });

  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: (LoginRoute.options as any).component,
  });
  const dashboard = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/dashboard',
    component: () => <div>dashboard-stub</div>,
  });

  const routeTree = rootRoute.addChildren([login, dashboard]);

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
  // main.tsx hands the real router to lib/api, so the 401 interception navigates
  // rather than assigning window.location. Same here, or the redirect these
  // tests forbid would be invisible to them.
  setRouter(router);
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Two ticks: one for the me-query's answer, one for any navigation it provokes.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const UNKNOWN_PATH = '/this-route-does-not-exist';

let fetchSpy: MockInstance;

// Every request answers the same way, because the session is what is being
// mocked, not one endpoint. The 404 page only ever calls `/auth/me`; the latch
// case below deliberately calls something else.
function mockSession(respond: () => Response) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond());
}

beforeEach(() => {
  // lib/api's redirect latch and session flag are module-scoped and a fresh page
  // load is what normally resets them. This pair is that reset through the
  // module's own exports: started re-arms the latch, ended clears the session.
  markSessionStarted();
  markSessionEnded();
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  setRouter(null);
});

describe('an unknown URL while logged out', () => {
  beforeEach(() => {
    mockSession(
      () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  });

  it('renders a not-found page instead of redirecting to a session-expired login', async () => {
    const { router } = renderAt(UNKNOWN_PATH);
    await settle();

    expect(screen.getByText('Page not found')).toBeTruthy();

    // The address is still the one that was mistyped: no redirect happened, and
    // in particular not the `expired` one the 401 interception used to perform.
    expect(router.state.location.pathname).toBe(UNKNOWN_PATH);
    expect(router.state.location.href).not.toContain('expired');
    expect(screen.queryByText('Session expired. Please log in again.')).toBeNull();
    expect(screen.queryByText('Log in', { selector: '[data-slot="card-title"]' })).toBeNull();
  });

  it('offers a way to sign in, so a wrong address is distinguishable from being signed out', async () => {
    renderAt(UNKNOWN_PATH);
    await settle();

    const signIn = screen.getByRole('link', { name: 'Sign in' });
    expect(signIn.getAttribute('href')).toBe('/login');
  });

  it('leaves the expiry redirect intact for the session that follows', async () => {
    const { router } = renderAt(UNKNOWN_PATH);
    await settle();

    // The anonymous 404's own 401 must not consume lib/api's one-shot redirect
    // latch, or the fix would trade a false expiry notice for a missing real
    // one. `markSessionConfirmed` stands in for the session the visitor then
    // signs into — it declares a session WITHOUT re-arming the latch, which is
    // exactly what leaves a burnt latch visible here.
    markSessionConfirmed();
    await expect(api.get('/positions')).rejects.toThrow('Unauthorized');
    await settle();

    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.href).toContain('expired');
  });
});

describe('an unknown URL while signed in', () => {
  beforeEach(() => {
    mockSession(
      () =>
        new Response(
          JSON.stringify({
            id: 'u1',
            email: 'trader@example.com',
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
  });

  it('still dispatches to the dashboard rather than the anonymous page', async () => {
    const { router } = renderAt(UNKNOWN_PATH);
    await settle();

    expect(router.state.location.pathname).toBe('/dashboard');
    expect(screen.queryByText('Page not found')).toBeNull();
  });
});
