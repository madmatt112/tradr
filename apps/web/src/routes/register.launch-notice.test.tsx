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

import { Route as LoginRoute } from './login';
import { Route as RegisterRoute } from './register';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));

// newsletter REQ-9.4/9.6: when the instance has registration closed, /register
// says so in the app instead of handing over a form the server will refuse, and
// the login page stops advertising a way in. The server gate is the control —
// these cases only check that the SPA stops wasting people's time.

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();

  const register = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/register',
    component: (RegisterRoute.options as any).component,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/login',
    component: (LoginRoute.options as any).component,
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

  const routeTree = rootRoute.addChildren([register, login, forgotPassword, dashboard]);

  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function renderAt(initialPath: string) {
  // Retries left at the library default on purpose: the hook sets its own
  // `retry: false`, and a test client that disabled retries everywhere could not
  // tell the two apart.
  const qc = new QueryClient();
  const router = buildRouter(initialPath);
  // main.tsx hands the real router to lib/api; without it a 401 interception
  // would assign window.location and the assertions below would miss it.
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

/** Every request answers `config`, whatever it is; anything else is a failure. */
function stubConfig(config: () => Response | Promise<Response>) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/config')) return config();
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

function configResponse(registrationEnabled: boolean) {
  return new Response(JSON.stringify({ registrationEnabled }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function configCalls() {
  return fetchSpy.mock.calls.filter((args) => String(args[0]).endsWith('/api/config'));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  // lib/api's redirect latch and session flag are module-scoped and a fresh page
  // load is what normally resets them; this pair is that reset.
  markSessionStarted();
  markSessionEnded();
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  setRouter(null);
});

describe('/register with registration closed', () => {
  beforeEach(() => stubConfig(() => configResponse(false)));

  it('shows the launch notice with a newsletter link, and no form', async () => {
    const { router } = renderAt('/register');

    expect(
      await screen.findByText('Signups open at launch', { selector: '[data-slot="card-title"]' }),
    ).toBeTruthy();

    const link = screen.getByRole('link', { name: 'Join the newsletter' });
    expect(link.getAttribute('href')).toBe('https://www.tradr.cloud/newsletter');
    // REQ-9.6: the notice is IN the app. Reading it must not have moved anyone
    // off the address they opened.
    expect(router.state.location.pathname).toBe('/register');

    // No form to fill in, and nothing to submit.
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();

    // Someone who already has an account still has somewhere to go.
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();
  });

  it('never paints the form first — the closed instance sees the notice or nothing', async () => {
    renderAt('/register');

    // Before the config read resolves. A page that guessed "open" would have the
    // fields on screen here and swap them out a tick later.
    expect(screen.queryByLabelText('Email')).toBeNull();

    expect(await screen.findByText('Signups open at launch')).toBeTruthy();
    // And the fields never appeared on the way there.
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('hides the register link on the login page', async () => {
    renderAt('/login');

    expect(
      await screen.findByText('Log in', { selector: '[data-slot="card-title"]' }),
    ).toBeTruthy();
    await settle();

    expect(screen.queryByRole('link', { name: 'Register' })).toBeNull();
    expect(screen.queryByText(/Don't have an account/)).toBeNull();
    // Login itself is untouched (REQ-8.4) — only registration is gated.
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeTruthy();
  });
});

describe('/register with registration open', () => {
  beforeEach(() => stubConfig(() => configResponse(true)));

  it('renders the real form, exactly as before', async () => {
    renderAt('/register');

    expect(
      await screen.findByText('Create an account', { selector: '[data-slot="card-title"]' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByLabelText('Confirm password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy();
    expect(screen.queryByText('Signups open at launch')).toBeNull();
  });

  it('keeps the register link on the login page', async () => {
    renderAt('/login');
    await settle();

    expect(screen.getByRole('link', { name: 'Register' }).getAttribute('href')).toBe('/register');
  });
});

describe('/api/config unreachable', () => {
  it('fails open: the form renders, nothing crashes, and the read is not retried', async () => {
    stubConfig(() => {
      throw new Error('network down');
    });

    const { router } = renderAt('/register');

    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy();
    expect(screen.queryByText('Signups open at launch')).toBeNull();

    await settle();
    // `retry: false` — one attempt, no backoff loop holding the page.
    expect(configCalls().length).toBe(1);
    expect(router.state.location.pathname).toBe('/register');
  });

  it('a 401 fails open too, without announcing an expiry nobody had', async () => {
    // A trailing-slash proxy rewrite answers /api/config/ with 401. The read is
    // opted out of the global expiry redirect (see the sanctioned-sites list in
    // lib/api.test.ts), so lib/api leaves it alone instead of navigating to
    // /login?expired=true and burning the one-shot latch.
    stubConfig(
      () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const { router } = renderAt('/register');

    expect(await screen.findByLabelText('Email')).toBeTruthy();
    await settle();
    expect(router.state.location.pathname).toBe('/register');
    expect(router.state.location.href).not.toContain('expired');
  });

  it('leaves the login page advertising registration', async () => {
    stubConfig(() => {
      throw new Error('network down');
    });

    renderAt('/login');
    await settle();

    expect(screen.getByRole('link', { name: 'Register' })).toBeTruthy();
  });
});
