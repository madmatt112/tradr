// @vitest-environment jsdom
//
// The route loader prefetches the same query the component hook owns, so it
// has to obey the same rejected-timezone record. When it did not, a user whose
// reporting zone the server rejects burned the loader's full retry budget on
// every single navigation to Performance — the hook-side fix was bypassed on
// the primary navigation path.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  isUnauthorized: () => false,
}));

// The route module pulls in the whole performance page (charts, lazy chunks).
// The loader is what is under test, so a stub component keeps the import cheap.
// It records the `month`/`by` props the route resolves so the invalid-tz case
// below can assert the UTC-fallback month rather than a crash.
const perfPageProps = vi.hoisted(() => ({
  month: null as string | null,
  by: null as string | null,
}));
vi.mock('@/features/performance/components/PerformancePage', () => ({
  PerformancePage: (props: { month: string; by: string }) => {
    perfPageProps.month = props.month;
    perfPageProps.by = props.by;
    return <div data-testid="performance-page-stub" />;
  },
}));

// The stored reporting zone `useUserTimezone` resolves to — mutated per test to
// drive the Component 9 resync effect. `undefined` models the in-flight state.
const tzState = vi.hoisted(() => ({ zone: undefined as string | undefined }));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => tzState.zone,
}));

import {
  __resetInvalidTimezoneState,
  readRejectedTimezone,
  recordRejectedTimezone,
} from '@/lib/invalidTimezone';
import { queryClient } from '@/lib/queryClient';
import {
  __resetTzProvenanceState,
  readTzProvenance,
  writeTzProvenance,
} from '@/lib/reportingTzProvenance';

import { decideTzResync, Route } from './_auth.performance';

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
const runLoader = (params: Partial<PerformanceQueryInput>): Promise<unknown> =>
  (Route.options as any).loader({ deps: { search: params } });

const runValidateSearch = (raw: Record<string, unknown>): unknown =>
  ((Route.options as any).validateSearch as { parse: (v: unknown) => unknown }).parse(raw);
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every path `api.get` was called with, in order. */
function requestedPaths(): string[] {
  return getMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  sessionStorage.clear();
  __resetInvalidTimezoneState();
  __resetTzProvenanceState();
  tzState.zone = undefined;
  perfPageProps.month = null;
  perfPageProps.by = null;
  getMock.mockReset();
  queryClient.clear();
  // Keep the real retry COUNT (that is what is under test) but drop the
  // exponential backoff so the failing path resolves inside the test timeout.
  queryClient.setDefaultOptions({ queries: { retryDelay: 0, gcTime: 0, staleTime: 0 } });
});

