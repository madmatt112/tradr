// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';

import { useCreateAccount, useDeleteAccount, useSetWritableAccount } from './useAccounts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// vi.mock is hoisted above the imports — `toast` resolves to this mock.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

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
  vi.restoreAllMocks();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

// ---------------------------------------------------------------------------
// billingKeys.tier() invalidation — plan-tiers Component 12 display hygiene:
// account create/delete and the writable-designation mutation all refresh
// usage.accounts.{used, writableAccountId} in the cache.
// ---------------------------------------------------------------------------

describe('useAccounts — tier-key invalidation (plan-tiers)', () => {
  it('useCreateAccount invalidates billingKeys.tier() on success', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ id: ACCOUNT_ID });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateAccount(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ name: 'A', currency: 'USD' } as never);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
  });

  it('useDeleteAccount invalidates billingKeys.tier() on success', async () => {
    vi.spyOn(api, 'delete').mockResolvedValue(undefined);
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteAccount(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(ACCOUNT_ID);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
  });

  it('useSetWritableAccount PUTs the designation and invalidates billingKeys.tier()', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ writableAccountId: ACCOUNT_ID });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSetWritableAccount(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync(ACCOUNT_ID);

    expect(put).toHaveBeenCalledWith('/accounts/writable', { accountId: ACCOUNT_ID });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.tier() });
    expect(toast.success).toHaveBeenCalledWith('Writable account updated');
  });
});

// ---------------------------------------------------------------------------
// Refusal-code branching (CODE only, never message text): TIER_LIMIT_ACCOUNTS
// renders inline in the create dialog, so the generic toast is suppressed.
// ---------------------------------------------------------------------------

describe('useCreateAccount — TIER_LIMIT_ACCOUNTS toast suppression', () => {
  it('does NOT toast for TIER_LIMIT_ACCOUNTS (the dialog renders it inline)', async () => {
    vi.spyOn(api, 'post').mockRejectedValue({
      status: 403,
      error: { code: 'TIER_LIMIT_ACCOUNTS', message: 'Account limit reached' },
    });
    const qc = makeClient();

    const { result } = renderHook(() => useCreateAccount(), { wrapper: makeWrapper(qc) });
    await expect(
      result.current.mutateAsync({ name: 'A', currency: 'USD' } as never),
    ).rejects.toBeTruthy();

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still toasts the api message for other refusal codes', async () => {
    vi.spyOn(api, 'post').mockRejectedValue({
      status: 409,
      error: { code: 'DUPLICATE_NAME', message: 'Name already taken' },
    });
    const qc = makeClient();

    const { result } = renderHook(() => useCreateAccount(), { wrapper: makeWrapper(qc) });
    await expect(
      result.current.mutateAsync({ name: 'A', currency: 'USD' } as never),
    ).rejects.toBeTruthy();

    expect(toast.error).toHaveBeenCalledWith('Name already taken');
  });
});
