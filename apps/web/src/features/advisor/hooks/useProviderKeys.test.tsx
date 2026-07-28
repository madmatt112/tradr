// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import {
  providerKeyKeys,
  useDeleteProviderKey,
  useProviderKeys,
  useSaveProviderKey,
} from './useProviderKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const KEY_ID = '22222222-2222-2222-2222-222222222222';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProviderKeys', () => {
  it('fetches the key list from GET /advisor/provider-keys', async () => {
    const response = {
      items: [
        {
          id: KEY_ID,
          providerId: 'claude',
          defaultModel: 'm',
          keyHintTail: 'abcd',
          lastUsedAt: null,
        },
      ],
    };
    vi.mocked(api.get).mockResolvedValue(response);
    const qc = new QueryClient();

    const { result } = renderHook(() => useProviderKeys(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/advisor/provider-keys');
    expect(result.current.data).toEqual(response);
  });

  it('save PUTs the key in the body, invalidates the list, and caches no plaintext', async () => {
    vi.mocked(api.put).mockResolvedValue({
      id: KEY_ID,
      providerId: 'claude',
      defaultModel: 'm',
      keyHintTail: 'wxyz',
      lastUsedAt: null,
      verified: true,
    });
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSaveProviderKey(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({
      providerId: 'claude',
      apiKey: 'sk-secret-plaintext',
      defaultModel: 'm',
    });

    expect(api.put).toHaveBeenCalledWith('/advisor/provider-keys/claude', {
      apiKey: 'sk-secret-plaintext',
      defaultModel: 'm',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: providerKeyKeys.list() });
    // No query cache entry may contain the plaintext key.
    const cacheDump = JSON.stringify(
      qc
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    );
    expect(cacheDump).not.toContain('sk-secret-plaintext');
  });

  it('delete DELETEs the provider key and invalidates the list', async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined);
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteProviderKey(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('claude');

    expect(api.delete).toHaveBeenCalledWith('/advisor/provider-keys/claude');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: providerKeyKeys.list() });
  });
});
