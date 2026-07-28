// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

import { handleCreatePositionError, useCreatePosition } from './usePositions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// 401 guard regression tests for `useCreatePosition` onError.
//
// All three error shapes that `isUnauthorized` (apps/web/src/lib/api.ts) must
// recognize:
//   1. Valid JSON body: `{ error: { code: 'UNAUTHORIZED', ... } }`
//   2. Unparseable body fallback: `{ message: 'Request failed', status: 401 }`
//   3. Error('Unauthorized') instance with .status=401
// ---------------------------------------------------------------------------

describe('handleCreatePositionError — 401 guard via shared isUnauthorized', () => {
  it('does NOT invalidate ["performance"] for valid JSON 401 body (error.code === "UNAUTHORIZED")', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handleCreatePositionError(
      { status: 401, error: { code: 'UNAUTHORIZED', message: 'Session expired' } },
      qc,
      showToast,
    );
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does NOT invalidate ["performance"] for unparseable-body 401 (status === 401)', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handleCreatePositionError({ message: 'Request failed', status: 401 }, qc, showToast);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does NOT invalidate ["performance"] for api.ts thrown Error("Unauthorized")', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    const err = new Error('Unauthorized') as Error & { status?: number };
    err.status = 401;
    handleCreatePositionError(err, qc, showToast);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('DOES invalidate ["performance"] for non-401 errors and toasts the api message', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handleCreatePositionError(
      { status: 422, error: { code: 'VALIDATION_ERROR', message: 'Bad input' } },
      qc,
      showToast,
    );
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['performance'] });
    expect(showToast).toHaveBeenCalledWith('Bad input');
  });

  it('falls back to "Failed to create position" when no error message is available', () => {
    const qc = { invalidateQueries: vi.fn() };
    const showToast = vi.fn();
    handleCreatePositionError(new Error('network down'), qc, showToast);
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['performance'] });
    expect(showToast).toHaveBeenCalledWith('Failed to create position');
  });

  it('suppresses the toast for plan-tier refusal codes (the dialog renders them inline)', () => {
    for (const code of ['TIER_LIMIT_POSITIONS', 'TIER_ACCOUNT_NOT_WRITABLE']) {
      const qc = { invalidateQueries: vi.fn() };
      const showToast = vi.fn();
      handleCreatePositionError({ status: 403, error: { code, message: 'cap' } }, qc, showToast);
      expect(showToast).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Event-bus publication: useCreatePosition publishes 'positions:cache-invalidate'
// with reason='created' and the new position id; the inline ['performance']
// invalidation has been removed in favor of the EventBusBridge.
// ---------------------------------------------------------------------------

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  eventBus.__resetForTests();
  vi.restoreAllMocks();
});

describe('event-bus publication', () => {
  it('useCreatePosition publishes reason="created" with positionId and does NOT invalidate ["performance"]', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'new-pos-123' });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePosition(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ symbol: 'AAPL' } as never);
    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'created',
      positionId: 'new-pos-123',
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['performance'] });
    // Display hygiene (plan-tiers Component 12): a successful create refreshes
    // usage.positions.used on the tier key.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
  });
});
