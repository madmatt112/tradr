import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  PositionDetail,
  UpdatePositionInput,
  CreateFillInput,
  UpdateFillInput,
  Fill,
  Position,
} from '@tradr/shared';

import { api, isUnauthorized } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';
import type { PositionChangeReason } from '@/stores/events.types';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

type QueryClientLike = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

/**
 * Mutation error handler for position/fill mutations. 401 short-circuits BEFORE
 * any cache invalidation or toast — the `api` module already navigated to
 * /login. Non-401 errors invalidate both `['positions']` and `['performance']`
 * to keep cross-feature views consistent. Exported for tests.
 */
export function handlePositionMutationError(
  err: unknown,
  queryClient: QueryClientLike,
  fallbackMsg: string,
  showToast: (msg: string) => void,
): void {
  if (isUnauthorized(err)) return;
  queryClient.invalidateQueries({ queryKey: ['positions'] });
  queryClient.invalidateQueries({ queryKey: ['performance'] });
  showToast(getErrorMessage(err, fallbackMsg));
}

export function usePosition(id: string) {
  return useQuery<PositionDetail>({
    queryKey: ['positions', 'detail', id],
    queryFn: () => api.get<PositionDetail>(`/positions/${id}`),
  });
}

function usePositionMutation<TInput>(
  mutationFn: (input: TInput) => Promise<unknown>,
  successMsg: string,
  reason: PositionChangeReason,
  positionId?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      eventBus.publish('positions:cache-invalidate', { reason, positionId });
      toast.success(successMsg);
    },
    onError: (err: unknown) => {
      handlePositionMutationError(err, queryClient, 'Operation failed', toast.error);
    },
  });
}

export function useUpdatePosition(id: string) {
  return usePositionMutation<UpdatePositionInput>(
    (data) => api.put<Position>(`/positions/${id}`, data),
    'Position updated',
    'updated',
    id,
  );
}

export function useDeletePosition(id: string) {
  return usePositionMutation<void>(
    () => api.delete(`/positions/${id}`),
    'Position deleted',
    'deleted',
    id,
  );
}

export function useOpenPosition(id: string) {
  return usePositionMutation<{ openedAt?: string }>(
    (data) => api.post<Position>(`/positions/${id}/open`, data),
    'Position opened',
    'opened',
    id,
  );
}

export function useClosePosition(id: string) {
  return usePositionMutation<{ closedAt?: string }>(
    (data) => api.post<Position>(`/positions/${id}/close`, data),
    'Position closed',
    'closed',
    id,
  );
}

// Closed → open, same-day only (R13). Mirrors useClosePosition: on success it
// invalidates ['positions'] (list + this detail) and publishes reason
// 'reopened', which the EventBusBridge maps to the same account-balance query
// invalidation as a close (reopen reverses the prior close's ledger row). A
// prior-day reopen returns 409 and its server message surfaces via the shared
// onError handler.
export function useReopenPosition(id: string) {
  return usePositionMutation<{ reopenedAt?: string }>(
    (data) => api.post<Position>(`/positions/${id}/reopen`, data),
    'Position reopened',
    'reopened',
    id,
  );
}

export function useAddFill(positionId: string) {
  return usePositionMutation<CreateFillInput>(
    (data) => api.post<Fill>(`/positions/${positionId}/fills`, data),
    'Fill added',
    'fill-added',
    positionId,
  );
}

export function useUpdateFill(positionId: string) {
  return usePositionMutation<{ fillId: string; data: UpdateFillInput }>(
    ({ fillId, data }) => api.put<Fill>(`/positions/${positionId}/fills/${fillId}`, data),
    'Fill updated',
    'fill-updated',
    positionId,
  );
}

export function useDeleteFill(positionId: string) {
  return usePositionMutation<string>(
    (fillId) => api.delete(`/positions/${positionId}/fills/${fillId}`),
    'Fill deleted',
    'fill-deleted',
    positionId,
  );
}
