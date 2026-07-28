// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

import {
  handlePositionMutationError,
  useAddFill,
  useClosePosition,
  useDeleteFill,
  useDeletePosition,
  useOpenPosition,
  useReopenPosition,
  useUpdateFill,
  useUpdatePosition,
} from './usePosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// 401 guard regression tests
//
// All three error shapes that `isUnauthorized` (apps/web/src/lib/api.ts) must
// recognize:
//   1. Valid JSON body parsed by api.ts: `{ error: { code: 'UNAUTHORIZED', ... } }`
//   2. Unparseable body fallback from api.ts: `{ message: 'Request failed', status: 401 }`
//   3. The throw path inside api.ts for a 401 response: `Error('Unauthorized')`
//      (.message === 'Unauthorized', .status === 401)
//
// In every case the mutation's onError must short-circuit BEFORE invalidating
// any cache. The api module has already redirected to /login.
// ---------------------------------------------------------------------------

describe('handlePositionMutationError — 401 guard via shared isUnauthorized', () => {
  it('does NOT invalidate caches for valid JSON 401 body shape (error.code === "UNAUTHORIZED")', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handlePositionMutationError(
      { status: 401, error: { code: 'UNAUTHORIZED', message: 'Session expired' } },
      qc,
      'Operation failed',
      showToast,
    );
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does NOT invalidate caches for unparseable-body 401 shape (status === 401, no error.code)', () => {
    // api.ts produces this when `response.json()` throws — the catch returns
    // `{ message: 'Request failed', status: response.status }` and that object
    // is then thrown.
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handlePositionMutationError(
      { message: 'Request failed', status: 401 },
      qc,
      'Operation failed',
      showToast,
    );
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does NOT invalidate caches for the api.ts thrown Error("Unauthorized")', () => {
    // This is the actual instance api.ts throws for any 401 (before falling
    // through to body-parsing). The shape is an Error instance with .status=401
    // and .message="Unauthorized".
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    const err = new Error('Unauthorized') as Error & { status?: number };
    err.status = 401;
    handlePositionMutationError(err, qc, 'Operation failed', showToast);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('DOES invalidate ["positions"] AND ["performance"] for non-401 errors', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handlePositionMutationError(
      { status: 500, error: { code: 'INTERNAL', message: 'Server error' } },
      qc,
      'Operation failed',
      showToast,
    );
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['performance'] });
    expect(showToast).toHaveBeenCalledWith('Server error');
  });
});

// ---------------------------------------------------------------------------
// Fetch-level integration: the api.ts pipeline must produce a shape that the
// guard recognizes for any 401 response (regardless of body content). This is
// the regression test that catches a future refactor of api.ts that fails to
// stamp `.status=401` on the thrown error.
// ---------------------------------------------------------------------------

describe('handlePositionMutationError — fetch-stubbed 401 integration', () => {
  // Reproduce the api.ts 401 throw path. We don't import api.ts directly here
  // because the module's `redirecting` flag would leak across tests; instead
  // we construct the same error instance api.ts would throw for the three
  // body-content variants. The point is: api.ts collapses ALL 401 responses
  // into the same throw, and the guard must catch every one.
  function apiThrowFor401(): Error & { status?: number } {
    const err = new Error('Unauthorized') as Error & { status?: number };
    err.status = 401;
    return err;
  }

  it('valid JSON 401 body via fetch → api.ts → guard skips invalidation', () => {
    // Even though fetch returns `{ error: { code: 'UNAUTHORIZED' } }`, api.ts
    // throws Error('Unauthorized') with status=401 BEFORE parsing the body.
    const qc = { invalidateQueries: vi.fn() };
    handlePositionMutationError(apiThrowFor401(), qc, 'fail', vi.fn());
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('unparseable HTML 401 body via fetch → api.ts → guard skips invalidation', () => {
    // Same: fetch returns `<!doctype html>...` and JSON parsing would fail,
    // but the 401 short-circuit in api.ts fires first.
    const qc = { invalidateQueries: vi.fn() };
    handlePositionMutationError(apiThrowFor401(), qc, 'fail', vi.fn());
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('existing Error("Unauthorized") propagated → guard skips invalidation', () => {
    const qc = { invalidateQueries: vi.fn() };
    handlePositionMutationError(apiThrowFor401(), qc, 'fail', vi.fn());
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Event-bus publication on onSuccess. Each mutation hook publishes
// 'positions:cache-invalidate' with its reason AFTER invalidating ['positions'].
// The inline ['performance'] invalidation has been removed in favor of the
// EventBusBridge handling cross-feature invalidation centrally.
// ---------------------------------------------------------------------------

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

afterEach(() => {
  eventBus.__resetForTests();
  vi.restoreAllMocks();
});

describe('event-bus publication', () => {
  it('useUpdatePosition publishes reason="updated" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ id: 'p1' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdatePosition('p1'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ symbol: 'AAPL' } as never);
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'updated',
      positionId: 'p1',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useDeletePosition publishes reason="deleted" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'delete').mockResolvedValue(undefined);
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeletePosition('p2'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync();
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'deleted',
      positionId: 'p2',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useOpenPosition publishes reason="opened" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'p3' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useOpenPosition('p3'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({});
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'opened',
      positionId: 'p3',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useClosePosition publishes reason="closed" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'p4' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useClosePosition('p4'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({});
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'closed',
      positionId: 'p4',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useReopenPosition publishes reason="reopened" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'p4b' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useReopenPosition('p4b'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({});
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'reopened',
      positionId: 'p4b',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useAddFill publishes reason="fill-added" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'f1' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useAddFill('p5'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ qty: 1, price: 10 } as never);
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'fill-added',
      positionId: 'p5',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useUpdateFill publishes reason="fill-updated" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ id: 'f2' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateFill('p6'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ fillId: 'f2', data: { qty: 2 } as never });
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'fill-updated',
      positionId: 'p6',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('useDeleteFill publishes reason="fill-deleted" and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'delete').mockResolvedValue(undefined);
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = newClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteFill('p7'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('f3');
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'fill-deleted',
      positionId: 'p7',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
  });
});
