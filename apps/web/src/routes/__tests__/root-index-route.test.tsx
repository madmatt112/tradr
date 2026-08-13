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
import { Route as IndexRoute } from '../index';
import { Route as LoginRoute } from '../login';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));

// THE BARE ORIGIN IS A ROUTE, and it is not the 404 page.
//
// `/` matched nothing in the route tree, so opening https://app.tradr.cloud fell
// through to __root's notFoundComponent and an anonymous visitor was told the
// address they had typed was wrong. These cases pin the front door open in both
// directions, and pin the way it asks who you are: through `useSessionPresence`,
// where a 401 means "nobody", rather than through a redirect into `_auth` whose
// me-query would 401 and be read by lib/api as an expiry.

/* eslint-disable @typescript-eslint/no-explicit-any */
// The real root and the real `/` component, so what an unmatched-until-now
// address renders is what the app renders (the not-found test's pattern).
function buildRouter(initialPath: string) {
  const rootOptions = RootRoute.options as any;
  const rootRoute = createRootRoute({
    component: rootOptions.component,
    notFoundComponent: rootOptions.notFoundComponent,
  });

  const index = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/',
    component: (IndexRoute.options as any).component,
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

  const routeTree = rootRoute.addChildren([index, login, dashboard]);

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
  // rather than assigning window.location — without this the redirect the
  // anonymous case forbids would be invisible to it.
  setRouter(router);
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// One tick for the me-query's answer, one for the navigation it provokes.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let fetchSpy: MockInstance;

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

describe('the bare origin while logged out', () => {
  beforeEach(() => {
    mockSession(
      () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  });

  it('sends the visitor to the login page instead of a not-found page', async () => {
    const { router } = renderAt('/');
    await settle();

    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByText('Log in', { selector: '[data-slot="card-title"]' })).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('does not announce an expiry to someone who never had a session', async () => {
    const { router } = renderAt('/');
    await settle();

    expect(router.state.location.href).not.toContain('expired');
    expect(screen.queryByText('Session expired. Please log in again.')).toBeNull();
  });

  it('leaves the expiry redirect intact for the session that follows', async () => {
    const { router } = renderAt('/');
    await settle();

    // The presence check's own 401 must not consume lib/api's one-shot latch, or
    // the front door would cost the next real expiry its one announcement.
    // `markSessionConfirmed` stands in for the session the visitor then signs
    // into: it declares a session WITHOUT re-arming the latch, which is what
    // leaves a burnt one visible here.
    markSessionConfirmed();
    await expect(api.get('/positions')).rejects.toThrow('Unauthorized');
    await settle();

    expect(router.state.location.href).toContain('expired');
  });
});

describe('the bare origin while signed in', () => {
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

  it('sends the user to the dashboard', async () => {
    const { router } = renderAt('/');
    await settle();

    expect(router.state.location.pathname).toBe('/dashboard');
    expect(screen.queryByText('Page not found')).toBeNull();
  });
});
