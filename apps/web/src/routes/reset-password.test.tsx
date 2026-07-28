// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { Route as ResetPasswordRoute } from './reset-password';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SF-3 teeth: the page is rendered logged-out (no auth mocks, no QueryClient
// warm cache) — if it ever mounted useAuth's ['auth','me'] query, a fetch to
// /auth/me would fire and case 1 fails.

const HEX_TOKEN = '0123456789abcdef'.repeat(4); // 64-char lowercase hex

/* eslint-disable @typescript-eslint/no-explicit-any */
const resetOpts = ResetPasswordRoute.options as any;

// Re-host the real route component under a fresh root (the settings-layout
// test pattern) so its Links resolve against an in-memory history.
function buildRouter() {
  const rootRoute = createRootRoute();

  const resetPassword = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/reset-password',
    component: resetOpts.component,
  });
  const forgotPassword = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/forgot-password',
    component: () => null,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: () => null,
  });

  const routeTree = rootRoute.addChildren([resetPassword, forgotPassword, login]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: ['/reset-password'] }),
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function renderPage() {
  return render(<RouterProvider router={buildRouter()} />);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fillAndSubmit(password: string) {
  fireEvent.change(await screen.findByLabelText('New password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
}

let fetchSpy: MockInstance | null = null;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  window.location.hash = '';
});

describe('reset-password route (public, fragment carry)', () => {
  it('case 1 (SF-3): renders the form logged-out with #token in the location — and NO /auth/me request fires', async () => {
    window.location.hash = `#token=${HEX_TOKEN}`;
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    renderPage();

    expect(await screen.findByLabelText('New password')).toBeTruthy();
    expect(screen.getByLabelText('Confirm password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeTruthy();

    const meCalls = fetchSpy.mock.calls.filter((args) => String(args[0]).includes('/auth/me'));
    expect(meCalls.length).toBe(0);
    // Stronger: rendering the page issues no requests at all.
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  it('case 2: no #token — renders guidance with a link to /forgot-password instead of the form', async () => {
    renderPage();

    expect(await screen.findByText(/missing its reset token/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /request a new reset link/i })).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('case 3: submit POSTs { token, password } in the body; success shows the Log in link (no auto-login)', async () => {
    window.location.hash = `#token=${HEX_TOKEN}`;
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { success: true }));

    renderPage();
    await fillAndSubmit('new-password-1');

    await waitFor(() => {
      expect(screen.getByText('Your password has been reset.')).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/auth/password-reset/complete');
    expect(String(url)).not.toContain(HEX_TOKEN); // token never in the URL
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      token: HEX_TOKEN,
      password: 'new-password-1',
    });
  });

  it('case 4 (SF-2): INVALID_OR_EXPIRED_TOKEN — keyed on err.error.code — shows the generic expired state + re-request affordance', async () => {
    window.location.hash = `#token=${HEX_TOKEN}`;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'INVALID_OR_EXPIRED_TOKEN',
          message: 'a message the UI must not key on',
          requestId: 'req-1',
        },
      }),
    );

    renderPage();
    await fillAndSubmit('new-password-1');

    await waitFor(() => {
      expect(screen.getByText(/invalid or has expired/i)).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: /request a new reset link/i })).toBeTruthy();
    expect(screen.queryByText('a message the UI must not key on')).toBeNull();
  });
});
