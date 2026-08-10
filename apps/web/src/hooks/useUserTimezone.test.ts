// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';
import { detectBrowserTimezone } from '@/lib/browserTimezone';

import {
  useReportingTimezoneBackfill,
  useUserTimezone,
  useUserTimezoneMutation,
  useUserTimezoneQuery,
} from './useUserTimezone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn() },
}));

vi.mock('@/lib/browserTimezone', () => ({
  detectBrowserTimezone: vi.fn(() => 'America/New_York'),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

function makeClient() {
  return new QueryClient({
    // `retryDelay`, not `retry` — the timezone query sets its own bounded
    // `retry: 2`, which a client default cannot override. Zeroing the delay
    // lets the terminal state be reached without three seconds of backoff.
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.mocked(detectBrowserTimezone).mockReturnValue('America/New_York');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useUserTimezone', () => {
  it('returns the STORED zone read from GET /users/me/timezone', async () => {
    vi.mocked(api.get).mockResolvedValue({ timezone: 'Europe/London', stored: true });
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current).toBe('Europe/London');
    });
    expect(api.get).toHaveBeenCalledWith('/users/me/timezone');
  });

  it('caches under the ["users","me","timezone"] key (the per-preference convention)', async () => {
    vi.mocked(api.get).mockResolvedValue({ timezone: 'Asia/Tokyo', stored: true });
    const qc = makeClient();

    renderHook(() => useUserTimezoneQuery(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(qc.getQueryData(['users', 'me', 'timezone'])).toEqual({
        timezone: 'Asia/Tokyo',
        stored: true,
      });
    });
  });

  it('is undefined until the query settles — no client-side default to disagree with the server', async () => {
    let resolveGet: (value: { timezone: string; stored: boolean }) => void = () => {};
    vi.mocked(api.get).mockReturnValue(
      new Promise<{ timezone: string; stored: boolean }>((resolve) => {
        resolveGet = resolve;
      }),
    );
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });

    // In flight: NOT 'UTC', not the browser zone — undefined, so a consumer
    // gates its bucketed query instead of bucketing by a guess.
    expect(result.current).toBeUndefined();

    resolveGet({ timezone: 'America/Chicago', stored: true });
    await waitFor(() => {
      expect(result.current).toBe('America/Chicago');
    });
  });
});

// ---- Terminal-failure path --------------------------------------------------
// Without one, a failed read leaves every consumer on `undefined` forever: five
// bucketing surfaces stuck on skeletons and an inert Performance nav item, with
// nothing said to the user.

describe('useUserTimezone when the read fails outright', () => {
  it('retries a bounded number of times rather than forever or not at all', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network down'));
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    // One attempt plus two retries. A transient blip self-heals; a real outage
    // still REACHES a terminal state instead of hanging.
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('degrades to the browser zone and SAYS SO, with a retry', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network down'));
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current).toBe('America/New_York');
    });

    const [message, options] = vi.mocked(toast.error).mock.calls.at(-1) as [
      string,
      { id: string; duration: number; action: { label: string; onClick: () => void } },
    ];
    // The zone in use is NAMED. A silent substitution is the thing that must
    // not happen — the user has to be able to see and correct what they are
    // being bucketed by.
    expect(message).toContain('America/New_York');
    expect(options.action.label).toBe('Retry');
    // One id, so six mounted consumers raise one notice, and it stays up.
    expect(options.id).toBe('reporting-timezone-unavailable');
    expect(options.duration).toBe(Infinity);
  });

  it('falls back to the SHARED default when even detection yields nothing', async () => {
    // Not a second source of truth: this is the same constant the server
    // defaults to, reached only once the server has stopped answering.
    vi.mocked(detectBrowserTimezone).mockReturnValue(undefined);
    vi.mocked(api.get).mockRejectedValue(new Error('network down'));
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current).toBe('UTC');
    });
  });

  it('is dismissible — a notice that never expires needs a way out', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network down'));
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });
    await waitFor(() => {
      expect(result.current).toBe('America/New_York');
    });

    const [, options] = vi.mocked(toast.error).mock.calls.at(-1) as [
      string,
      { closeButton?: boolean },
    ];
    // Set per-toast, not on the shared Toaster: `duration: Infinity` with no
    // close button leaves the user stuck with a banner they cannot clear, and
    // arming `closeButton` globally would put an X on every other toast too.
    expect(options.closeButton).toBe(true);
  });

  it('does not outlive the tree that raised it — unmounting (logout) clears the notice', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network down'));
    const qc = makeClient();

    const { result, unmount } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });
    await waitFor(() => {
      expect(result.current).toBe('America/New_York');
    });
    // Still up while the consumer is mounted — the degrade is ongoing.
    expect(toast.dismiss).not.toHaveBeenCalled();

    unmount();

    // Without this, the `duration: Infinity` toast survives logout and sits on
    // the login screen telling a signed-out visitor about their bucketing.
    expect(toast.dismiss).toHaveBeenCalledWith('reporting-timezone-unavailable');
  });

  it('leaves the toaster alone while the read is succeeding', async () => {
    vi.mocked(api.get).mockResolvedValue({ timezone: 'Europe/London', stored: true });
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });
    await waitFor(() => {
      expect(result.current).toBe('Europe/London');
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it('clears the notice once a retry succeeds', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network down'));
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezone(), { wrapper: makeWrapper(qc) });
    await waitFor(() => {
      expect(result.current).toBe('America/New_York');
    });

    vi.mocked(api.get).mockResolvedValue({ timezone: 'Asia/Tokyo', stored: true });
    await qc.refetchQueries({ queryKey: ['users', 'me', 'timezone'] });

    await waitFor(() => {
      expect(result.current).toBe('Asia/Tokyo');
    });
    expect(toast.dismiss).toHaveBeenCalledWith('reporting-timezone-unavailable');
  });
});

