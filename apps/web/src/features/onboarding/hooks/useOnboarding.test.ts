// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Account, OnboardingPatch, OnboardingState, PositionListItem } from '@tradr/shared';

import { api } from '@/lib/api';

import { ONBOARDING_QUERY_KEY, useOnboarding, useOnboardingPatch } from './useOnboarding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// --- fixtures ---------------------------------------------------------------

// Only the fields the derivation reads matter; the rest of each row is noise
// here and constructing it in full would hide what the test is actually about.
const anAccount = { id: 'acct-1', name: 'Main' } as Account;

function aPosition(id: string, status: 'draft' | 'open' | 'closed'): PositionListItem {
  return { id, status } as PositionListItem;
}

const FRESH: OnboardingState = { status: 'pending', coachMarksSeen: [] };

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

/**
 * Answers the three reads useOnboarding composes, and applies PATCH bodies the
 * way the API does — partial merge, idempotent coach-mark append, response is
 * the merged state. Stateful on purpose: the hook seeds the cache from the
 * response AND invalidates, so a frozen GET stub would answer the follow-up
 * read with the pre-write state and make a working round-trip look broken.
 */
function mockServer(server: {
  accounts?: Account[];
  positions?: PositionListItem[] | Promise<PositionListItem[]>;
  preference?: OnboardingState;
}) {
  const accounts = server.accounts ?? [];
  const positions = server.positions ?? [];
  const stored: OnboardingState = {
    ...(server.preference ?? FRESH),
    coachMarksSeen: [...(server.preference ?? FRESH).coachMarksSeen],
  };
  const snapshot = () => ({ ...stored, coachMarksSeen: [...stored.coachMarksSeen] });

  const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path === '/accounts') return Promise.resolve(accounts) as never;
    if (path === '/positions') return Promise.resolve(positions) as never;
    if (path === '/users/me/onboarding') return Promise.resolve(snapshot()) as never;
    return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
  });

  const patch = vi.spyOn(api, 'patch').mockImplementation((path: string, body?: unknown) => {
    if (path !== '/users/me/onboarding') {
      return Promise.reject(new Error(`unexpected PATCH ${path}`)) as never;
    }
    const sent = body as OnboardingPatch;
    if (sent.status) stored.status = sent.status;
    if (sent.calculatorFirstUsedAt) stored.calculatorFirstUsedAt = sent.calculatorFirstUsedAt;
    if (sent.coachMarkSeen && !stored.coachMarksSeen.includes(sent.coachMarkSeen)) {
      stored.coachMarksSeen.push(sent.coachMarkSeen);
    }
    return Promise.resolve(snapshot()) as never;
  });

  return { get, patch, snapshot };
}

