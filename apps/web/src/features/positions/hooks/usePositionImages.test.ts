// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionDetail, PositionImage } from '@tradr/shared';

import { api } from '@/lib/api';

import {
  positionImageUrl,
  useDeletePositionImage,
  useUploadPositionImage,
} from './usePositionImages';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function unauthorized(): Error & { status?: number } {
  const err = new Error('Unauthorized') as Error & { status?: number };
  err.status = 401;
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('positionImageUrl', () => {
  it('builds the images path under the API base', () => {
    expect(positionImageUrl('p1', 'img1')).toBe('/api/positions/p1/images/img1');
  });
});

describe('useUploadPositionImage', () => {
  const created: PositionImage = {
    id: 'img1',
    format: 'png',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('appends the created record to the detail cache and invalidates ["positions"]', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(created);
    const qc = newClient();
    qc.setQueryData(['positions', 'detail', 'p1'], { id: 'p1' } as unknown as PositionDetail);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUploadPositionImage('p1'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ format: 'png', dataBase64: 'AAAA' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['positions', 'detail', 'p1'])).toEqual({ id: 'p1', images: [created] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
  });

  it('does not append or invalidate when the upload 401s', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(unauthorized());
    const qc = newClient();
    qc.setQueryData(['positions', 'detail', 'p1'], { id: 'p1' } as unknown as PositionDetail);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUploadPositionImage('p1'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ format: 'png', dataBase64: 'AAAA' }).catch(() => {});
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidate).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(qc.getQueryData(['positions', 'detail', 'p1'])).toEqual({ id: 'p1' });
  });
});

describe('useDeletePositionImage', () => {
  it('invalidates ["positions"] and toasts "Screenshot deleted"', async () => {
    vi.spyOn(api, 'delete').mockResolvedValue(undefined);
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeletePositionImage('p1'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('img1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(toast.success).toHaveBeenCalledWith('Screenshot deleted');
  });

  it('does not invalidate or toast when the delete 401s', async () => {
    vi.spyOn(api, 'delete').mockRejectedValue(unauthorized());
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeletePositionImage('p1'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('img1').catch(() => {});
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidate).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
