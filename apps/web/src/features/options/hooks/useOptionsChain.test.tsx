// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import { useOptionsChain } from './useOptionsChain';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useOptionsChain', () => {
  it('does not fetch when the symbol is empty', () => {
    const qc = new QueryClient();
    renderHook(() => useOptionsChain(''), { wrapper: makeWrapper(qc) });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('fetches the chain with the symbol query param', async () => {
    const response = { configured: true, chain: { symbol: 'AAPL', count: 0, contracts: [] } };
    vi.mocked(api.get).mockResolvedValue(response);
    const qc = new QueryClient();

    const { result } = renderHook(() => useOptionsChain('AAPL'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/advisor/options-chain?symbol=AAPL');
    expect(result.current.data).toEqual(response);
  });

  it('includes the expiration query param when supplied', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: false });
    const qc = new QueryClient();

    const { result } = renderHook(() => useOptionsChain('AAPL', '2025-06-20'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith(
      '/advisor/options-chain?symbol=AAPL&expiration=2025-06-20',
    );
  });
});
