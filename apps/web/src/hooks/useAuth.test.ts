// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

import { useAuth } from './useAuth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  setIsLoggingOut: vi.fn(),
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
});
