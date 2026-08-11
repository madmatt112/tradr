// @vitest-environment jsdom
//
// The route loader prefetches the same query the component hook owns, so it
// has to obey the same rejected-timezone record. When it did not, a user whose
// reporting zone the server rejects burned the loader's full retry budget on
// every single navigation to Performance — the hook-side fix was bypassed on
// the primary navigation path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

const getMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  isUnauthorized: () => false,
}));

// The route module pulls in the whole performance page (charts, lazy chunks).
// The loader is what is under test, so a stub component keeps the import cheap.
vi.mock('@/features/performance/components/PerformancePage', () => ({
  PerformancePage: () => null,
}));

import {
  __resetInvalidTimezoneState,
  readRejectedTimezone,
  recordRejectedTimezone,
} from '@/lib/invalidTimezone';
import { queryClient } from '@/lib/queryClient';

import { Route } from './_auth.performance';

const BAD_TZ = 'Foo/Bar';

const PARAMS: PerformanceQueryInput = {
  granularity: 'month',
  start: '2026-01-01T00:00:00.000Z',
  end: '2027-01-01T00:00:00.000Z',
  tz: BAD_TZ,
  currency: 'USD',
};

const TZ_ERROR = { status: 400, error: { code: 'INVALID_TIMEZONE', message: 'Invalid timezone' } };

function buildResponse(): PerformanceResponse {
  return {
    resolvedTimezone: 'UTC',
    resolvedWeekStartDay: 0,
    dataQuality: {
      timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
      historyExcluded: { total: 0, closed_at_null: 0 },
    },
    hasAnyAccounts: true,
    hasAnyClosedPositions: true,
    hasAnyClosedPositionsInSupportedCurrency: true,
    defaultCurrency: 'USD',
    currencies: [],
  } as unknown as PerformanceResponse;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const runLoader = (params: PerformanceQueryInput): Promise<unknown> =>
  (Route.options as any).loader({ deps: { params } });
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every path `api.get` was called with, in order. */
function requestedPaths(): string[] {
  return getMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  sessionStorage.clear();
  __resetInvalidTimezoneState();
  getMock.mockReset();
  queryClient.clear();
  // Keep the real retry COUNT (that is what is under test) but drop the
  // exponential backoff so the failing path resolves inside the test timeout.
  queryClient.setDefaultOptions({ queries: { retryDelay: 0, gcTime: 0, staleTime: 0 } });
});

afterEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({});
});

describe('performance route loader — respects the rejected-timezone record', () => {
  it('omits tz for the recorded zone instead of re-sending it on every navigation', async () => {
    recordRejectedTimezone(BAD_TZ);
    getMock.mockResolvedValue(buildResponse());

    await runLoader(PARAMS);

    expect(requestedPaths()).toHaveLength(1);
    expect(requestedPaths()[0]).not.toContain('tz=');
  });

  it('costs exactly one request for a zone nothing has rejected yet', async () => {
    getMock.mockRejectedValue(TZ_ERROR);

    await runLoader(PARAMS);

    // `ensureQueryData` -> `fetchQuery` forces `retry: false` when the caller
    // sets none, so the prefetch never multiplies a rejected zone into a burst.
    // The one tz-omitted retry, and the record it writes, belong to the hook —
    // this asserts the loader does not grow a competing retry policy.
    expect(requestedPaths()).toHaveLength(1);
    expect(requestedPaths()[0]).toContain(`tz=${encodeURIComponent(BAD_TZ)}`);
    expect(readRejectedTimezone()).toBeNull();
  });

  it('still carries tz for a zone that is not the recorded one', async () => {
    recordRejectedTimezone(BAD_TZ);
    getMock.mockResolvedValue(buildResponse());

    await runLoader({ ...PARAMS, tz: 'Europe/London' });

    expect(requestedPaths()).toHaveLength(1);
    expect(requestedPaths()[0]).toContain('tz=Europe%2FLondon');
  });
});
