import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';
import { PerformanceQuerySchema } from '@tradr/shared/schemas/performance';

import { PerformancePage } from '@/features/performance/components/PerformancePage';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';

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
  q.set('tz', params.tz);
  if (params.currency) q.set('currency', params.currency);
  return `/performance?${q.toString()}`;
}

export const Route = createFileRoute('/_auth/performance')({
  validateSearch: PerformanceQuerySchema,
  // Re-trigger the loader whenever any search param changes so the prefetch
  // tracks the URL one-to-one. Without `loaderDeps`, TanStack Router would
  // skip subsequent loader calls for the same path.
  loaderDeps: ({ search }) => ({ params: search }),
  loader: async ({ deps }) => {
    const params = deps.params as PerformanceQueryInput;
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
  // Snapshot the validated search params for the cleanup closure. We capture
  // here (not inside the cleanup) so that an in-flight effect-cleanup cancels
  // the *exact* params it was issued under, not whatever the URL has become
  // by the time the user navigates away.
  const params = Route.useSearch() as PerformanceQueryInput;

  useEffect(() => {
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

  return <PerformancePage params={params} />;
}
