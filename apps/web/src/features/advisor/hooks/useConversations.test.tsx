// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import {
  conversationKeys,
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from './useConversations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const CONV_ID = '11111111-1111-1111-1111-111111111111';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConversations', () => {
  it('fetches the conversation list from GET /advisor/conversations', async () => {
    const response = {
      items: [{ id: CONV_ID, title: 'First', providerId: 'claude', model: 'm', updatedAt: 't' }],
      nextCursor: null,
    };
    vi.mocked(api.get).mockResolvedValue(response);
    const qc = new QueryClient();

    const { result } = renderHook(() => useConversations(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/advisor/conversations');
    expect(result.current.data).toEqual(response);
  });

  it('delete invalidates the list and removes the cached detail entry', async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined);
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const remove = vi.spyOn(qc, 'removeQueries');

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(CONV_ID);

    expect(api.delete).toHaveBeenCalledWith(`/advisor/conversations/${CONV_ID}`);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationKeys.list() });
    expect(remove).toHaveBeenCalledWith({ queryKey: conversationKeys.detail(CONV_ID) });
  });

  it('rename PATCHes the conversation and invalidates list + detail', async () => {
    vi.mocked(api.patch).mockResolvedValue({ id: CONV_ID, title: 'Renamed' });
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRenameConversation(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ id: CONV_ID, title: 'Renamed' });

    expect(api.patch).toHaveBeenCalledWith(`/advisor/conversations/${CONV_ID}`, {
      title: 'Renamed',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationKeys.list() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationKeys.detail(CONV_ID) });
  });
});
