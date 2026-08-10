// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { User } from '@tradr/shared';

import { DRAWER_STORAGE_KEY, useDrawerStore } from '@/stores/drawer.store';
import { eventBus } from '@/stores/event-bus.store';

import { Route as RegisterRoute } from './register';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Toast — the shared resend hook toasts on 200 / RATE_LIMITED (asserted in
// cases 3-4); mocked so no Toaster mount is needed.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const registerOpts = RegisterRoute.options as any;

// Re-host the real route component under a fresh root (the reset-password /
// settings-layout test pattern) so navigate()/Links resolve in-memory.
function buildRouter() {
  const rootRoute = createRootRoute();

  const registerRoute = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/register',
    component: registerOpts.component,
  });
  const dashboard = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/dashboard',
    component: () => <div>dashboard-stub</div>,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: () => null,
  });

  const routeTree = rootRoute.addChildren([registerRoute, dashboard, login]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: ['/register'] }),
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

// /auth/register 201 payload.
let registered: User;
// /auth/verify-email/resend response factory (fresh Response per call).
let resendResponse: () => Response;

let fetchSpy: MockInstance | null = null;

// ---- Browser-zone stub ------------------------------------------------------
// register.tsx is the ONE place still allowed to detect the browser zone — it
// seeds the new user's stored reporting timezone at sign-up, which is the only
// moment there is nothing stored to read instead.
// Only the ZERO-ARG call is that detection; calls carrying arguments are
// delegated to the real implementation, because the shared
// ReportingTimezoneField validator decides validity with
// `new Intl.DateTimeFormat('en-US', { timeZone })`.
const RealDateTimeFormat = Intl.DateTimeFormat;
let intlSpy: MockInstance | null = null;

function installIntlStub(resolvedOptions: () => { timeZone: string | undefined }) {
  const impl = (...args: unknown[]) =>
    args.length > 0 ? Reflect.construct(RealDateTimeFormat, args) : { resolvedOptions };
  intlSpy = vi
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(impl as unknown as typeof Intl.DateTimeFormat);
}

function stubBrowserZone(zone: string | undefined) {
  installIntlStub(() => ({ timeZone: zone }));
}

function stubBrowserZoneThrows() {
  installIntlStub(() => {
    throw new Error('Intl unavailable in this runtime');
  });
}

function registerBody(): Record<string, unknown> {
  const call = fetchSpy!.mock.calls.find((args) => String(args[0]).includes('/auth/register'));
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

beforeEach(() => {
  registered = { id: 'u1', email: 'new@user.dev', isAdmin: false, emailVerified: false };
  resendResponse = () => jsonResponse(200, { success: true });

  // No `/auth/me` case on purpose: this page must not ask. Case 1 puts the
  // session in the query cache directly instead, which is what the answer would
  // have produced anyway and does not depend on the page requesting it.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/verify-email/resend')) return resendResponse();
    if (url.includes('/auth/register')) return jsonResponse(201, { user: registered });
    throw new Error(`Unexpected fetch in test: ${url}`);
  });

  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  intlSpy?.mockRestore();
  intlSpy = null;
  eventBus.__resetForTests();
  localStorage.clear();
  useDrawerStore.getState().reset();
});

async function fillAndSubmit() {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'new@user.dev' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'password-123' },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'password-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
}

async function registerToCheckYourEmail() {
  const rendered = renderPage();
  await fillAndSubmit();
  await waitFor(() => {
    expect(screen.getByText('Check your email')).toBeTruthy();
  });
  return rendered;
}

