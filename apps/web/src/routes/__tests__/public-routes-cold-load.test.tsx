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

import { markSessionEnded, markSessionStarted, setRouter } from '@/lib/api';

import { Route as ForgotPasswordRoute } from '../forgot-password';
import { Route as LoginRoute } from '../login';
import { Route as RegisterRoute } from '../register';
import { Route as ResetPasswordRoute } from '../reset-password';
import { Route as VerifyEmailRoute } from '../verify-email';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The resend hook toasts; mocked so no Toaster mount is needed.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// SF-3 teeth, for EVERY unauthenticated route rather than one of them.
//
// A cold load — a bookmark, a refresh, an emailed link — starts with no session,
// so `GET /auth/me` answers 401 and lib/api's global interception navigates to
// `/login?expired=true`. A public page that mounts that query therefore redirects
// itself away before it renders, and the visitor is told their session expired
// when they never had one. register.tsx did exactly this: the registration form
// was reachable only from inside /login, so an emailed signup link was a dead end.
//
// These cases render each page logged-out against a 401 me-endpoint and assert
// the page renders, no `/auth/me` request fires, and no redirect happens.

/* eslint-disable @typescript-eslint/no-explicit-any */
const PUBLIC_ROUTES = [
  { path: '/login', title: 'Log in', options: LoginRoute.options as any },
  { path: '/register', title: 'Create an account', options: RegisterRoute.options as any },
  {
    path: '/forgot-password',
    title: 'Reset your password',
    options: ForgotPasswordRoute.options as any,
  },
  {
    path: '/reset-password',
    title: 'Set a new password',
    options: ResetPasswordRoute.options as any,
  },
  { path: '/verify-email', title: 'Verify your email', options: VerifyEmailRoute.options as any },
];

// Re-host the real route components under a fresh root (the reset-password /
// settings-layout test pattern) so Links and navigate() resolve in-memory.
function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();

  const publicRoutes = PUBLIC_ROUTES.map((route) =>
    createRoute({
      getParentRoute: () => rootRoute as any,
      path: route.path,
      component: route.options.component,
    }),
  );
  const dashboard = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/dashboard',
    component: () => <div>dashboard-stub</div>,
  });
  const settingsAccount = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/settings/account',
    component: () => null,
  });

  const routeTree = rootRoute.addChildren([...publicRoutes, dashboard, settingsAccount]);

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
  // rather than assigning window.location. Same here, or the redirect under test
  // would be invisible to the assertions below.
  setRouter(router);
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let fetchSpy: MockInstance;

beforeEach(() => {
  // lib/api's redirect latch and session flag are module-scoped and a fresh page
  // load is what normally resets them. This pair is that reset through the
  // module's own exports: started re-arms the latch, ended clears the session.
  markSessionStarted();
  markSessionEnded();

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/me')) {
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  setRouter(null);
  window.location.hash = '';
});

describe('unauthenticated routes cold-load without a session', () => {
  it.each(PUBLIC_ROUTES)(
    '$path renders, issues no /auth/me, and does not redirect',
    async (route) => {
      const { router } = renderAt(route.path);

      // Scoped to the card title: /login's heading and its submit button share the
      // words "Log in", and only the heading says the page rendered.
      expect(
        await screen.findByText(route.title, { selector: '[data-slot="card-title"]' }),
      ).toBeTruthy();

      // Let any 401-driven navigation land before asserting none did.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const meCalls = fetchSpy.mock.calls.filter((args) => String(args[0]).includes('/auth/me'));
      expect(meCalls.length).toBe(0);
      expect(router.state.location.pathname).toBe(route.path);
      expect(router.state.location.href).not.toContain('expired');
    },
  );

  it('/register cold-loads with the registration fields, not the login page', async () => {
    renderAt('/register');

    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByLabelText('Confirm password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy();
    expect(screen.queryByText('Session expired. Please log in again.')).toBeNull();
  });
});
