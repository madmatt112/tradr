import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';
import { BreakdownDimensionSchema, GranularitySchema } from '@tradr/shared/schemas/performance';

import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { PerformancePage } from '@/features/performance/components/PerformancePage';
import { buildPerformanceDefaults } from '@/features/performance/utils/buildPerformanceDefaults';
import { useUserTimezone } from '@/hooks/useUserTimezone';
import { api } from '@/lib/api';
import { isTimezoneRejected } from '@/lib/invalidTimezone';
import { queryClient } from '@/lib/queryClient';
import { readTzProvenance, writeTzProvenance } from '@/lib/reportingTzProvenance';

// ---- Deep-link-safe search parsing -----------------------------------------
// A bare `/performance` used to CRASH to the root error boundary: the strict
// PerformanceQuerySchema requires granularity/start/end, and TanStack Router
// turns a validateSearch throw into a SearchParamError. The route now accepts
// a PARTIAL search — every field optional, and `.catch(undefined)` so even a
// mangled value degrades to "absent" instead of a crash — and derives the
// monthly-preset defaults at the boundary (anchored at the STORED reporting
// timezone) when the window is incomplete. Garbage that still parses as a
// string (a bad date) flows to the API, whose 400 lands in the page's own
// banner stack rather than a generic error screen.
const PerformanceSearchSchema = z.object({
  granularity: GranularitySchema.optional().catch(undefined),
  start: z.string().optional().catch(undefined),
  end: z.string().optional().catch(undefined),
  tz: z.string().optional().catch(undefined),
  currency: z.string().optional().catch(undefined),
  // The calendar month (`YYYY-MM`) and breakdown dimension are URL state so a
  // shared link and a reload restore them (D5, R6.1). Same degrade-to-absent
  // form as the window params: a malformed value never crashes the route.
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .catch(undefined),
  by: BreakdownDimensionSchema.optional().catch(undefined),
});

type PerformanceSearch = z.infer<typeof PerformanceSearchSchema>;

/** The window is usable once all three required params are present. */
function isComplete(search: PerformanceSearch): search is PerformanceSearch & {
  granularity: NonNullable<PerformanceSearch['granularity']>;
  start: string;
  end: string;
} {
  return search.granularity !== undefined && search.start !== undefined && search.end !== undefined;
}

/** A complete search resolved to the shape the API + page consume. */
function toParams(search: PerformanceSearch): PerformanceQueryInput {
  return {
    granularity: search.granularity!,
    start: search.start!,
    end: search.end!,
    tz: search.tz ?? 'UTC',
    ...(search.currency !== undefined ? { currency: search.currency } : {}),
  };
}

/**
 * The URL-`tz` resync decision (Component 9), extracted so it is testable
 * without a router render. `write` is the zone to record as "the stored zone
 * the URL was last reconciled to" (`null` leaves the record alone); `navigateTo`
 * is the zone to rewrite the URL `tz` to (`null` leaves the URL alone).
 *
 *   - incomplete URL, or the zone still loading → do nothing. The resync runs
 *     only on a complete URL, never on the redirecting bare state.
 *   - empty record → adopt the stored zone but KEEP the URL `tz`, so a fresh
 *     context opening a shared `?tz=X` link is left alone (Usability NFR).
 *   - record equals the stored zone → in step, nothing to do.
 *   - record differs but the URL already carries the stored zone → record only.
 *   - record differs and the URL still carries the old zone → record and rewrite
 *     `tz` (the in-session zone change / stale-reload case, R1.9).
 */
export function decideTzResync(
  complete: boolean,
  timezone: string | undefined,
  recorded: string | null,
  urlTz: string | undefined,
): { write: string | null; navigateTo: string | null } {
  if (!complete || timezone === undefined) return { write: null, navigateTo: null };
  if (recorded === null) return { write: timezone, navigateTo: null };
  if (recorded === timezone) return { write: null, navigateTo: null };
  if (urlTz === timezone) return { write: timezone, navigateTo: null };
  return { write: timezone, navigateTo: timezone };
}

// ---- Shared query options --------------------------------------------------
// The component-side hook (`usePerformance`, Task 26) layers session-scoped
// retry policy + week-start-flip detection on top of the same queryKey. Here
// in the loader we only need to *prefetch* — the hook will read from cache
// on first paint and re-fetch on subsequent param changes.

