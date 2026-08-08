// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, markSessionConfirmed, markSessionEnded, markSessionStarted } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

import { useAuth } from './useAuth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  setIsLoggingOut: vi.fn(),
  markSessionStarted: vi.fn(),
  markSessionConfirmed: vi.fn(),
  markSessionEnded: vi.fn(),
}));

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ id: 'u-1', email: 'a@example.com' });
  vi.mocked(api.post).mockResolvedValue(undefined);
});

afterEach(() => {
  eventBus.__resetForTests();
  vi.clearAllMocks();
});

// Clearing the query cache only drops server state. Anything module-scoped —
// the guided walkthrough's session and its driver.js overlay are the live
// example — survives it, and the next user on this tab would inherit it. The
// announcement is what lets each owner drop its own without `useAuth` importing
// any of them (user-onboarding R5.6).
describe('useAuth — logging out announces the end of the session', () => {
  it('publishes auth:logout after the query cache is cleared', async () => {
    const qc = makeClient();
    const seen: string[] = [];
    vi.spyOn(qc, 'clear').mockImplementation(() => {
      seen.push('cache-cleared');
    });
    eventBus.subscribe('auth:logout', () => {
      seen.push('auth:logout');
    });

    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    result.current.logout.mutate();

    await waitFor(() => expect(seen).toEqual(['cache-cleared', 'auth:logout']));
    expect(navigate).toHaveBeenCalledWith({ to: '/login' });
  });

  it('publishes it even when the logout request fails', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('network down'));
    const onLogout = vi.fn();
    eventBus.subscribe('auth:logout', onLogout);

    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    result.current.logout.mutate();

    // The session is over locally whatever the server said, so the state that
    // belongs to it goes either way.
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
  });

  it('publishes nothing while the user is still signed in', async () => {
    const onLogout = vi.fn();
    eventBus.subscribe('auth:logout', onLogout);

    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    expect(onLogout).not.toHaveBeenCalled();
  });

  // `lib/api` intercepts 401s but cannot tell one that ended a session from the
  // one a logged-out visitor's me-query returns. This hook is what tells it, and
  // it is also what stops the explicit logout below announcing twice.
  //
  // The me-query CONFIRMS, it does not start: a 200 from `/auth/me` says a
  // session exists, and an expiry's cache clear provokes exactly that answer
  // moments after the session ended. Only the login below may re-arm the
  // interception (`lib/api`'s `redirecting`).
  it('tells the api client when a session is confirmed and when it ends', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(markSessionConfirmed).toHaveBeenCalledOnce();
    expect(markSessionStarted).not.toHaveBeenCalled();

    result.current.logout.mutate();

    await waitFor(() => expect(markSessionEnded).toHaveBeenCalledOnce());
  });

  it('declares a session STARTED only for the login answer that created one', async () => {
    vi.mocked(api.post).mockResolvedValue({ user: { id: 'u-1', email: 'a@example.com' } });
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(markSessionStarted).not.toHaveBeenCalled();

    result.current.login.mutate({ email: 'a@example.com', password: 'pw' });

    await waitFor(() => expect(markSessionStarted).toHaveBeenCalledOnce());
  });

  // The declaration follows the ANSWER, not the mount. A remount that re-reads
  // the same cached user is not a second session beginning, and treating it as
  // one is what published `auth:logout` twice for a single expiry and left the
  // /login ↔ /dashboard bounce with nothing to terminate it (`lib/api`'s
  // `markSessionConfirmed`, and the expiry tests next to this file).
  it('does not re-declare a session when a remount reads the user from cache', async () => {
    // `staleTime` only isolates the case: it stops the remount refetching, so
    // the second mount reads the cached user and nothing else. A refetch that
    // DID happen would answer 401 on a session that had ended, which declares
    // nothing either.
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const first = renderHook(() => useAuth(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(first.result.current.isAuthenticated).toBe(true));
    expect(markSessionConfirmed).toHaveBeenCalledOnce();
    first.unmount();

    // /login and _auth both mount `useAuth`, and on this remount the query
    // answers from the cache — no request, so nothing has been confirmed.
    vi.mocked(api.get).mockClear();
    const second = renderHook(() => useAuth(), { wrapper: makeWrapper(qc) });
    expect(second.result.current.isAuthenticated).toBe(true);
    expect(api.get).not.toHaveBeenCalled();

    expect(markSessionConfirmed).toHaveBeenCalledOnce();
  });
});
