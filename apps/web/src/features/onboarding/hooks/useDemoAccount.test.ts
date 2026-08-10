// @vitest-environment jsdom
//
// The two things worth pinning here are the two that are easy to get wrong:
// WHICH account the hook calls the sample one, and that its writes announce
// rather than reach. Mutual exclusion makes "the demo is the user's only
// account" true today, so a hook that inferred it that way would pass every
// happy-path test and be wrong the day the invariant moved — hence the two
// tests that separate the flag from the count.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@tradr/shared';

import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

import { useDemoAccount } from './useDemoAccount';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const REAL_ACCOUNT = { id: 'acct-real', name: 'Main', isDemo: false } as Account;
const DEMO_ACCOUNT = { id: 'acct-demo', name: 'Sample account', isDemo: true } as Account;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function mockAccounts(accounts: Account[]) {
  return vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path === '/accounts') return Promise.resolve(accounts) as never;
    return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
  });
}

function renderDemoAccount(accounts: Account[]) {
  mockAccounts(accounts);
  return renderHook(() => useDemoAccount(), { wrapper: makeWrapper(makeQueryClient()) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDemoAccount — identifying the sample account', () => {
  it('reports no sample data for a user with none', async () => {
    const { result } = renderDemoAccount([REAL_ACCOUNT]);

    await waitFor(() => expect(result.current.isDemoPresent).toBe(false));
    expect(result.current.demoAccount).toBeUndefined();
  });

  it('says no for a user whose ONE account is a real one', async () => {
    // The anti-inference test. "There is exactly one account" is true here and
    // says nothing about sample data; a hook that keyed off the count would
    // announce sample data to a user who has none.
    const { result } = renderDemoAccount([REAL_ACCOUNT]);

    await waitFor(() => expect(result.current.isDemoPresent).toBe(false));
  });

  it('names the flagged account even when it is not the only one', async () => {
    // The other half. Mutual exclusion is enforced on the server and this hook
    // does not restate it: the flag alone decides, so this still identifies the
    // right account in a state the client should never have to reason about.
    const { result } = renderDemoAccount([REAL_ACCOUNT, DEMO_ACCOUNT]);

    await waitFor(() => expect(result.current.isDemoPresent).toBe(true));
    expect(result.current.demoAccount?.id).toBe('acct-demo');
  });

  it('claims nothing while the accounts read is still in flight', () => {
    const { result } = renderDemoAccount([DEMO_ACCOUNT]);

    expect(result.current.isDemoPresent).toBe(false);
    expect(result.current.demoAccount).toBeUndefined();
  });
});

describe('useDemoAccount — seeding', () => {
  it('posts to the seed endpoint with no body and announces it on the bus', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const post = vi.spyOn(api, 'post').mockResolvedValue(DEMO_ACCOUNT as never);
    const { result } = renderDemoAccount([]);

    await act(async () => {
      result.current.seed();
    });

    // No body at all — which user, and what the fixture holds, are the server's.
    expect(post).toHaveBeenCalledWith('/accounts/demo');
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith('accounts:cache-invalidate', {
        reason: 'demo-seeded',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Sample data added');
  });

  it('reports a refused seed in the server’s own words and announces nothing', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    vi.spyOn(api, 'post').mockRejectedValue({
      error: {
        code: 'CONFLICT',
        message: 'Sample data can only be added to an empty account list',
      },
    });
    const { result } = renderDemoAccount([]);

    await act(async () => {
      result.current.seed();
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Sample data can only be added to an empty account list',
      ),
    );
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('useDemoAccount — teardown', () => {
  it('deletes the flagged account by id with the cascade request, then announces it', async () => {
    const publish = vi.spyOn(eventBus, 'publish');
    const del = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
    const { result } = renderDemoAccount([DEMO_ACCOUNT]);
    await waitFor(() => expect(result.current.isDemoPresent).toBe(true));

    await act(async () => {
      result.current.teardown();
    });

    expect(del).toHaveBeenCalledWith('/accounts/acct-demo?cascade=demo');
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith('accounts:cache-invalidate', {
        reason: 'demo-removed',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Sample data removed');
  });

  it('runs the caller’s continuation after the teardown lands', async () => {
    vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
    const onSuccess = vi.fn();
    const { result } = renderDemoAccount([DEMO_ACCOUNT]);
    await waitFor(() => expect(result.current.isDemoPresent).toBe(true));

    await act(async () => {
      result.current.teardown({ onSuccess });
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('does not run the continuation when the teardown fails', async () => {
    vi.spyOn(api, 'delete').mockRejectedValue({ error: { message: 'Nope' } });
    const onSuccess = vi.fn();
    const { result } = renderDemoAccount([DEMO_ACCOUNT]);
    await waitFor(() => expect(result.current.isDemoPresent).toBe(true));

    await act(async () => {
      result.current.teardown({ onSuccess });
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nope'));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('continues straight away, and issues no request, when there is nothing to tear down', async () => {
    const del = vi.spyOn(api, 'delete');
    const onSuccess = vi.fn();
    const { result } = renderDemoAccount([REAL_ACCOUNT]);
    await waitFor(() => expect(result.current.isDemoPresent).toBe(false));

    await act(async () => {
      result.current.teardown({ onSuccess });
    });

    // The caller's next step must not become conditional on which state the
    // user was in — "remove the sample data" with none present is done already.
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
  });
});