// ---- One-time backfill of a pre-migration row -------------------------------
// Every row predating the column reads as the server default `UTC`, but those
// users were previously bucketed by their BROWSER zone. Left alone, a New York
// trader's days would silently shift four or five hours on deploy.

describe('useReportingTimezoneBackfill', () => {
  it('seeds a pre-migration row with the zone that user was already bucketed by', async () => {
    vi.mocked(api.get).mockResolvedValue({ timezone: 'UTC', stored: false });
    vi.mocked(api.put).mockResolvedValue({ timezone: 'America/New_York', stored: true });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    renderHook(() => useReportingTimezoneBackfill(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/users/me/timezone', {
        timezone: 'America/New_York',
      });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users', 'me', 'timezone'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('NEVER overwrites a zone the user actually chose — including a deliberate UTC', async () => {
    // The response body is otherwise identical to the pre-migration one. Only
    // `stored` tells the two apart, which is the entire reason it exists.
    vi.mocked(api.get).mockResolvedValue({ timezone: 'UTC', stored: true });
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezoneQuery(), { wrapper: makeWrapper(qc) });
    renderHook(() => useReportingTimezoneBackfill(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toEqual({ timezone: 'UTC', stored: true });
    });
    expect(api.put).not.toHaveBeenCalled();
  });

  it('runs at most once — re-renders and further unset reads do not write again', async () => {
    vi.mocked(api.get).mockResolvedValue({ timezone: 'UTC', stored: false });
    vi.mocked(api.put).mockResolvedValue({ timezone: 'America/New_York', stored: true });
    const qc = makeClient();

    const { rerender } = renderHook(() => useReportingTimezoneBackfill(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledTimes(1);
    });

    rerender();
    rerender();

    // A second unset read lands — the write has not become visible yet. The
    // payload differs only so that react-query's structural sharing hands the
    // effect a genuinely new value and it actually re-runs; the guard, not a
    // stable object identity, is what has to stop the second write.
    vi.mocked(api.get).mockResolvedValue({ timezone: 'Etc/UTC', stored: false });
    await qc.refetchQueries({ queryKey: ['users', 'me', 'timezone'] });
    rerender();

    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when detection yields nothing — omit, never send a null', async () => {
    vi.mocked(detectBrowserTimezone).mockReturnValue(undefined);
    vi.mocked(api.get).mockResolvedValue({ timezone: 'UTC', stored: false });
    const qc = makeClient();

    const { result } = renderHook(() => useUserTimezoneQuery(), { wrapper: makeWrapper(qc) });
    renderHook(() => useReportingTimezoneBackfill(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    // The server default already covers this case; there is nothing better to
    // store, and `timezone: null` would simply 400.
    expect(api.put).not.toHaveBeenCalled();
  });

  it('is harmless when the write fails: no toast, no throw, nothing blocked', async () => {
    vi.mocked(api.get).mockResolvedValue({ timezone: 'UTC', stored: false });
    vi.mocked(api.put).mockRejectedValue(new Error('write failed'));
    const qc = makeClient();

    const { result } = renderHook(
      () => {
        useReportingTimezoneBackfill();
        return useUserTimezone();
      },
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledTimes(1);
    });
    // The read still works, and the user is told nothing about a write they
    // never asked for.
    expect(result.current).toBe('UTC');
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not delay the value it is seeding — the write is not on the render path', async () => {
    let resolvePut: (value: { timezone: string; stored: boolean }) => void = () => {};
    vi.mocked(api.get).mockResolvedValue({ timezone: 'UTC', stored: false });
    vi.mocked(api.put).mockReturnValue(
      new Promise<{ timezone: string; stored: boolean }>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const qc = makeClient();

    const { result } = renderHook(
      () => {
        useReportingTimezoneBackfill();
        return useUserTimezone();
      },
      { wrapper: makeWrapper(qc) },
    );

    // Consumers already have a zone while the backfill PUT is still in flight.
    await waitFor(() => {
      expect(result.current).toBe('UTC');
    });
    expect(api.put).toHaveBeenCalledTimes(1);

    resolvePut({ timezone: 'America/New_York', stored: true });
  });
});

describe('useUserTimezoneMutation', () => {
  it('PUTs the zone, then drops both the preference and the figures cut in the old zone', async () => {
    vi.mocked(api.put).mockResolvedValue({ timezone: 'Asia/Tokyo', stored: true });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUserTimezoneMutation(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('Asia/Tokyo');

    expect(api.put).toHaveBeenCalledWith('/users/me/timezone', { timezone: 'Asia/Tokyo' });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users', 'me', 'timezone'] });
    });
    // The five bucketing surfaces all read through usePerformance, whose key
    // carries the zone — so the entries cut in the old zone have to go, or a
    // revisit paints figures the user no longer asked for.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['performance'] });
    expect(toast.success).toHaveBeenCalledWith('Reporting timezone updated');
  });

  it('surfaces the server message on failure and leaves the caches alone', async () => {
    vi.mocked(api.put).mockRejectedValue({
      error: { message: 'Must be a valid IANA timezone name' },
    });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUserTimezoneMutation(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync('Mars/Olympus_Mons').catch(() => {});

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Must be a valid IANA timezone name');
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
