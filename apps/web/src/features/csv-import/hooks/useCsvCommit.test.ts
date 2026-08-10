// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';
import { EventBusBridge } from '@/stores/EventBusBridge';

import { useCsvCommit } from './useCsvCommit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The bridge is mounted alongside the hook, as it is in the real app (_auth.tsx),
// so these assertions cover the whole path a commit actually takes: publish →
// bridge → invalidation.
function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: qc },
      createElement(EventBusBridge),
      children,
    );
  };
}

function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey);
}

const COMMIT_RESPONSE = {
  positionsCreated: 3,
  fillsCreated: 7,
  positionIds: ['p1', 'p2', 'p3'],
  accountId: 'acc-1',
};

afterEach(() => {
  eventBus.__resetForTests();
  vi.restoreAllMocks();
});

describe('useCsvCommit', () => {
  // A CSV import records fills, and fills post realized P&L to the ledger — so a
  // commit moves account balances and dashboard totals exactly as a close does.
  // Without the bus publication these two keys were never invalidated and both
  // surfaces stayed stale until something unrelated refetched.
  it('refreshes balances, dashboard totals and performance after a commit', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(COMMIT_RESPONSE);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCsvCommit(), { wrapper: makeWrapper(qc) });
    await act(() => result.current.mutateAsync({ token: 'tok-1', confirmDuplicates: false }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    expect(invalidatedKeys(invalidate)).toEqual([
      ['accounts'],
      ['positions'],
      ['dashboard', 'totals'],
      ['performance'],
      billingKeys.tier(),
    ]);
  });

  // Bulk path: one announcement for the whole commit, however many rows it wrote.
  // Invalidating per row would put the app into a refetch storm.
  it('invalidates once for the whole commit, not once per imported row', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(COMMIT_RESPONSE);
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCsvCommit(), { wrapper: makeWrapper(qc) });
    await act(() => result.current.mutateAsync({ token: 'tok-1', confirmDuplicates: false }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('accounts:cache-invalidate', { reason: 'csv-imported' });
    // 7 fills across 3 positions, still four derived-surface invalidations + billing.
    expect(invalidate).toHaveBeenCalledTimes(5);
  });

  it('announces nothing when the commit fails', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('token expired'));
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const { result } = renderHook(() => useCsvCommit(), { wrapper: makeWrapper(qc) });
    act(() => result.current.mutate({ token: 'tok-1', confirmDuplicates: false }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(publish).not.toHaveBeenCalled();
  });
});
