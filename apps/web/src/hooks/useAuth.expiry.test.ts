// @vitest-environment jsdom
//
// The seam between `useAuth` and `lib/api`, driven end to end over a stubbed
// network: neither module is a double here, because the regression this file
// exists to hold shut lived BETWEEN them. `useAuth` declared a session from an
// effect over the cached user, `lib/api` never dropped that user when a session
// expired, and so every remount of /login and _auth re-declared a session that
// had already ended — publishing `auth:logout` a second time and re-arming the
// one-shot latch that had been what terminated the /login ↔ /dashboard bounce.
//
// `useAuth.test.ts` next door mocks `lib/api` and is right to: it is about what
// the hook does. Nothing there can see two modules disagreeing.
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, markSessionEnded, markSessionStarted, setRouter } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { eventBus } from '@/stores/event-bus.store';

import { useAuth } from './useAuth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The 401 interception's navigation, which is the one the bounce would repeat.
// `useAuth`'s own router (the logout redirect) is not exercised here.
const interceptNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }));

const A_USER = { id: 'u-1', email: 'a@example.com' };

/** `lib/api` resolves against the singleton client, so these tests use it too. */
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

/** Every request answers 200 with the user until `expire()` is called. */
function stubNetwork() {
  let live = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        live
          ? new Response(JSON.stringify(A_USER), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response('', { status: 401 }),
      ),
    ),
  );
  return {
    expire: () => {
      live = false;
    },
    restore: () => {
      live = true;
    },
  };
}

const onLogout = vi.fn();

beforeEach(() => {
  queryClient.clear();
  eventBus.subscribe('auth:logout', onLogout);
  setRouter({ navigate: interceptNavigate });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  eventBus.__resetForTests();
  queryClient.clear();
  // The session flags in `lib/api` are module state and outlive the test. A
  // live session is the state every test below starts from, and declaring one
  // re-arms the latch as well, so this leaves the module where the next test
  // expects it.
  markSessionStarted();
});

/** Mount the hook and let whatever it asks for settle. */
async function mountAuth() {
  const mounted = renderHook(() => useAuth(), { wrapper });
  await act(async () => {});
  return mounted;
}

/** Sign in the way a page load does: mount the hook and let /auth/me answer. */
async function signIn() {
  const mounted = await mountAuth();
  await waitFor(() => expect(mounted.result.current.isAuthenticated).toBe(true));
  return mounted;
}

/** A request from some other feature — the usual way an expiry is discovered. */
async function anAuthedRequest() {
  await act(async () => {
    await api.get('/positions').catch(() => undefined);
  });
}

/** /login mounting, then _auth mounting behind it, three bounces over. */
async function remountAsThePagesWould() {
  for (let i = 0; i < 3; i++) {
    const remounted = await mountAuth();
    await anAuthedRequest();
    remounted.unmount();
  }
}

describe('a session expiring, and what the remounts afterwards may do', () => {
  it('publishes auth:logout exactly once, however many times useAuth remounts', async () => {
    const network = stubNetwork();
    const session = await signIn();
    network.expire();

    await anAuthedRequest();
    expect(onLogout).toHaveBeenCalledOnce();

    // /login mounts `useAuth`, and so does _auth on the way back. Each of them
    // used to re-declare the session off the user still sitting in the cache,
    // and the next 401 announced its end all over again.
    session.unmount();
    await remountAsThePagesWould();

    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('terminates: one navigation to /login for one expiry', async () => {
    const network = stubNetwork();
    const session = await signIn();
    network.expire();

    await anAuthedRequest();
    session.unmount();
    await remountAsThePagesWould();

    expect(interceptNavigate).toHaveBeenCalledTimes(1);
    expect(interceptNavigate).toHaveBeenCalledWith({
      to: '/login',
      search: { expired: 'true' },
      replace: true,
    });
  });

  it('leaves no user behind for /login to bounce back to /dashboard on', async () => {
    const network = stubNetwork();
    const session = await signIn();
    network.expire();

    await anAuthedRequest();
    session.unmount();

    // What /login reads. `isAuthenticated` there IS its redirect condition, so
    // a truthy user is a navigation to /dashboard — which mounts _auth, which
    // 401s, which is the bounce.
    expect(queryClient.getQueryData(['auth', 'me'])).toBeUndefined();
    const login = await mountAuth();
    await waitFor(() => expect(login.result.current.isLoading).toBe(false));
    expect(login.result.current.isAuthenticated).toBe(false);
    expect(login.result.current.user).toBeNull();
  });

  it('still announces the NEXT expiry, because a real login re-arms the latch', async () => {
    const network = stubNetwork();
    const first = await signIn();
    network.expire();
    await anAuthedRequest();
    first.unmount();
    expect(onLogout).toHaveBeenCalledOnce();

    // The user logs back in on the same tab: the server answers, which is the
    // one thing allowed to say a session has begun.
    network.restore();
    const second = await signIn();
    // Signing in ends nothing, so it announces nothing.
    expect(onLogout).toHaveBeenCalledOnce();

    network.expire();
    await anAuthedRequest();

    expect(onLogout).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('says nothing for the 401 a logged-out visitor gets', async () => {
    stubNetwork().expire();
    // Nothing has confirmed a session on this tab: the visitor is on /login and
    // the me-query is about to 401 because there is no session, not because one
    // just stopped.
    markSessionEnded();

    const visitor = await mountAuth();
    await waitFor(() => expect(visitor.result.current.isLoading).toBe(false));

    expect(visitor.result.current.isAuthenticated).toBe(false);
    expect(onLogout).not.toHaveBeenCalled();
  });
});