/** The done-vector, in R4.1 presentation order: account, calculator, position, close. */
function doneVector(items: { id: string; done: boolean }[]) {
  return items.map((item) => [item.id, item.done] as const);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- derivation -------------------------------------------------------------

describe('useOnboarding — derived checklist', () => {
  it('a fresh user gets four incomplete items, allComplete false, and status pending', async () => {
    mockServer({ accounts: [], positions: [], preference: FRESH });
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());

    expect(doneVector(result.current.checklist!.items)).toEqual([
      ['account', false],
      ['calculator', false],
      ['position', false],
      ['close', false],
    ]);
    expect(result.current.checklist!.allComplete).toBe(false);
    expect(result.current.preference).toEqual(FRESH);
  });

  it('reads the position list UNFILTERED — no status query parameter is ever sent', async () => {
    const { get } = mockServer({ accounts: [anAccount], positions: [aPosition('p1', 'closed')] });
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());

    // The count feeding item 3 is "positions EVER created". A status-filtered
    // read here is the bug this assertion exists to catch.
    const positionReads = get.mock.calls
      .map(([path]) => path)
      .filter((p) => p.startsWith('/positions'));
    expect(positionReads).toEqual(['/positions']);
  });

  it('a partially-complete user ticks exactly the items their data supports', async () => {
    mockServer({
      accounts: [anAccount],
      positions: [aPosition('p1', 'open')],
      preference: { ...FRESH, calculatorFirstUsedAt: '2026-08-01T10:00:00.000Z' },
    });
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());

    expect(doneVector(result.current.checklist!.items)).toEqual([
      ['account', true],
      ['calculator', true],
      ['position', true],
      ['close', false],
    ]);
    expect(result.current.checklist!.allComplete).toBe(false);
  });

  it('a user whose positions are ALL closed still ticks "log a position" and reaches allComplete', async () => {
    // The regression this test exists for: passing an open-only count would
    // leave item 3 unticked for this user forever, so allComplete could never
    // become true and the checklist would never retire (R4.7).
    mockServer({
      accounts: [anAccount],
      positions: [aPosition('p1', 'closed'), aPosition('p2', 'closed')],
      preference: { ...FRESH, calculatorFirstUsedAt: '2026-08-01T10:00:00.000Z' },
    });
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());

    expect(doneVector(result.current.checklist!.items)).toEqual([
      ['account', true],
      ['calculator', true],
      ['position', true],
      ['close', true],
    ]);
    expect(result.current.checklist!.allComplete).toBe(true);
  });

  it('counts drafts and open positions towards "ever created" but only closed ones towards item 4', async () => {
    mockServer({
      accounts: [anAccount],
      positions: [aPosition('p1', 'draft'), aPosition('p2', 'open')],
    });
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());

    expect(doneVector(result.current.checklist!.items)).toEqual([
      ['account', true],
      ['calculator', false],
      ['position', true],
      ['close', false],
    ]);
  });
});

// --- the in-flight window ---------------------------------------------------

describe('useOnboarding — while the reads are in flight', () => {
  it('reports no checklist at all until every read has landed, then the real one', async () => {
    let releasePositions: (positions: PositionListItem[]) => void = () => {};
    const pendingPositions = new Promise<PositionListItem[]>((resolve) => {
      releasePositions = resolve;
    });
    mockServer({
      accounts: [anAccount],
      positions: pendingPositions,
      preference: { ...FRESH, calculatorFirstUsedAt: '2026-08-01T10:00:00.000Z' },
    });

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    // Accounts and the preference have landed; positions has not. A checklist
    // derived now would show a set-up user four unticked boxes.
    await waitFor(() => expect(result.current.preference).toBeDefined());
    expect(result.current.checklist).toBeUndefined();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      releasePositions([aPosition('p1', 'closed')]);
      await pendingPositions;
    });

    await waitFor(() => expect(result.current.checklist).toBeDefined());
    expect(result.current.checklist!.allComplete).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('reports no checklist when a read fails terminally, and flags the error', async () => {
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === '/positions') return Promise.reject(new Error('positions down')) as never;
      if (path === '/accounts') return Promise.resolve([anAccount]) as never;
      return Promise.resolve(FRESH) as never;
    });
    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.checklist).toBeUndefined();
  });
});

// --- the status gate on the expensive reads ---------------------------------

/** Every path the hook actually asked the API for, in order. */
function readsOf(get: { mock: { calls: unknown[][] } }) {
  return get.mock.calls.map((call) => call[0] as string);
}

/** The two reads that cost real money: `/positions` has no LIMIT. */
function expensiveReadsOf(get: { mock: { calls: unknown[][] } }) {
  return readsOf(get).filter((p) => p.startsWith('/positions') || p.startsWith('/accounts'));
}

