// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import {
  useCaptureEntryGreeks,
  useRollLeg,
  useSettleLeg,
  useSettlementContext,
  useUnsettleLeg,
} from './useOptionLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | Settlement-context query does not fire while closed (Req 1.5) | QueryClient wired through; `enabled` starts false | renderHook(() => useSettlementContext(id, enabled)), then rerender with enabled:true | api.get not called while enabled:false; api.get called with the settlement-context path once rerendered enabled:true | tasks.md task 23 Success "the context query does not fire while closed"; design.md C8 `GET /:id/settlement-context` |
 * | Settle posts and invalidates both keys (Req 2.1) | api.post resolves a SettlementResult; QueryClient wired through | useSettleLeg(id).mutateAsync({ outcome: 'worthless' }) | api.post called with POST /positions/:id/settle and the input; invalidateQueries(['positions']) and (['performance']) both called | tasks.md task 23 Prompt "settle ... mutations on the design C8 routes, each invalidating ['positions'] and ['performance']"; design.md C8 `POST /:id/settle` |
 * | Unsettle posts and invalidates both keys (Req 4.1) | api.post resolves undefined (204); QueryClient wired through | useUnsettleLeg(id).mutateAsync({ settlementId }) | api.post called with POST /positions/:id/settlements/:settlementId/unsettle; invalidateQueries(['positions']) and (['performance']) both called | same Prompt; design.md C8 `POST /:id/settlements/:settlementId/unsettle` |
 * | Roll posts and invalidates both keys (Req 5.1) | api.post resolves a RollResult; QueryClient wired through | useRollLeg(id).mutateAsync(rollInput) | api.post called with POST /positions/:id/roll and the input; invalidateQueries(['positions']) and (['performance']) both called | same Prompt; design.md C8 `POST /:id/roll` |
 * | Entry-Greeks capture PUTs and invalidates both keys (Req 6.1) | api.put resolves an EntryGreeksDetail; QueryClient wired through | useCaptureEntryGreeks(id).mutateAsync(input) | api.put called with PUT /positions/:id/entry-greeks and the input; invalidateQueries(['positions']) and (['performance']) both called | same Prompt; design.md C8 `PUT /:id/entry-greeks` |
 */

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const POSITION_ID = '00000000-0000-4000-a000-000000000001';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSettlementContext', () => {
  it('does not fetch while closed, then fetches the settlement-context route once enabled', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({
      legalOutcomes: ['worthless'],
      expiryInstant: '2026-01-16T21:00:00.000Z',
      premium: 1,
      heldRows: [],
      suggestedOutcome: null,
    });
    const qc = makeQueryClient();

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSettlementContext(POSITION_ID, enabled),
      { wrapper: makeWrapper(qc), initialProps: { enabled: false } },
    );

    expect(get).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/positions/${POSITION_ID}/settlement-context`),
    );
  });
});

describe('useSettleLeg', () => {
  it('posts the outcome to /positions/:id/settle and invalidates ["positions"] and ["performance"]', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      settlementId: 'settlement-1',
      legId: POSITION_ID,
      outcome: 'worthless',
      premium: 0,
      quantity: 1,
      settledAt: '2026-01-16T21:00:00.000Z',
      openedPositionIds: [],
      exitedPositionIds: [],
    });
    const qc = makeQueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSettleLeg(POSITION_ID), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ outcome: 'worthless' });

    expect(post).toHaveBeenCalledWith(`/positions/${POSITION_ID}/settle`, {
      outcome: 'worthless',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
  });
});

describe('useUnsettleLeg', () => {
  it('posts to /positions/:id/settlements/:settlementId/unsettle and invalidates ["positions"] and ["performance"]', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined);
    const qc = makeQueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUnsettleLeg(POSITION_ID), {
      wrapper: makeWrapper(qc),
    });
    await result.current.mutateAsync({ settlementId: 'settlement-1' });

    expect(post).toHaveBeenCalledWith(
      `/positions/${POSITION_ID}/settlements/settlement-1/unsettle`,
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
  });
});

describe('useRollLeg', () => {
  it('posts the roll input to /positions/:id/roll and invalidates ["positions"] and ["performance"]', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      rollId: 'roll-1',
      chainId: 'chain-1',
      fromPositionId: POSITION_ID,
      toPositionId: 'new-leg-1',
      newSymbol: 'AAPL260116C00150000',
    });
    const qc = makeQueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const rollInput = {
      newSymbol: 'AAPL260116C00150000',
      quantity: '1',
      closePrice: '1.00',
      openPrice: '1.50',
      rolledAt: '2026-01-10T15:00:00.000Z',
    };

    const { result } = renderHook(() => useRollLeg(POSITION_ID), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(rollInput);

    expect(post).toHaveBeenCalledWith(`/positions/${POSITION_ID}/roll`, rollInput);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
  });
});

describe('useCaptureEntryGreeks', () => {
  it('PUTs the capture input to /positions/:id/entry-greeks and invalidates ["positions"] and ["performance"]', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({
      delta: 0.5,
      gamma: 0.1,
      thetaPerDay: -0.02,
      vegaPerPct: 0.03,
      rhoPerPct: null,
      source: 'black_scholes',
      volatility: 0.3,
      spot: 150,
      rate: 0.05,
      dividendYield: null,
      capturedAt: '2026-01-10T15:00:00.000Z',
    });
    const qc = makeQueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const input = { source: 'black_scholes' as const, volatility: 0.3, spot: 150, rate: 0.05 };

    const { result } = renderHook(() => useCaptureEntryGreeks(POSITION_ID), {
      wrapper: makeWrapper(qc),
    });
    await result.current.mutateAsync(input);

    expect(put).toHaveBeenCalledWith(`/positions/${POSITION_ID}/entry-greeks`, input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['positions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
  });
});
