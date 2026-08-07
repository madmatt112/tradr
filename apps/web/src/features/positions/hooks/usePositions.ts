import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { CreatePositionInput, Position, PositionListItem } from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api, isUnauthorized } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

type QueryClientLike = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

// The plan-tiers refusal codes the create dialog maps inline (branch on the
// CODE only, never message text) — the generic toast would double-surface them.
const TIER_REFUSAL_CODES = new Set(['TIER_LIMIT_POSITIONS', 'TIER_ACCOUNT_NOT_WRITABLE']);

/** House envelope: the machine-readable code lives at err.error?.code. */
export function getPositionErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

/**
 * Mutation error handler for `useCreatePosition`. 401 short-circuits BEFORE any
 * cache invalidation or toast — the `api` module already navigated to /login.
 * Non-401 errors invalidate `['performance']` so cross-feature views refetch.
 * Exported for tests.
 */
export function handleCreatePositionError(
  err: unknown,
  queryClient: QueryClientLike,
  showToast: (msg: string) => void,
): void {
  if (isUnauthorized(err)) return;
  queryClient.invalidateQueries({ queryKey: ['performance'] });
  // Tier refusals render inline in CreatePositionDialog (plan-tiers REQ-11.5).
  if (TIER_REFUSAL_CODES.has(getPositionErrorCode(err) ?? '')) return;
  const msg =
    typeof err === 'object' && err !== null && 'error' in err
      ? (err as { error?: { message?: string } }).error?.message
      : undefined;
  showToast(msg || 'Failed to create position');
}

/**
 * `GET /positions` has no LIMIT and returns every enriched row, so it is the
 * most expensive list the app fetches. `options.enabled` lets a caller that may
 * not need it at all skip the request entirely; omitted, it fetches as before.
 * A disabled query reports `data: undefined`, `isLoading: false`, `isError: false`.
 */
export function usePositions(
  filters?: { status?: string; accountId?: string },
  options?: { enabled?: boolean },
) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.accountId) params.set('accountId', filters.accountId);
  const query = params.toString();

  return useQuery<PositionListItem[]>({
    queryKey: ['positions', 'list', filters],
    queryFn: () => api.get<PositionListItem[]>(`/positions${query ? `?${query}` : ''}`),
    enabled: options?.enabled,
  });
}

export function useCreatePosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePositionInput) => api.post<Position>('/positions', data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      // Display hygiene (plan-tiers Component 12): usage.positions.used lives
      // on the tier key — keep same-page disclosures fresh after a create.
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
      eventBus.publish('positions:cache-invalidate', {
        reason: 'created',
        positionId: (response as Position).id,
      });
      toast.success('Position created');
    },
    onError: (err: unknown) => {
      handleCreatePositionError(err, queryClient, toast.error);
    },
  });
}