function buildPath(params: PerformanceQueryInput): string {
  const q = new URLSearchParams();
  q.set('granularity', params.granularity);
  q.set('start', params.start);
  q.set('end', params.end);
  // Same rejected-zone record the hook reads, via the same predicate — a second
  // reader with its own idea of "rejected" is the bug this record was built to
  // end. Without this the prefetch re-sends a zone the server has already
  // refused, so every navigation to Performance opens with a request we know
  // fails. Omitting `tz` lets the server fall back to its own default.
  if (!isTimezoneRejected(params.tz)) q.set('tz', params.tz);
  if (params.currency) q.set('currency', params.currency);
  return `/performance?${q.toString()}`;
}

export const Route = createFileRoute('/_auth/performance')({
  validateSearch: PerformanceSearchSchema,
  // Re-trigger the loader whenever any search param changes so the prefetch
  // tracks the URL one-to-one. Without `loaderDeps`, TanStack Router would
  // skip subsequent loader calls for the same path.
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ deps }) => {
    // An incomplete window has nothing to prefetch — the component is about
    // to derive defaults and replace the URL, which re-runs this loader with
    // the complete search.
    if (!isComplete(deps.search)) return null;
    const params = toParams(deps.search);
    // Best-effort prefetch. Errors are intentionally swallowed here so the
    // component's `usePerformance` hook owns error rendering (banner stack,
    // empty states). Throwing from the loader would bubble to the root error
    // boundary, replacing the in-page banners with a generic error screen.
    try {
      await queryClient.ensureQueryData<PerformanceResponse>({
        queryKey: ['performance', 'detail', params],
        queryFn: ({ signal }) => api.get<PerformanceResponse>(buildPath(params), { signal }),
      });
    } catch {
      // Component will re-fetch via `usePerformance` and surface the error.
    }
    return null;
  },
  component: PerformanceRouteComponent,
});

function PerformanceRouteComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // The stored reporting timezone anchors the derived default window;
  // `undefined` only while the preference query is in flight (on terminal
  // failure the hook degrades to a browser-detected zone and says so).
  const timezone = useUserTimezone();
  const complete = isComplete(search);

  useEffect(() => {
    if (complete || timezone === undefined) return;
    // Derive the monthly preset and REPLACE the bare URL so back does not
    // return to the redirecting state. Anything usable in the partial search
    // (a currency, an explicit tz) survives the merge.
    void navigate({
      search: {
        ...buildPerformanceDefaults(timezone),
        ...(search.tz !== undefined ? { tz: search.tz } : {}),
        ...(search.currency !== undefined ? { currency: search.currency } : {}),
        ...(search.month !== undefined ? { month: search.month } : {}),
        ...(search.by !== undefined ? { by: search.by } : {}),
      },
      replace: true,
    });
  }, [complete, timezone, navigate, search.tz, search.currency, search.month, search.by]);

  // Component 9: keep the URL `tz` in step with the STORED reporting zone, so a
  // zone changed on Settings → Profile re-buckets the calendar and breakdown
  // when the user returns to a complete performance URL or reloads a stale one.
  // It is driven off the reload-durable provenance record, never a per-mount
  // previous value or the mutation's `onSuccess` — neither fires for that flow
  // (R1.9). The defaults effect never runs on a complete URL (`complete` above),
  // so on a complete URL this is the only writer of `tz`.
  useEffect(() => {
    const { write, navigateTo } = decideTzResync(complete, timezone, readTzProvenance(), search.tz);
    if (write !== null) writeTzProvenance(write);
    if (navigateTo !== null) {
      void navigate({ search: (prev) => ({ ...prev, tz: navigateTo }), replace: true });
    }
  }, [complete, timezone, search.tz, navigate]);

  // Snapshot the validated search params for the cleanup closure. We capture
  // here (not inside the cleanup) so that an in-flight effect-cleanup cancels
  // the *exact* params it was issued under, not whatever the URL has become
  // by the time the user navigates away.
  const params = complete ? toParams(search) : null;

  useEffect(() => {
    if (params === null) return;
    return () => {
      // `exact: true` is load-bearing — without it, this would cancel every
      // performance query (including ones the user hasn't navigated away
      // from yet, e.g. a subsequent set of params already in flight).
      void queryClient.cancelQueries({
        queryKey: ['performance', 'detail', params],
        exact: true,
      });
    };
  }, [params]);

  return (
    <>
      <PageHeader page="Performance" />
      {params !== null ? (
        <PerformancePage params={params} />
      ) : (
        // The one-render window while defaults derive (or the zone loads).
        <div data-testid="performance-page" className="space-y-4">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
    </>
  );
}
