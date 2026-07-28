// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { User } from '@tradr/shared';

import { Route as AccountRoute } from './_auth.settings.account';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Toast — the shared resend hook toasts on 200 / RATE_LIMITED; mocked so no
// Toaster mount is needed.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const accountOpts = AccountRoute.options as any;

// Re-host the real route component under a fresh root (the register /
// settings-layout test pattern) with a REAL useAuth — the me-query is the
// thing under test for the ALREADY_VERIFIED self-cure.
function buildRouter() {
  const rootRoute = createRootRoute();

  const account = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/settings/account',
    component: accountOpts.component,
  });

  const routeTree = rootRoute.addChildren([account]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: ['/settings/account'] }),
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = buildRouter();
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { qc, router };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- Mutable fetch fixtures (rebound per test) ------------------------------

// /auth/me payload — a logged-in user (the route is auth-gated in the app).
let meUser: User;
// /auth/verify-email/resend response factory (fresh Response per call).
let resendResponse: () => Response;

let fetchSpy: MockInstance | null = null;

beforeEach(() => {
  meUser = { id: 'u1', email: 'me@user.dev', isAdmin: false, emailVerified: false };
  resendResponse = () => jsonResponse(200, { success: true });

  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/verify-email/resend')) return resendResponse();
    if (url.includes('/auth/me')) return jsonResponse(200, meUser);
    throw new Error(`Unexpected fetch in test: ${url}`);
  });

  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

describe('settings account route', () => {
  it('case 1: verified user — email + neutral "Verified" badge, no resend affordance', async () => {
    meUser = { id: 'u1', email: 'me@user.dev', isAdmin: false, emailVerified: true };
    renderPage();

    expect(await screen.findByText('me@user.dev')).toBeTruthy();
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.queryByText('Not verified')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend verification email' })).toBeNull();
  });

  it('case 2: unverified — neutral "Not verified" badge + resend; 200 → success toast', async () => {
    renderPage();

    expect(await screen.findByText('me@user.dev')).toBeTruthy();
    const badge = screen.getByText('Not verified');
    // REQ-5.1: informational presentation, never the destructive vocabulary.
    expect(badge.getAttribute('data-variant')).not.toBe('destructive');

    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Verification email sent.');
    });
    const resendCalls = fetchSpy!.mock.calls.filter((args) =>
      String(args[0]).includes('/auth/verify-email/resend'),
    );
    expect(resendCalls.length).toBe(1);
    expect((resendCalls[0][1] as RequestInit).method).toBe('POST');
  });

  it('case 3 (SF-2): ALREADY_VERIFIED → informational copy (never the envelope message) + [auth,me] invalidation self-cures the badge', async () => {
    const { qc } = renderPage();
    expect(await screen.findByText('Not verified')).toBeTruthy();

    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    // Verified on another device/tab: the server now says verified while the
    // cached me-payload is stale.
    meUser = { id: 'u1', email: 'me@user.dev', isAdmin: false, emailVerified: true };
    resendResponse = () =>
      jsonResponse(409, {
        error: {
          code: 'ALREADY_VERIFIED',
          message: 'an envelope message the UI must not render',
          requestId: 'req-1',
        },
      });

    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(screen.getByText('Your email is already verified.')).toBeTruthy();
    });
    expect(screen.queryByText('an envelope message the UI must not render')).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['auth', 'me'] });

    // The invalidation refetches the me-query — the badge self-cures.
    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeTruthy();
    });
    expect(screen.queryByText('Not verified')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend verification email' })).toBeNull();
  });

  it('case 4: EMAIL_NOT_CONFIGURED → informational state (no dead end); RATE_LIMITED → try-again-later toast', async () => {
    renderPage();
    expect(await screen.findByText('Not verified')).toBeTruthy();

    resendResponse = () =>
      jsonResponse(409, {
        error: { code: 'EMAIL_NOT_CONFIGURED', message: 'not rendered', requestId: 'req-2' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(screen.getByText(/no email configured/i)).toBeTruthy();
    });
    // Informational, not an error and not a dead end: the page still stands.
    expect(screen.getByText(/not required/i)).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();

    resendResponse = () =>
      jsonResponse(429, {
        error: { code: 'RATE_LIMITED', message: 'not rendered', requestId: 'req-3' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Too many requests — try again later.');
    });
  });
});
