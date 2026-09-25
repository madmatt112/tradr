// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api, markSessionEnded, setIsLoggingOut } from '@/lib/api';
import { clearClientSessionState } from '@/lib/sessionTeardown';

import { deletionKeys, useDeleteAccount } from './useAccountDeletion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  setIsLoggingOut: vi.fn(),
  markSessionEnded: vi.fn(),
}));

vi.mock('@/lib/sessionTeardown', () => ({
  clearClientSessionState: vi.fn(),
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDeleteAccount', () => {
  it('deleted: flags logout before the POST, ends the session, clears state and navigates with the deleted notice', async () => {
    vi.mocked(api.post).mockResolvedValue({ outcome: 'deleted' });
    const qc = makeClient();
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ password: 'pw' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(setIsLoggingOut).toHaveBeenCalledWith(true);
    // The session ends on this path, so the flag is deliberately left set.
    expect(setIsLoggingOut).not.toHaveBeenCalledWith(false);
    expect(api.post).toHaveBeenCalledWith('/users/me/deletion', { password: 'pw' });
    expect(markSessionEnded).toHaveBeenCalledOnce();
    expect(clearClientSessionState).toHaveBeenCalledWith(qc);
    expect(navigate).toHaveBeenCalledWith({ to: '/login', search: { deleted: true } });
  });

  it('scheduled: clears the logout flag, stays signed in, refreshes status and billing tier', async () => {
    vi.mocked(api.post).mockResolvedValue({
      outcome: 'scheduled',
      scheduledFor: '2026-10-01T00:00:00.000Z',
    });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ password: 'pw' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(setIsLoggingOut).toHaveBeenCalledWith(true);
    expect(setIsLoggingOut).toHaveBeenCalledWith(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(markSessionEnded).not.toHaveBeenCalled();
    expect(clearClientSessionState).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deletionKeys.status() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
  });

  it('error: clears the logout flag, stays signed in, refreshes status and billing tier', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('403'));
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteAccount(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ password: 'wrong' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(setIsLoggingOut).toHaveBeenCalledWith(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(markSessionEnded).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deletionKeys.status() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
  });
});
