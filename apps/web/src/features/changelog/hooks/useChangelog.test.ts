// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChangelogReleasesResponse } from '@tradr/shared';

import { api } from '@/lib/api';

import { hasNewReleases, useMarkChangelogViewed } from './useChangelog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

function makeRelease(publishedAt: string) {
  return {
    id: '1',
    name: 'v1.2.0',
    tag: 'v1.2.0',
    publishedAt,
    body: 'notes',
    htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v1.2.0',
    prerelease: false,
  };
}

function makeResponse(
  releases: ChangelogReleasesResponse['releases'],
  lastViewedAt: string,
): ChangelogReleasesResponse {
  return {
    releases,
    fetchedAt: '2026-06-12T00:00:00.000Z',
    stale: false,
    lastViewedAt,
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasNewReleases', () => {
  it('returns false when data is undefined', () => {
    expect(hasNewReleases(undefined)).toBe(false);
  });

  it('returns false when the release list is empty', () => {
    expect(hasNewReleases(makeResponse([], '2026-06-01T00:00:00.000Z'))).toBe(false);
  });

  it('returns true when the newest release is newer than the floor', () => {
    expect(
      hasNewReleases(
        makeResponse([makeRelease('2026-06-10T00:00:00.000Z')], '2026-06-01T00:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('returns false when the newest release is older than the floor', () => {
    expect(
      hasNewReleases(
        makeResponse([makeRelease('2026-05-01T00:00:00.000Z')], '2026-06-01T00:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('returns false when the newest release equals the floor (equal is NOT new)', () => {
    expect(
      hasNewReleases(
        makeResponse([makeRelease('2026-06-01T00:00:00.000Z')], '2026-06-01T00:00:00.000Z'),
      ),
    ).toBe(false);
  });
});

describe('useMarkChangelogViewed', () => {
  it('awaits cancelQueries BEFORE setQueryData, then patches lastViewedAt without invalidating', async () => {
    const seeded = makeResponse(
      [makeRelease('2026-06-10T00:00:00.000Z')],
      '2026-06-01T00:00:00.000Z',
    );
    const qc = new QueryClient();
    qc.setQueryData(['changelog', 'releases'], seeded);

    // Hold cancelQueries open so the order is observable: if onSuccess did not
    // await the cancel, setQueryData would fire while the promise is pending.
    let resolveCancel!: () => void;
    const cancelSpy = vi.spyOn(qc, 'cancelQueries').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const setSpy = vi.spyOn(qc, 'setQueryData');
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const refetchSpy = vi.spyOn(qc, 'refetchQueries');
    vi.mocked(api.post).mockResolvedValue({ lastViewedAt: '2026-06-12T08:30:00.000Z' });

    const { result } = renderHook(() => useMarkChangelogViewed(), { wrapper: makeWrapper(qc) });
    result.current.mutate();

    await waitFor(() =>
      expect(cancelSpy).toHaveBeenCalledWith({ queryKey: ['changelog', 'releases'] }),
    );
    // Cancel is still pending — the patch must not have happened yet.
    expect(setSpy).not.toHaveBeenCalled();

    resolveCancel();
    await waitFor(() => expect(setSpy).toHaveBeenCalled());

    expect(api.post).toHaveBeenCalledWith('/changelog/viewed');
    expect(qc.getQueryData(['changelog', 'releases'])).toEqual({
      ...seeded,
      lastViewedAt: '2026-06-12T08:30:00.000Z',
    });
    // Never invalidate/refetch in onSuccess — the in-place patch is the point.
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it('leaves the cache untouched when no releases data is cached', async () => {
    const qc = new QueryClient();
    vi.mocked(api.post).mockResolvedValue({ lastViewedAt: '2026-06-12T08:30:00.000Z' });

    const { result } = renderHook(() => useMarkChangelogViewed(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync();

    expect(qc.getQueryData(['changelog', 'releases'])).toBeUndefined();
  });
});