describe('register route', () => {
  it('case 1 (SF-4): check-your-email state survives the auth query flipping to success; "Continue to dashboard" is the only exit', async () => {
    const { qc, router } = await registerToCheckYourEmail();

    // Address shown; still on /register (auto-login kept, no navigate).
    expect(screen.getByText('new@user.dev')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/register');

    // Simulate the session becoming visible to the app: registration auto-logs-in,
    // so ['auth','me'] flips from logged-out to an authenticated user the moment
    // anything asks — the focus refetch when the user tabs back from their mail
    // client. Seeded straight into the cache rather than refetched because this
    // page mounts no me-query of its own (SF-3, public-routes-cold-load.test.tsx);
    // seeding is also what makes this hold whether or not it ever mounts one,
    // since `setQueryData` is the same flip either way.
    const authedUser: User = {
      id: 'u1',
      email: 'new@user.dev',
      isAdmin: false,
      emailVerified: false,
    };
    await act(async () => {
      qc.setQueryData(['auth', 'me'], authedUser);
    });
    // The flip really landed (isAuthenticated is now true)...
    expect(qc.getQueryData(['auth', 'me'])).toMatchObject({ id: 'u1' });

    // GIVE ANY GUARD ITS CHANCE TO FIRE BEFORE ASSERTING NONE DID. An
    // `isAuthenticated` redirect placed above the `pendingEmail` return is the
    // regression this case exists to catch, and it lands a tick later than the
    // render that triggers it — whether it navigates from an effect or renders
    // `<Navigate>`. Asserting synchronously on the flip above sees the DOM
    // before the navigation and passes either way, which is no test at all.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // ...and the state persisted: no navigate-away, state still rendered.
    expect(screen.getByText('Check your email')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/register');
    expect(screen.queryByText('dashboard-stub')).toBeNull();

    // The only exit.
    fireEvent.click(screen.getByRole('button', { name: 'Continue to dashboard' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
    expect(screen.getByText('dashboard-stub')).toBeTruthy();
  });

  it('case 2: emailVerified true on the 201 (unconfigured instance) — immediate /dashboard navigate, no check-your-email state', async () => {
    registered = { id: 'u2', email: 'solo@user.dev', isAdmin: false, emailVerified: true };
    const { router } = renderPage();
    await fillAndSubmit();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
    expect(screen.queryByText('Check your email')).toBeNull();
  });

  it('case 3: resend 200 → success toast; ALREADY_VERIFIED → informational copy (never the envelope message) + [auth,me] invalidation', async () => {
    const { qc } = await registerToCheckYourEmail();

    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Verification email sent.');
    });
    const resendCalls = fetchSpy!.mock.calls.filter((args) =>
      String(args[0]).includes('/auth/verify-email/resend'),
    );
    expect(resendCalls.length).toBe(1);
    expect((resendCalls[0][1] as RequestInit).method).toBe('POST');

    // Stale-cache resend: keyed on err.error.code, invalidates ['auth','me'].
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
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
  });

  it('case 4: resend EMAIL_NOT_CONFIGURED → informational in-page state; RATE_LIMITED → try-again-later toast', async () => {
    await registerToCheckYourEmail();

    resendResponse = () =>
      jsonResponse(409, {
        error: { code: 'EMAIL_NOT_CONFIGURED', message: 'not rendered', requestId: 'req-2' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(screen.getByText(/no email configured/i)).toBeTruthy();
    });
    // Informational, not a dead end: the state (and its exit) still stands.
    expect(screen.getByRole('button', { name: 'Continue to dashboard' })).toBeTruthy();

    resendResponse = () =>
      jsonResponse(429, {
        error: { code: 'RATE_LIMITED', message: 'not rendered', requestId: 'req-3' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Too many requests — try again later.');
    });
  });

  // ---- Reporting-timezone seeding at registration ---------------------------

  it('case 5: sends the browser-detected reporting timezone in the registration payload', async () => {
    stubBrowserZone('Europe/London');
    await registerToCheckYourEmail();

    expect(registerBody()).toEqual({
      email: 'new@user.dev',
      password: 'password-123',
      timezone: 'Europe/London',
    });
  });

  it('case 6: OMITS the key when detection yields nothing — never sends timezone: null, which RegisterSchema rejects', async () => {
    stubBrowserZone(undefined);
    await registerToCheckYourEmail();

    const body = registerBody();
    expect('timezone' in body).toBe(false);
    expect(body).toEqual({ email: 'new@user.dev', password: 'password-123' });
  });

  it('case 7: registration still succeeds when detection throws', async () => {
    stubBrowserZoneThrows();
    await registerToCheckYourEmail();

    expect('timezone' in registerBody()).toBe(false);
  });

  it('case 8: a zone the server would reject is dropped, not sent — a bad guess must not block signing up', async () => {
    // The Unicode-extension bypass resolveTimezone refuses; the shared
    // validator catches it client-side, so the signup goes through without it
    // rather than 400ing on a value the user never typed.
    stubBrowserZone('America/New_York-u-ca-japanese');
    await registerToCheckYourEmail();

    expect('timezone' in registerBody()).toBe(false);
    expect(screen.getByText('Check your email')).toBeTruthy();
  });

  // ---- Two users, one tab -----------------------------------------------

  // REGISTERING IS ALSO A LOGIN. `POST /auth/register` swaps the session cookie
  // whether or not one was already there, and /register no longer bounces an
  // authenticated visitor away (SF-3 — a public page that mounts the me-query
  // redirects itself away on a cold load). So a signed-in user can reach this
  // form and create a second account, and the new account must not open onto
  // the previous user's cached rows, drawer or walkthrough. Same teardown
  // /login runs, not a second copy of it (lib/sessionTeardown).
  it('case 9: registering on a tab someone else is signed in on begins from clean client state', async () => {
    const { qc } = renderPage();

    qc.setQueryData(['auth', 'me'], { id: 'u-prev', email: 'previous@user.dev' });
    qc.setQueryData(['positions'], [{ id: 'p-1', symbol: 'AAPL' }]);
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ isOpen: true, activeTab: 'quick-stats', version: 1 }),
    );
    useDrawerStore.setState({ isOpen: true, activeTab: 'quick-stats', legacyDetected: false });
    const onLogout = vi.fn();
    eventBus.subscribe('auth:logout', onLogout);

    await fillAndSubmit();
    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeTruthy();
    });

    // SERVER state.
    expect(qc.getQueryData(['positions'])).toBeUndefined();
    // STORED state, and the live store it seeded — the store hydrates once at
    // module import, so the key alone is half the job.
    expect(localStorage.getItem(DRAWER_STORAGE_KEY)).toBeNull();
    expect(useDrawerStore.getState()).toMatchObject({
      isOpen: false,
      activeTab: 'open-positions',
    });
    // MODULE state, announced for each owner to drop its own.
    expect(onLogout).toHaveBeenCalledOnce();
    // And the teardown ran BEFORE the seeding, or the clear would have taken
    // the incoming user out with the departing one.
    expect(qc.getQueryData(['auth', 'me'])).toMatchObject({ id: 'u1' });
  });
});
