import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { BreakdownQueryInput, BreakdownResponse } from '@tradr/shared';

import { api } from '@/lib/api';
import { clearRejectedTimezone, isTimezoneRejected } from '@/lib/invalidTimezone';

import { handlePerformanceQueryError, performanceRetry } from './usePerformance';

/**
 * Build the breakdown request path. `omitTz` drops `tz` only for the exact zone
 * the server rejected, so the server falls back to its own default — the same
 * rule the series query applies (`usePerformance.ts:185-188`).
 */
function buildBreakdownPath(params: BreakdownQueryInput, omitTz: boolean): string {
  const q = new URLSearchParams();
  q.set('by', params.by);
  q.set('start', params.start);
  q.set('end', params.end);
  if (!omitTz) q.set('tz', params.tz);
  if (params.currency) q.set('currency', params.currency);
  return `/performance/breakdown?${q.toString()}`;
}

/**
 * useBreakdown — the per-dimension breakdown query (design Component 14, R6.2).
 *
 * `params === null` disables the query, exactly as `usePerformance` does while
 * the reporting timezone is still loading: a `null` means there is no zone to
 * key on or send, so no request fires (R6.8).
 *
 * The key sits under the `['performance']` prefix (`['performance', 'breakdown',
 * params]`) so `useUserTimezoneMutation`'s invalidation (`useUserTimezone.ts:213`)
 * and `handlePerformanceQueryError`'s transient-failure invalidation
 * (`usePerformance.ts:164`) both reach it (R6.8). Unlike the series query it does
 * NOT run the week-start-flip check (`usePerformance.ts:203-210`) — that stays
 * with `usePerformance`.
 */
export function useBreakdown(params: BreakdownQueryInput | null) {
  const queryClient = useQueryClient();
  const queryKey = ['performance', 'breakdown', params] as const;

  return useQuery<BreakdownResponse>({
    queryKey,
    enabled: params !== null,
    queryFn: async ({ signal }) => {
      // `enabled` already guarantees this; the guard narrows the type locally.
      if (params === null) throw new Error('breakdown query ran without params');
      // Omit `tz` only for the exact zone the server rejected.
      const omitTz = isTimezoneRejected(params.tz);
      const path = buildBreakdownPath(params, omitTz);
      let data: BreakdownResponse;
      try {
        data = await api.get<BreakdownResponse>(path, { signal });
      } catch (err) {
        handlePerformanceQueryError(err, queryClient);
        throw err;
      }
      // A request that CARRIED a zone and succeeded proves nothing is rejected
      // any more — drop the record so the tz-omitted fallback is temporary.
      if (!omitTz) clearRejectedTimezone();
      return data;
    },
    retry: (failureCount, error) => performanceRetry(failureCount, error, params?.tz),
  });
}
