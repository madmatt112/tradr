// @vitest-environment jsdom
//
// Both cash-movement hooks share one invalidation set — the derived balance on
// the accounts models, the account's ledger page and the dashboard total — and
// both surface the parsed error body through toast.error. These tests drive the
// real hooks under a QueryClientProvider (no @testing-library/react in this
// monorepo) and assert on the invalidateQueries calls and the toasts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateCashMovementInput } from '@tradr/shared/schemas/accounting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => postMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

const successMock = vi.fn();
const errorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => successMock(...args),
    error: (...args: unknown[]) => errorMock(...args),
  },
}));

import { useRecordCashMovement, useReverseCashMovement } from './useCashMovements';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acc-1';

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function mount(ui: ReactNode, client: QueryClient) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  });
  return { container, root };
}

/** Every queryKey passed to a client's invalidateQueries, in order. */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
}

beforeEach(() => {
  postMock.mockReset();
  deleteMock.mockReset();
  successMock.mockReset();
  errorMock.mockReset();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// useRecordCashMovement
// ---------------------------------------------------------------------------

describe('useRecordCashMovement', () => {
  it('posts, invalidates the three read models, and toasts by movement type on success', async () => {
    postMock.mockResolvedValue({ entry: {}, previousBalance: '0', newBalance: '100' });
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    let mutateAsync: ((input: CreateCashMovementInput) => Promise<unknown>) | null = null;
    function Probe() {
      mutateAsync = useRecordCashMovement(ACCOUNT_ID).mutateAsync;
      return null;
    }
    const { root } = mount(<Probe />, client);
    await act(async () => {
      await mutateAsync?.({ type: 'deposit', amount: '100' });
    });

    expect(postMock).toHaveBeenCalledWith(`/ledger/${ACCOUNT_ID}/cash-movements`, {
      type: 'deposit',
      amount: '100',
    });
    const keys = invalidatedKeys(invalidateSpy);
    expect(keys).toContainEqual(['accounts']);
    expect(keys).toContainEqual(['ledger', ACCOUNT_ID]);
    expect(keys).toContainEqual(['dashboard', 'totals']);
    expect(successMock).toHaveBeenCalledWith('Deposit recorded');
    expect(errorMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('toasts "Withdrawal recorded" when the input type is withdrawal', async () => {
    postMock.mockResolvedValue({ entry: {}, previousBalance: '100', newBalance: '60' });
    const client = makeClient();

    let mutateAsync: ((input: CreateCashMovementInput) => Promise<unknown>) | null = null;
    function Probe() {
      mutateAsync = useRecordCashMovement(ACCOUNT_ID).mutateAsync;
      return null;
    }
    const { root } = mount(<Probe />, client);
    await act(async () => {
      await mutateAsync?.({ type: 'withdrawal', amount: '40' });
    });

    expect(successMock).toHaveBeenCalledWith('Withdrawal recorded');
    act(() => root.unmount());
  });

  it('surfaces a thrown { error: { message } } body through toast.error', async () => {
    postMock.mockRejectedValue({ error: { message: 'Insufficient funds' } });
    const client = makeClient();

    let mutateAsync: ((input: CreateCashMovementInput) => Promise<unknown>) | null = null;
    function Probe() {
      mutateAsync = useRecordCashMovement(ACCOUNT_ID).mutateAsync;
      return null;
    }
    const { root } = mount(<Probe />, client);
    await act(async () => {
      await mutateAsync?.({ type: 'deposit', amount: '100' }).catch(() => {});
    });

    expect(errorMock).toHaveBeenCalledWith('Insufficient funds');
    expect(successMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

// ---------------------------------------------------------------------------
// useReverseCashMovement
// ---------------------------------------------------------------------------

describe('useReverseCashMovement', () => {
  it('deletes, invalidates the same three read models, and toasts on success', async () => {
    deleteMock.mockResolvedValue({ reversal: {}, previousBalance: '100', newBalance: '0' });
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    let mutateAsync: ((entryId: string) => Promise<unknown>) | null = null;
    function Probe() {
      mutateAsync = useReverseCashMovement(ACCOUNT_ID).mutateAsync;
      return null;
    }
    const { root } = mount(<Probe />, client);
    await act(async () => {
      await mutateAsync?.('entry-9');
    });

    expect(deleteMock).toHaveBeenCalledWith(`/ledger/${ACCOUNT_ID}/cash-movements/entry-9`);
    const keys = invalidatedKeys(invalidateSpy);
    expect(keys).toContainEqual(['accounts']);
    expect(keys).toContainEqual(['ledger', ACCOUNT_ID]);
    expect(keys).toContainEqual(['dashboard', 'totals']);
    expect(successMock).toHaveBeenCalledWith('Cash movement reversed');
    expect(errorMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('surfaces a thrown { error: { message } } body (e.g. a 409) through toast.error', async () => {
    deleteMock.mockRejectedValue({ error: { message: 'Cash movement already reversed' } });
    const client = makeClient();

    let mutateAsync: ((entryId: string) => Promise<unknown>) | null = null;
    function Probe() {
      mutateAsync = useReverseCashMovement(ACCOUNT_ID).mutateAsync;
      return null;
    }
    const { root } = mount(<Probe />, client);
    await act(async () => {
      await mutateAsync?.('entry-9').catch(() => {});
    });

    expect(errorMock).toHaveBeenCalledWith('Cash movement already reversed');
    expect(successMock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