describe('useOnboarding — the expensive reads are gated on the stored status', () => {
  // A retired (R4.7) or dismissed (R4.5) user will not be shown a checklist, so
  // fetching every account and every enriched position row to compute one is
  // pure cost — and it is paid on every dashboard mount, forever, growing with
  // the user's history.
  it.each(['done', 'skipped'] as const)(
    'a `%s` user issues NEITHER expensive read and gets a null checklist',
    async (status) => {
      const { get } = mockServer({
        accounts: [anAccount],
        positions: [aPosition('p1', 'closed')],
        preference: { ...FRESH, status },
      });

      const { result } = renderHook(() => useOnboarding(), {
        wrapper: makeWrapper(makeQueryClient()),
      });

      await waitFor(() => expect(result.current.preference?.status).toBe(status));
      // Fetches are kicked off from an effect, so give one a chance to happen
      // before asserting that it never did.
      await act(async () => {
        await Promise.resolve();
      });

      expect(expensiveReadsOf(get)).toEqual([]);
      // The cheap preference read is what tells us the rest is unnecessary, so
      // it must still go out.
      expect(readsOf(get)).toContain('/users/me/onboarding');

      // `null`, not `undefined`: a consumer that cannot tell "no checklist for
      // this user" from "not known yet" would sit on a skeleton forever waiting
      // for reads that are never coming.
      expect(result.current.checklist).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isError).toBe(false);
    },
  );

  it.each(['pending', 'active'] as const)(
    'a `%s` user — who can still be shown a checklist — DOES issue both',
    async (status) => {
      const { get } = mockServer({
        accounts: [anAccount],
        positions: [aPosition('p1', 'closed')],
        preference: { ...FRESH, status, calculatorFirstUsedAt: '2026-08-01T10:00:00.000Z' },
      });

      const { result } = renderHook(() => useOnboarding(), {
        wrapper: makeWrapper(makeQueryClient()),
      });

      // Not `toBeDefined()` — `null` would satisfy that, and `null` is exactly
      // the failure this test is here to catch.
      await waitFor(() => expect(result.current.checklist?.items).toHaveLength(4));

      expect(readsOf(get)).toContain('/accounts');
      expect(readsOf(get)).toContain('/positions');
      expect(result.current.checklist!.allComplete).toBe(true);
    },
  );

  it('a dismissed user who RE-OPENS the checklist still gets a correct one', async () => {
    // The reason gating on `skipped` is safe (R4.5): completion is derived and
    // never stored (R4.2/R4.4), so going quiet loses nothing. Re-opening flips
    // the status the gate reads, both reads fire, and the same counts produce
    // the same answer they would have all along.
    const { get } = mockServer({
      accounts: [anAccount],
      positions: [aPosition('p1', 'closed'), aPosition('p2', 'open')],
      preference: {
        ...FRESH,
        status: 'skipped',
        calculatorFirstUsedAt: '2026-08-01T10:00:00.000Z',
      },
    });

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current.checklist).toBeNull());
    expect(expensiveReadsOf(get)).toEqual([]);

    await act(async () => {
      result.current.setStatus('active');
    });

    await waitFor(() => expect(result.current.checklist?.items).toHaveLength(4));
    expect(doneVector(result.current.checklist!.items)).toEqual([
      ['account', true],
      ['calculator', true],
      ['position', true],
      ['close', true],
    ]);
    expect(readsOf(get)).toContain('/positions');
  });
});

// --- preference writes ------------------------------------------------------

