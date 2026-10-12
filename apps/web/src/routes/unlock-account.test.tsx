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

import { Route as UnlockAccountRoute } from './unlock-account';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SF-3 teeth: the page is rendered logged-out (no auth mocks, no QueryClient
// warm cache) — if it ever mounted useAuth's ['auth','me'] query, a fetch to
// /auth/me would fire and case 1 fails.

const HEX_TOKEN = '0123456789abcdef'.repeat(4); // 64-char lowercase hex

/* eslint-disable @typescript-eslint/no-explicit-any */
const unlockOpts = UnlockAccountRoute.options as any;

// Re-host the real route component under a fresh root (the reset-password
// test pattern) so its Links resolve against an in-memory history.
function buildRouter() {
  const rootRoute = createRootRoute();

  const unlockAccount = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/unlock-account',
    component: unlockOpts.component,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: () => null,
  });

  const routeTree = rootRoute.addChildren([unlockAccount, login]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: ['/unlock-account'] }),
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

let fetchSpy: MockInstance | null = null;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  window.location.hash = '';
});

describe('unlock-account route (public, fragment carry)', () => {
  // Req 4.9 / design C6: "the unlock link lands on a public page that mounts
  // no ['auth','me'] query". Mirrors reset-password.test.tsx case 1.
  it('case 1 (SF-3): renders logged-out with #token in the location — and NO /auth/me request fires', async () => {
    window.location.hash = `#token=${HEX_TOKEN}`;
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    renderPage();

    expect(await screen.findByText('Unlock your account')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlock account' })).toBeTruthy();

    const meCalls = fetchSpy.mock.calls.filter((args) => String(args[0]).includes('/auth/me'));
    expect(meCalls.length).toBe(0);
    // Stronger: rendering the page issues no requests at all.
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  // _Prompt success: "one click posts the fragment token once" + "success
  // shows the unlocked message and login link".
  it('case 2: click POSTs { token } from the fragment once; success shows the unlocked message and a login link', async () => {
    window.location.hash = `#token=${HEX_TOKEN}`;
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { success: true }));

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock account' }));

    await waitFor(() => {
      expect(screen.getByText('Your account is unlocked.')).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/auth/unlock');
    expect(String(url)).not.toContain(HEX_TOKEN); // token never in the URL
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: HEX_TOKEN });
  });

  // _Prompt success: "INVALID_OR_EXPIRED_TOKEN shows the invalid-link message".
  it('case 3 (SF-2): INVALID_OR_EXPIRED_TOKEN — keyed on err.error.code — shows the invalid-link message', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock account' }));

    await waitFor(() => {
      expect(screen.getByText('This link is invalid or has expired.')).toBeTruthy();
    });
    expect(screen.queryByText('a message the UI must not key on')).toBeNull();
  });
});
