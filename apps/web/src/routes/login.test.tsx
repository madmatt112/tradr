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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  // The post-second-step navigation target (Req 2.8) — a stub is enough to
  // observe that the router actually moved there.
  const dashboard = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/dashboard',
    component: () => <div>dashboard-stub</div>,
  });
  const routeTree = rootRoute.addChildren([login, register, forgotPassword, dashboard]);
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
  return router;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fillAndSubmitPassword(email = 'a@example.com', password = 'password-123') {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
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

// Req 2.7, 2.8, 3.4 (security-hardening, design C8): the two-step sign-in.
describe('login page — two-step flow (security-hardening C8)', () => {
  const CHALLENGE = 'a'.repeat(64);

  it('Req 2.7: a 202 two-factor answer shows the code field and asks /auth/me nothing', async () => {
    window.history.replaceState(null, '', '/login');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/config')) {
        return jsonResponse(200, { registrationEnabled: true, advisorEnabled: false });
      }
      if (url.includes('/auth/login/two-factor')) {
        throw new Error(`Unexpected two-factor call in test: ${url}`);
      }
      if (url.includes('/auth/login')) {
        return jsonResponse(202, { twoFactorRequired: true, challenge: CHALLENGE });
      }
      if (url.includes('/auth/me')) {
        return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    renderLogin();

    await fillAndSubmitPassword();

    const codeInput = await screen.findByLabelText('Authentication code');
    expect(codeInput.getAttribute('autocomplete')).toBe('one-time-code');
    // The password form is REPLACED, not merely joined by the code field.
    expect(screen.queryByLabelText('Password')).toBeNull();

    const meCalls = fetchSpy.mock.calls.filter((args) => String(args[0]).includes('/auth/me'));
    expect(meCalls.length).toBe(0);
  });

  it('Req 2.8: a valid code at the second step navigates to /dashboard', async () => {
    window.history.replaceState(null, '', '/login');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/config')) {
        return jsonResponse(200, { registrationEnabled: true, advisorEnabled: false });
      }
      if (url.includes('/auth/login/two-factor')) {
        expect(JSON.parse(String(init?.body))).toEqual({ challenge: CHALLENGE, code: '123456' });
        return jsonResponse(200, {
          user: { id: 'u-1', email: 'a@example.com', isAdmin: false, emailVerified: true },
        });
      }
      if (url.includes('/auth/login')) {
        return jsonResponse(202, { twoFactorRequired: true, challenge: CHALLENGE });
      }
      if (url.includes('/auth/me')) {
        return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    const router = renderLogin();

    await fillAndSubmitPassword();
    fireEvent.change(await screen.findByLabelText('Authentication code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });

  it('CHALLENGE_EXPIRED at the second step returns to the password form with the server notice', async () => {
    window.history.replaceState(null, '', '/login');
    const expiredMessage = 'Your code expired. Please sign in again.';
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/config')) {
        return jsonResponse(200, { registrationEnabled: true, advisorEnabled: false });
      }
      if (url.includes('/auth/login/two-factor')) {
        return jsonResponse(400, {
          error: { code: 'CHALLENGE_EXPIRED', message: expiredMessage, requestId: 'req-1' },
        });
      }
      if (url.includes('/auth/login')) {
        return jsonResponse(202, { twoFactorRequired: true, challenge: CHALLENGE });
      }
      if (url.includes('/auth/me')) {
        return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    renderLogin();

    await fillAndSubmitPassword();
    fireEvent.change(await screen.findByLabelText('Authentication code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText(expiredMessage)).toBeTruthy();
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
  });

  it('Req 3.4: a locked address shows the server retry message, not the generic fallback', async () => {
    window.history.replaceState(null, '', '/login');
    const lockedMessage = 'Too many failed sign-ins. Try again in 15 minutes.';
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/config')) {
        return jsonResponse(200, { registrationEnabled: true, advisorEnabled: false });
      }
      if (url.includes('/auth/login')) {
        return jsonResponse(429, {
          error: { code: 'ACCOUNT_LOCKED', message: lockedMessage, requestId: 'req-2' },
        });
      }
      if (url.includes('/auth/me')) {
        return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    renderLogin();

    await fillAndSubmitPassword();

    const notice = await screen.findByText(lockedMessage);
    expect(notice.className).toContain('text-destructive');
    expect(screen.queryByText('An unexpected error occurred')).toBeNull();
  });
});
