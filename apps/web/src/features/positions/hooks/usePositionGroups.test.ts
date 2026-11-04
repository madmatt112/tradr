// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

import { useCloseGroup, useCreatePositionGroup } from './usePositionGroups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                             | Pre-condition                                            | Call (seam)                                       | Observable result                                                                          | Source of expected value |
 * |----------------------------------------------------------|-------------------------------------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------|---------------------------|
 * | Close-all success invalidates + publishes per leg        | api.post resolves a 2-leg group; QueryClient wired through | useCloseGroup('group-1').mutateAsync({ exits })     | invalidateQueries(['positions']) and (['performance']) both called; publish called once per leg with reason 'closed' and that leg's positionId | tasks.md task 14 Prompt "a successful close invalidates ['positions'] and ['performance'] and publishes one event per leg with reason closed"; design.md C13 |
 * | Create success invalidates + tier key + publishes per leg| api.post resolves a 2-leg group; QueryClient wired through | useCreatePositionGroup().mutateAsync(input)         | invalidateQueries(['positions']), (['performance']) and billingKeys.tier() all called; publish called once per leg with reason 'created' and that leg's positionId | tasks.md task 14 Prompt "a successful create publishes reason created per leg" + "create also invalidates the tier key as useCreatePosition does"; design.md C13 |
 */

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  eventBus.__resetForTests();
  vi.restoreAllMocks();
});

describe('useCloseGroup', () => {
  it('invalidates ["positions"] and ["performance"], and publishes one cache-invalidate event per leg with reason "closed"', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      id: 'group-1',
      legs: [{ id: 'leg-a' }, { id: 'leg-b' }],
    });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCloseGroup('group-1'), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({
      exits: [
        { positionId: 'leg-a', price: '10' },
        { positionId: 'leg-b', price: '5' },
      ],
    } as never);

    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'closed',
      positionId: 'leg-a',
    });
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'closed',
      positionId: 'leg-b',
    });
  });
});

describe('useCreatePositionGroup', () => {
  it('invalidates ["positions"], ["performance"] and the tier key, and publishes one cache-invalidate event per leg with reason "created"', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      id: 'group-2',
      legs: [{ id: 'leg-c' }, { id: 'leg-d' }],
    });
    const publish = vi.spyOn(eventBus, 'publish');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePositionGroup(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({
      accountId: '00000000-0000-4000-a000-000000000010',
      filledAt: '2026-06-01T12:00:00.000Z',
      legs: [],
    } as never);

    await waitFor(() => expect(publish).toHaveBeenCalled());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'created',
      positionId: 'leg-c',
    });
    expect(publish).toHaveBeenCalledWith('positions:cache-invalidate', {
      reason: 'created',
      positionId: 'leg-d',
    });
  });
});
