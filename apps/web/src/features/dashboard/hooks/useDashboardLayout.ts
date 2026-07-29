import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

import {
  BODY_LIMIT_BYTES,
  type DashboardLayoutResponse,
  type PutDashboardLayoutRequest,
  type Theme,
} from '@tradr/shared';

import { api, resolveApiUrl } from '../../../lib/api';
import { DEBOUNCE_PUT_MS } from '../grid.constants';

type ThemeValue = Theme;

export function useDashboardLayout() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['dashboard', 'layout'],
    queryFn: () => api.get<DashboardLayoutResponse>('/dashboard/layout'),
    refetchOnWindowFocus: true,
  });

  // Debounce state: holds the pending merged body and the active setTimeout handle.
  const debounceRef = useRef<{
    timeout: ReturnType<typeof setTimeout> | null;
    pending: PutDashboardLayoutRequest | null;
  }>({ timeout: null, pending: null });

  const mutation = useMutation({
    // §D-r3: scope serializes NETWORK calls in TanStack Query v5 (mutationKey does NOT).
    // §D-r4 NOTE: onMutate runs BEFORE canRun is checked (mutation.js:75-115), so two
    //   rapid mutate() calls take their ctx.prev snapshots in parallel. The {widgets, theme}
    //   combinations the dashboard uses are analyzed safe under this interleave; see r3
    //   analysis. Future contributors adding new mutation shapes MUST re-analyze.
    // §D-r4: gcTime: 0 so HMR-orphaned paused mutations don't block new mutations.
    // useAppTheme.setTheme uses the SAME hook (via putTheme below), so all writes to
    // /api/dashboard/layout share this scope.
    scope: { id: 'dashboard-layout' },
    gcTime: 0,
    mutationFn: (body: PutDashboardLayoutRequest) => {
      // §B2-r4: TextEncoder gives true UTF-8 byte length. String.length (UTF-16 code units)
      //   undercounts multi-byte content by up to 4×.
      if (new TextEncoder().encode(JSON.stringify(body)).length > BODY_LIMIT_BYTES) {
        toast.error('Layout too large; remove a widget or reduce its configuration');
        return Promise.reject(new Error('LOCAL_BODY_TOO_LARGE'));
      }
      return api.put<DashboardLayoutResponse>('/dashboard/layout', body);
    },
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: ['dashboard', 'layout'] });
      const prev = queryClient.getQueryData<DashboardLayoutResponse>(['dashboard', 'layout']);
      if (body.widgets !== undefined && prev) {
        queryClient.setQueryData(['dashboard', 'layout'], { ...prev, widgets: body.widgets });
      }
      return { prev };
    },
    onError: (_err, body, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(['dashboard', 'layout'], ctx.prev);
      } else {
        // First-PUT failure path (Req 4.7.3): no prior cache, refetch via GET.
        queryClient.invalidateQueries({ queryKey: ['dashboard', 'layout'] });
      }
      toast.error("Couldn't save your last changes. Retry?", {
        action: { label: 'Retry', onClick: () => mutation.mutate(body) },
      });
    },
    onSuccess: (response, body) => {
      // §J-r3/§J-r4: write widgets ONLY when the client sent them. Cache-miss + theme-only PUT
      // does NOT fall back to response.widgets (which is server-current — possibly the
      // default-built layout for a first-time user). Leaving widgets unwritten means the
      // in-flight GET resolves it later; the grid never flickers to default.
      queryClient.setQueryData(['dashboard', 'layout'], (prev?: DashboardLayoutResponse | null) => {
        if (body.widgets !== undefined) {
          return {
            widgets: response.widgets,
            theme: response.theme,
            updatedAt: response.updatedAt,
          };
        }
        // §J-r4: strict null+undefined check (prev !== null handles a hypothetical
        //   future code path that explicitly cleared the cache to null).
        if (prev !== undefined && prev !== null) {
          return { ...prev, theme: response.theme, updatedAt: response.updatedAt };
        }
        // Cache miss + theme-only PUT: explicit undefined no-op for the updater.
        return undefined;
      });
      if (body.theme !== undefined) {
        queryClient.setQueryData(['users', 'me', 'theme'], { theme: response.theme });
      }
    },
  });

  // `mutation` is a fresh object on every mutation-state transition, so a
  // `scheduleLayoutWrite` that closed over it directly would change identity
  // mid-write. Widget config fix-ups (§K) list their callback in an effect
  // dependency array, and that churn re-fires them — each re-queueing a layout
  // write. Holding the mutation in a ref keeps `scheduleLayoutWrite` stable for
  // the lifetime of the hook.
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  const scheduleLayoutWrite = useCallback(
    (merge: (prev: PutDashboardLayoutRequest) => PutDashboardLayoutRequest) => {
      const state = debounceRef.current;
      const next = merge(state.pending ?? {});
      state.pending = next;
      if (state.timeout) {
        clearTimeout(state.timeout);
      }
      state.timeout = setTimeout(() => {
        const body = state.pending;
        state.timeout = null;
        state.pending = null;
        if (body) {
          mutationRef.current.mutate(body);
        }
      }, DEBOUNCE_PUT_MS);
    },
    [],
  );

  const flushPending = useCallback(() => {
    const state = debounceRef.current;
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    const body = state.pending;
    state.pending = null;
    if (!body) return;
    // §B2-r4: same UTF-8 byte-length pre-check as the mutationFn before firing the
    //   keepalive fetch on beforeunload (Req 1.9).
    if (new TextEncoder().encode(JSON.stringify(body)).length > BODY_LIMIT_BYTES) {
      toast.error('Layout too large; remove a widget or reduce its configuration');
      return;
    }
    // §D-r4 caveat: the keepalive fetch BYPASSES TanStack Query's scope serialization
    //   (it does not go through the mutation hook). §L Safari: response intentionally
    //   not awaited — Safari/iOS may abort the keepalive fetch, but we cannot block the
    //   page-unload path waiting for a response that may never arrive.
    void fetch(resolveApiUrl('/dashboard/layout'), {
      method: 'PUT',
      body: JSON.stringify(body),
      keepalive: true,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  }, []);

  return {
    ...query,
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    flushPending,
    scheduleLayoutWrite,
    // §D-r3: exposed for useAppTheme.setTheme to share the same mutation queue.
    putTheme: (theme: ThemeValue) => mutation.mutateAsync({ theme }),
  };
}