afterEach(() => {
  cleanup();
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

// A bare `/performance` used to crash to the root error boundary: the strict
// query schema requires granularity/start/end and TanStack Router turns a
// validateSearch throw into a SearchParamError. The route is deep-link-safe
// now — partial searches parse, garbage degrades to "absent", and the loader
// prefetches nothing until the component derives a complete window.
describe('performance route — deep-link-safe search (visual-redesign 2.4)', () => {
  it('parses an empty search instead of throwing', () => {
    expect(runValidateSearch({})).toEqual({});
  });

  it('degrades a mangled granularity to absent instead of crashing', () => {
    expect(runValidateSearch({ granularity: 'fortnight' })).toEqual({});
  });

  it('keeps partial params that are usable', () => {
    expect(runValidateSearch({ currency: 'USD' })).toEqual({ currency: 'USD' });
  });

  it('prefetches nothing for an incomplete window', async () => {
    getMock.mockResolvedValue(buildResponse());

    await runLoader({ currency: 'USD' });

    expect(requestedPaths()).toHaveLength(0);
  });
});

// ---- Route component render harness (Component 9 resync + R4-2 merge) -------
// Re-host the real route component + validateSearch under a memory-history
// router with the SAME id the file route carries (`/_auth/performance`), so the
// component's `Route.useSearch()` / `useNavigate` resolve against the mounted
// match while the URL lives at `/performance` (the settings-billing test shape).
/* eslint-disable @typescript-eslint/no-explicit-any */
const perfOpts = Route.options as any;

function buildRouter(initialEntry: string) {
  const rootRoute = createRootRoute();
  const authLayout = createRoute({ getParentRoute: () => rootRoute as any, id: '_auth' });
  const performance = createRoute({
    getParentRoute: () => authLayout as any,
    path: '/performance',
    component: perfOpts.component,
    validateSearch: perfOpts.validateSearch,
  });
  const routeTree = rootRoute.addChildren([authLayout.addChildren([performance])]);
  return createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function renderAt(initialEntry: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = buildRouter(initialEntry);
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router };
}

/** The current URL search, as the router parsed it. */
function locationSearch(router: ReturnType<typeof buildRouter>): Record<string, unknown> {
  return router.state.location.search as Record<string, unknown>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const COMPLETE = 'granularity=month&start=2026-01-01T00:00:00.000Z&end=2027-01-01T00:00:00.000Z';

// A stored-zone change made on Settings → Profile must re-bucket the calendar
// and the breakdown when the user returns to a complete performance URL or
// reloads a stale one (Component 9). The resync is driven off the reload-durable
// provenance record, never a per-mount previous value or the mutation's
// onSuccess — neither fires for that flow (R1.9).
describe('performance route — URL tz resync effect (Component 9)', () => {
  it('rewrites a stale URL tz to the stored zone on a complete URL', async () => {
    writeTzProvenance('America/New_York'); // last reconciled to the old zone
    tzState.zone = 'Europe/London'; // Settings → Profile has since moved it

    const { router } = renderAt(`/performance?${COMPLETE}&tz=America%2FNew_York`);

    await waitFor(() => {
      expect(locationSearch(router).tz).toBe('Europe/London');
    });
    expect(readTzProvenance()).toBe('Europe/London');
  });

  it('adopts the stored zone into an empty record and leaves a fresh link tz alone', async () => {
    // No record yet: a fresh browsing context opening a shared `?tz=X` link.
    tzState.zone = 'Europe/London';

    const { router } = renderAt(`/performance?${COMPLETE}&tz=America%2FNew_York`);

    await waitFor(() => {
      expect(readTzProvenance()).toBe('Europe/London'); // adopted
    });
    // Shared-link tz preserved — a fresh context is never rewritten.
    expect(locationSearch(router).tz).toBe('America/New_York');
  });
});

// R4-2: a deep link to `/performance?by=tag` (or `?month=YYYY-MM`) hits the
// incomplete-URL defaults redirect first; `by` and `month` must survive it the
// same way `tz` and `currency` do, so the link lands on a complete URL that
// still carries them.
describe('performance route — defaults redirect carries month and by (R4-2)', () => {
  it('merges month and by into the derived complete URL', async () => {
    tzState.zone = 'UTC';

    const { router } = renderAt('/performance?by=tag&month=2026-05');

    await waitFor(() => {
      // The defaults effect has derived a complete window.
      expect(locationSearch(router).granularity).toBeDefined();
    });
    expect(locationSearch(router).by).toBe('tag');
    expect(locationSearch(router).month).toBe('2026-05');
  });
});

// R2-2: a complete URL carrying an unvalidated `?tz=Foo` must render the page,
// not crash to the root error boundary. The route derives the calendar month
// from `params.tz` through the throw-proof `currentMonthInTz`, which falls back
// to UTC on a bad zone, so the page mounts with the current UTC month.
describe('performance route — invalid tz on a complete URL renders (R2-2)', () => {
  it('renders the page with the UTC-fallback month for a bad ?tz', async () => {
    tzState.zone = 'UTC';

    renderAt(`/performance?${COMPLETE}&tz=Foo`);

    await waitFor(() => {
      expect(screen.getByTestId('performance-page-stub')).toBeTruthy();
    });
    // Bad zone → UTC fallback → the current UTC calendar month.
    expect(perfPageProps.month).toBe(new Date().toISOString().slice(0, 7));
    expect(perfPageProps.by).toBe('symbol');
  });
});

// The resync decision extracted from the effect, tested directly — the guard
// that keeps it from firing on an incomplete URL is only cleanly observable here
// (the defaults redirect completes the URL, after which the resync legitimately
// runs, so the two are indistinguishable at a rendered steady state).
describe('decideTzResync — the Component 9 URL-tz decision', () => {
  it('does nothing on an incomplete URL, even with a stale record', () => {
    expect(decideTzResync(false, 'Europe/London', 'America/New_York', 'America/New_York')).toEqual({
      write: null,
      navigateTo: null,
    });
  });

  it('does nothing while the stored zone is still loading', () => {
    expect(decideTzResync(true, undefined, 'America/New_York', 'America/New_York')).toEqual({
      write: null,
      navigateTo: null,
    });
  });

  it('adopts an empty record and keeps the URL tz', () => {
    expect(decideTzResync(true, 'Europe/London', null, 'America/New_York')).toEqual({
      write: 'Europe/London',
      navigateTo: null,
    });
  });

  it('does nothing when the record already matches the stored zone', () => {
    expect(decideTzResync(true, 'Europe/London', 'Europe/London', 'Europe/London')).toEqual({
      write: null,
      navigateTo: null,
    });
  });

  it('records without navigating when the URL already carries the stored zone', () => {
    expect(decideTzResync(true, 'Europe/London', 'America/New_York', 'Europe/London')).toEqual({
      write: 'Europe/London',
      navigateTo: null,
    });
  });

  it('records and rewrites tz when the record and URL both hold the old zone', () => {
    expect(decideTzResync(true, 'Europe/London', 'America/New_York', 'America/New_York')).toEqual({
      write: 'Europe/London',
      navigateTo: 'Europe/London',
    });
  });
});
