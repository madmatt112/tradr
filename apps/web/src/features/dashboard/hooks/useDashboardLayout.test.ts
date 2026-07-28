// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DashboardLayoutResponse,
  PutDashboardLayoutRequest,
  WidgetPlacement,
} from '@tradr/shared';

import { api } from '@/lib/api';

import { useDashboardLayout } from './useDashboardLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const QUERY_KEY = ['dashboard', 'layout'] as const;

const sampleWidget: WidgetPlacement = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'stats-summary',
  x: 0,
  y: 0,
  w: 4,
  h: 1,
};

const initialResponse: DashboardLayoutResponse = {
  widgets: [sampleWidget],
  theme: 'light',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useDashboardLayout', () => {
  it('initial GET resolves and populates the cache with {widgets, theme, updatedAt}', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(initialResponse);
    const qc = makeQueryClient();

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData<DashboardLayoutResponse>(QUERY_KEY)).toEqual(initialResponse);
  });

  it('successful mutate with combined body writes both keys to cache via onSuccess', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(initialResponse);
    const updated: DashboardLayoutResponse = {
      widgets: [{ ...sampleWidget, x: 4 }],
      theme: 'dark',
      updatedAt: '2026-05-02T00:00:00.000Z',
    };
    vi.spyOn(api, 'put').mockResolvedValue(updated);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.mutateAsync({ widgets: updated.widgets, theme: 'dark' });
    });

    expect(qc.getQueryData<DashboardLayoutResponse>(QUERY_KEY)).toEqual(updated);
    expect(qc.getQueryData<{ theme: string }>(['users', 'me', 'theme'])).toEqual({ theme: 'dark' });
  });

  it('mutate failure rolls back to ctx.prev and fires toast.error with a Retry action', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(initialResponse);
    vi.spyOn(api, 'put').mockRejectedValue(new Error('boom'));

    const qc = makeQueryClient();
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const optimisticWidgets: WidgetPlacement[] = [{ ...sampleWidget, x: 8 }];
    await act(async () => {
      await result.current
        .mutateAsync({ widgets: optimisticWidgets })
        .catch(() => undefined);
    });

    await waitFor(() =>
      expect(qc.getQueryData<DashboardLayoutResponse>(QUERY_KEY)).toEqual(initialResponse),
    );

    const errSpy = vi.mocked(toast.error);
    expect(errSpy).toHaveBeenCalled();
    const lastCall = errSpy.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("Couldn't save your last changes. Retry?");
    const opts = lastCall[1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('Retry');
    expect(typeof opts.action.onClick).toBe('function');
  });

  it('first-PUT failure (no prev in context) invalidates ["dashboard","layout"] to refetch', async () => {
    // No initial GET success — set query data manually never; ensure prev is undefined.
    const qc = makeQueryClient();
    // Mock GET to keep query pending so cache stays empty.
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, 'put').mockRejectedValue(new Error('first-put-fail'));

    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current
        .mutateAsync({ widgets: [sampleWidget] })
        .catch(() => undefined);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboard', 'layout'] });
  });

  it('§B2-r4: body-size pre-check rejects with LOCAL_BODY_TOO_LARGE when UTF-8 byte length > 16384', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(initialResponse);
    const putSpy = vi.spyOn(api, 'put').mockResolvedValue(initialResponse);
    const qc = makeQueryClient();
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // 5000 chars of a 4-byte UTF-8 emoji (surrogate pair) = String.length 10000 (UTF-16 units)
    // = 20000 UTF-8 bytes. Both > 16384 bytes AND String.length (10000) < 16384.
    // This proves the check is UTF-8-byte-aware, not String.length-based.
    const big = '\u{1F600}'.repeat(5000);
    expect(big.length).toBeLessThan(16384);
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(16384);

    const huge: PutDashboardLayoutRequest = {
      widgets: [{ ...sampleWidget, config: { blob: big } }],
    };

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync(huge);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('LOCAL_BODY_TOO_LARGE');
    expect(putSpy).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Layout too large; remove a widget or reduce its configuration',
    );
  });

  it('§D-r3: two mutate calls within 50ms serialize via scope — request 2 fires only after request 1 settles', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(initialResponse);

    let resolve1: ((v: DashboardLayoutResponse) => void) | null = null;
    const put = vi.fn().mockImplementation((_path: string, body: PutDashboardLayoutRequest) => {
      if (body.widgets !== undefined && body.theme === undefined) {
        return new Promise<DashboardLayoutResponse>((res) => {
          resolve1 = res;
        });
      }
      return Promise.resolve({
        widgets: initialResponse.widgets,
        theme: body.theme ?? 'light',
        updatedAt: '2026-05-03T00:00:00.000Z',
      });
    });
    vi.spyOn(api, 'put').mockImplementation(put as never);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Fire both mutations rapidly. Request 1 hangs; request 2 should NOT call api.put
    // until request 1 settles (§D-r3 scope serialization).
    let p1: Promise<unknown> | undefined;
    let p2: Promise<unknown> | undefined;
    act(() => {
      p1 = result.current.mutateAsync({ widgets: [{ ...sampleWidget, x: 4 }] });
      p2 = result.current.putTheme('dark');
    });

    // Wait until request 1 fires; request 2 must remain queued by scope, not invoked.
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // Give the microtask + event-loop queue extra ticks to confirm request 2 doesn't slip through.
    await new Promise((r) => setTimeout(r, 20));

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toEqual({ widgets: [{ ...sampleWidget, x: 4 }] });

    // Settle request 1.
    await act(async () => {
      resolve1!({
        widgets: [{ ...sampleWidget, x: 4 }],
        theme: 'light',
        updatedAt: '2026-05-03T00:00:00.000Z',
      });
      await p1;
      await p2;
    });

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][1]).toEqual({ theme: 'dark' });
  });

  it('§J-r3: theme-only PUT with empty cache leaves widgets unwritten (no fallback to response.widgets)', async () => {
    // GET rejects so the cache stays empty (no in-flight to hang cancelQueries).
    vi.spyOn(api, 'get').mockRejectedValue(new Error('no-cache'));
    const serverResp: DashboardLayoutResponse = {
      widgets: [{ ...sampleWidget, x: 8 }],
      theme: 'dark',
      updatedAt: '2026-05-04T00:00:00.000Z',
    };
    vi.spyOn(api, 'put').mockResolvedValue(serverResp);

    const qc = makeQueryClient();

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });
    // Wait for the failed GET to settle, then ensure no cached data is present.
    await waitFor(() => expect(result.current.isError).toBe(true));
    qc.removeQueries({ queryKey: QUERY_KEY });
    expect(qc.getQueryData(QUERY_KEY)).toBeUndefined();

    await act(async () => {
      await result.current.mutateAsync({ theme: 'dark' });
    });

    const cached = qc.getQueryData<DashboardLayoutResponse | undefined>(QUERY_KEY);
    expect(cached?.widgets).toBeUndefined();
    await waitFor(() =>
      expect(qc.getQueryData<{ theme: string }>(['users', 'me', 'theme'])).toEqual({
        theme: 'dark',
      }),
    );
  });

  it('flushPending size check: pending body exceeding 16384 bytes triggers toast.error and does NOT call fetch', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get').mockResolvedValue(initialResponse);
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: makeWrapper(qc) });

    // Wait for initial GET via fake timers — manually flush microtasks.
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));

    const big = '\u{1F600}'.repeat(5000); // > 16384 bytes UTF-8
    const huge: PutDashboardLayoutRequest = {
      widgets: [{ ...sampleWidget, config: { blob: big } }],
    };

    // Schedule a write but do NOT let the debounce fire — flushPending should consume it.
    act(() => {
      result.current.scheduleLayoutWrite(() => huge);
    });

    // Clear any prior fetch calls from initial GET (api.get uses global fetch internally).
    fetchSpy.mockClear();

    act(() => {
      result.current.flushPending();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Layout too large; remove a widget or reduce its configuration',
    );
  });
});