describe('useOnboarding — preference mutations', () => {
  it('dismiss() round-trips to the API and the returned state seeds the cache', async () => {
    const { patch } = mockServer({ accounts: [anAccount], positions: [], preference: FRESH });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useOnboarding(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    await act(async () => {
      result.current.dismiss();
    });

    expect(patch).toHaveBeenCalledWith('/users/me/onboarding', { status: 'skipped' });
    const dismissed: OnboardingState = { status: 'skipped', coachMarksSeen: [] };
    await waitFor(() => expect(result.current.preference).toEqual(dismissed));
    expect(qc.getQueryData(ONBOARDING_QUERY_KEY)).toEqual(dismissed);
  });

  it('a dismissed checklist is recoverable — setStatus("active") reopens it', async () => {
    const { patch } = mockServer({
      accounts: [anAccount],
      positions: [],
      preference: { ...FRESH, status: 'skipped' },
    });

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.preference?.status).toBe('skipped'));

    await act(async () => {
      result.current.setStatus('active');
    });

    expect(patch).toHaveBeenCalledWith('/users/me/onboarding', { status: 'active' });
    await waitFor(() => expect(result.current.preference?.status).toBe('active'));
  });

  it('markCoachMarkSeen() appends ONE key under the singular field name', async () => {
    const { patch } = mockServer({ accounts: [anAccount], positions: [], preference: FRESH });

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.checklist).toBeDefined());

    await act(async () => {
      result.current.markCoachMarkSeen('import');
    });

    // Singular `coachMarkSeen` — the plural array is a 400, and sending the
    // whole set would let one tab shrink another's by omission.
    expect(patch).toHaveBeenCalledWith('/users/me/onboarding', { coachMarkSeen: 'import' });
    await waitFor(() => expect(result.current.preference?.coachMarksSeen).toEqual(['import']));

    // Idempotent server-side, so the hook fires again without checking
    // membership first and the set does not grow duplicates.
    await act(async () => {
      result.current.markCoachMarkSeen('import');
    });
    await waitFor(() => expect(result.current.preference?.coachMarksSeen).toEqual(['import']));
  });

  it('a status write does not carry the rest of the state — the merge is server-side', async () => {
    const { patch } = mockServer({
      accounts: [anAccount],
      positions: [],
      preference: { status: 'active', coachMarksSeen: ['import'] },
    });

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.preference).toBeDefined());

    await act(async () => {
      result.current.setStatus('done');
    });

    expect(patch).toHaveBeenCalledWith('/users/me/onboarding', { status: 'done' });
    const [, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(body)).toEqual(['status']);
    // The coach marks it never sent are still there afterwards.
    await waitFor(() => expect(result.current.preference?.coachMarksSeen).toEqual(['import']));
  });
});

// --- no client-side persistence of progress ---------------------------------

describe('useOnboarding — no client-side progress', () => {
  it('writes nothing to localStorage, through reads or writes', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mockServer({
      accounts: [anAccount],
      positions: [aPosition('p1', 'closed')],
      preference: { ...FRESH, calculatorFirstUsedAt: '2026-08-01T10:00:00.000Z' },
    });

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: makeWrapper(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.checklist?.allComplete).toBe(true));

    await act(async () => {
      result.current.markCoachMarkSeen('import');
    });
    await act(async () => {
      result.current.dismiss();
    });

    // Resumability across sessions and devices comes from re-deriving the
    // checklist from the user's real data (R4.4). Any cached copy here would be
    // a second source of truth that can only ever disagree with it.
    expect(setItem).not.toHaveBeenCalled();
  });
});

// --- the silent write path ---------------------------------------------------

describe('useOnboardingPatch — silent', () => {
  it('toasts a failure by default, and says nothing at all when silent', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue(new Error('boom'));
    const errorToast = vi.mocked(toast.error);
    errorToast.mockClear();

    // The ordinary write is a direct response to a click, so its failure is
    // worth saying out loud.
    const loud = renderHook(() => useOnboardingPatch(), {
      wrapper: makeWrapper(makeQueryClient()),
    });
    await act(async () => {
      loud.result.current.mutate({ status: 'done' });
    });
    await waitFor(() => expect(loud.result.current.isError).toBe(true));
    expect(errorToast).toHaveBeenCalledTimes(1);

    errorToast.mockClear();

    // The calculator's `calculatorFirstUsedAt` write is fire-and-forget behind
    // a calculation the user came for, and a toast about a checklist tick they
    // never asked for is noise. `silent` cannot be passed per-call — TanStack
    // runs the mutation-level onError whatever `mutate` is handed.
    const silent = renderHook(() => useOnboardingPatch({ silent: true }), {
      wrapper: makeWrapper(makeQueryClient()),
    });
    await act(async () => {
      silent.result.current.mutate({ calculatorFirstUsedAt: '2026-08-07T10:00:00.000Z' });
    });
    await waitFor(() => expect(silent.result.current.isError).toBe(true));
    expect(errorToast).not.toHaveBeenCalled();
  });
});
