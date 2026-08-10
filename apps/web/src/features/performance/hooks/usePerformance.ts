import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

import { api, isUnauthorized } from '@/lib/api';

// ---- Storage keys ----
const INVALID_TZ_KEY = 'perf.invalid_tz_seen';
const RESOLVED_WEEK_START_KEY = 'perf.resolved_week_start';

// ---- Module-local fallbacks (Safari private browsing throws on setItem) ----
let storageWarned = false;
let invalidTzSeenFallback = false;
let resolvedWeekStartFallback: 0 | 1 | null = null;

function warnStorageOnce(err: unknown) {
  if (storageWarned) return;
  storageWarned = true;
  console.warn('[usePerformance] sessionStorage unavailable; using in-memory fallback', err);
}

function readInvalidTzSeen(): boolean {
  try {
    if (sessionStorage.getItem(INVALID_TZ_KEY) === 'true') return true;
  } catch (err) {
    warnStorageOnce(err);
  }
  // Always also consult the in-memory fallback: when `setItem` throws (Safari
  // private mode) `getItem` returns null even though we've already "seen" the
  // INVALID_TIMEZONE error this page-load. Without this OR, two failures in
  // one tab session would both retry → retry storm.
  return invalidTzSeenFallback;
}

function writeInvalidTzSeen(): void {
  try {
    sessionStorage.setItem(INVALID_TZ_KEY, 'true');
  } catch (err) {
    warnStorageOnce(err);
    invalidTzSeenFallback = true;
  }
}

function readResolvedWeekStart(): 0 | 1 | null {
  try {
    const v = sessionStorage.getItem(RESOLVED_WEEK_START_KEY);
    if (v === '0') return 0;
    if (v === '1') return 1;
  } catch (err) {
    warnStorageOnce(err);
  }
  // Fall back to the in-memory record (Safari private mode: setItem throws,
  // getItem returns null, but we still want flip-detection to work within the
  // page lifetime).
  return resolvedWeekStartFallback;
}

function writeResolvedWeekStart(value: 0 | 1): void {
  try {
    sessionStorage.setItem(RESOLVED_WEEK_START_KEY, String(value));
  } catch (err) {
    warnStorageOnce(err);
    resolvedWeekStartFallback = value;
  }
}

// ---- Error-shape helpers ----
type ApiErrorShape = {
  status?: number;
  error?: { code?: string; details?: Record<string, string> };
  message?: string;
};

/**
 * True for a deterministic client error (HTTP 4xx). Re-fetching cannot fix a
 * 4xx (e.g. a 400 VALIDATION_ERROR for an out-of-range query), so these must
 * NOT trigger cache invalidation — otherwise invalidate → refetch → 4xx →
 * invalidate would loop forever.
 */
export function isClientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as ApiErrorShape).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** True when the failure represents an invalid-timezone validation error. */
export function isInvalidTimezoneError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as ApiErrorShape;
  if (e.error?.code === 'INVALID_TIMEZONE') return true;
  if (e.error?.code === 'VALIDATION_ERROR') {
    const tzDetail = e.error.details?.tz;
    if (typeof tzDetail === 'string' && /^invalid timezone/i.test(tzDetail)) return true;
  }
  return false;
}

// ---- Banner signal (week-start flip) ----
type WeekStartFlipListener = (next: 0 | 1) => void;
const weekStartFlipListeners = new Set<WeekStartFlipListener>();

export function onWeekStartFlip(listener: WeekStartFlipListener): () => void {
  weekStartFlipListeners.add(listener);
  return () => {
    weekStartFlipListeners.delete(listener);
  };
}

function emitWeekStartFlip(next: 0 | 1): void {
  for (const l of weekStartFlipListeners) {
    try {
      l(next);
    } catch {
      /* listener errors must not break the query flow */
    }
  }
}

// ---- Test seam: reset module-local state ----
export function __resetUsePerformanceModuleState(): void {
  storageWarned = false;
  invalidTzSeenFallback = false;
  resolvedWeekStartFallback = null;
  weekStartFlipListeners.clear();
}

// ---- Query construction ----
function buildPath(params: PerformanceQueryInput, omitTz: boolean): string {
  const q = new URLSearchParams();
  q.set('granularity', params.granularity);
  q.set('start', params.start);
  q.set('end', params.end);
  if (!omitTz) q.set('tz', params.tz);
  if (params.currency) q.set('currency', params.currency);
  return `/performance?${q.toString()}`;
}

/**
 * Custom retry policy. Returns true for at-most-one INVALID_TIMEZONE retry per session.
 * Exported for tests; consumed by `usePerformance`.
 */
export function performanceRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (!isInvalidTimezoneError(error)) return false;
  if (readInvalidTzSeen()) return false;
  writeInvalidTzSeen();
  return true;
}

/**
 * Error-side handler. Mirrors the `onError` shape used by mutation hooks: 401
 * short-circuits BEFORE any cache invalidation (the `api` module already
 * navigated to /login). Non-401 errors fall through to the caller. Exported
 * for tests.
 */
export function handlePerformanceQueryError(
  err: unknown,
  queryClient: { invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown },
): void {
  if (isUnauthorized(err)) return;
  // Don't invalidate on aborted requests (signal cancellation from cancelQueries
  // or component unmount) — invalidating our own query on abort triggers a
  // refetch, which can be aborted again, producing an infinite loop.
  if (err instanceof Error && err.name === 'AbortError') return;
  // Deterministic client error (HTTP 4xx, e.g. a 400 VALIDATION_ERROR): a
  // refetch would return the same 4xx, so invalidating here would spin an
  // infinite refetch loop. Bail out — recovery requires a new query, not a retry.
  if (isClientError(err)) return;
  // Transient failure (5xx / network): invalidate so sibling performance queries
  // refetch once conditions recover.
  queryClient.invalidateQueries({ queryKey: ['performance'] });
}

/**
 * `params` is `null` while the caller is still waiting on a value it must not
 * guess — today that is the user's stored reporting timezone
 * (`useUserTimezone`). A `null` disables the query outright rather than firing
 * one bucketed by a zone the user never chose, and it means there is no
 * placeholder tz that could leak into a request.
 */
export function usePerformance(params: PerformanceQueryInput | null) {
  const queryClient = useQueryClient();
  const queryKey = ['performance', 'detail', params] as const;

  return useQuery<PerformanceResponse>({
    queryKey,
    enabled: params !== null,
    queryFn: async ({ signal }) => {
      // `enabled` already guarantees this; the guard narrows the type locally
      // rather than asserting non-null.
      if (params === null) throw new Error('performance query ran without params');
      // If the session has already seen INVALID_TIMEZONE, omit `tz` from
      // subsequent requests so the server falls back to its default.
      const omitTz = readInvalidTzSeen();
      const path = buildPath(params, omitTz);
      let data: PerformanceResponse;
      try {
        data = await api.get<PerformanceResponse>(path, { signal });
      } catch (err) {
        handlePerformanceQueryError(err, queryClient);
        throw err;
      }

      // Week-start-flip detection. Compare against last-seen value; on mismatch
      // invalidate the performance cache and emit a banner signal.
      const prev = readResolvedWeekStart();
      if (prev !== null && prev !== data.resolvedWeekStartDay) {
        queryClient.invalidateQueries({ queryKey: ['performance'] });
        emitWeekStartFlip(data.resolvedWeekStartDay);
      }
      writeResolvedWeekStart(data.resolvedWeekStartDay);

      return data;
    },
    retry: performanceRetry,
  });
}
