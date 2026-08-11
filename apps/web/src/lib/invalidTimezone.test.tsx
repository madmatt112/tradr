// @vitest-environment jsdom
//
// The rejected-timezone record has two owners — the performance query writes
// and reads it, the reporting-timezone preference clears it — and the defect
// this file guards against was that it had no lifecycle at all: once written it
// was never cleared, so every later performance request dropped `tz` and the
// tab stayed pinned to UTC for the rest of its session. These tests drive the
// real hooks end-to-end and assert on the URLs that actually went out.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getMock = vi.fn();
const putMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    put: (...args: unknown[]) => putMock(...args),
  },
  isUnauthorized: () => false,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

import { usePerformance } from '@/features/performance/hooks/usePerformance';
import { useUserTimezoneMutation } from '@/hooks/useUserTimezone';

import {
  __resetInvalidTimezoneState,
  readRejectedTimezone,
  recordRejectedTimezone,
} from './invalidTimezone';

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

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0, staleTime: 0 } },
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

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

/** Every path `api.get` was called with, in order. */
function requestedPaths(): string[] {
  return getMock.mock.calls.map((c) => String(c[0]));
}

function Probe({ params }: { params: PerformanceQueryInput }) {
  usePerformance(params);
  return null;
}

beforeEach(() => {
  sessionStorage.clear();
  __resetInvalidTimezoneState();
  getMock.mockReset();
  putMock.mockReset();
  document.body.innerHTML = '';
});

describe('rejected-timezone record — cleared by a successful performance request', () => {
  it('a later request for a DIFFERENT zone carries tz, and its success clears the record', async () => {
    // First request carries the bad zone and is rejected; the one allowed
    // retry goes out without `tz` and succeeds.
    getMock.mockRejectedValueOnce(TZ_ERROR).mockResolvedValue(buildResponse());

    const { root } = mount(<Probe params={PARAMS} />, makeClient());
    await settle();

    expect(requestedPaths()[0]).toContain(`tz=${encodeURIComponent(BAD_TZ)}`);
    expect(requestedPaths()[1]).not.toContain('tz=');
    // The zone that was actually rejected is what got recorded.
    expect(readRejectedTimezone()).toBe(BAD_TZ);
    act(() => root.unmount());

    // The user corrects the preference and returns; the request must carry the
    // NEW zone. Before the record had a lifecycle this dropped `tz` forever.
    const before = requestedPaths().length;
    const { root: root2 } = mount(
      <Probe params={{ ...PARAMS, tz: 'Europe/London' }} />,
      makeClient(),
    );
    await settle();

    const later = requestedPaths().slice(before);
    expect(later.length).toBeGreaterThan(0);
    expect(later[0]).toContain('tz=Europe%2FLondon');
    // That request carried a zone and succeeded, so nothing is rejected now.
    expect(readRejectedTimezone()).toBeNull();
    act(() => root2.unmount());
  });

  it('a successful request that OMITTED tz leaves the record alone', async () => {
    // Success proves nothing about the recorded zone when the zone was never
    // sent — clearing here would re-arm a request we already know fails.
    recordRejectedTimezone(BAD_TZ);
    getMock.mockResolvedValue(buildResponse());

    const { root } = mount(<Probe params={PARAMS} />, makeClient());
    await settle();

    expect(requestedPaths()[0]).not.toContain('tz=');
    expect(readRejectedTimezone()).toBe(BAD_TZ);
    act(() => root.unmount());
  });
});

describe('rejected-timezone record — cleared by a reporting-timezone change', () => {
  it('useUserTimezoneMutation clears it on success, without any page reload', async () => {
    recordRejectedTimezone(BAD_TZ);
    putMock.mockResolvedValue({ timezone: 'Europe/London', stored: true });

    let mutate: ((tz: string) => void) | null = null;
    function MutationProbe() {
      const m = useUserTimezoneMutation();
      mutate = m.mutate;
      return null;
    }
    const { root } = mount(<MutationProbe />, makeClient());
    await act(async () => {
      mutate?.('Europe/London');
      await Promise.resolve();
    });
    await settle(4);

    expect(putMock).toHaveBeenCalled();
    expect(readRejectedTimezone()).toBeNull();
    act(() => root.unmount());
  });
});
