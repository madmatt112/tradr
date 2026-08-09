import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  PositionDetail,
  UpdatePositionInput,
  CreateFillInput,
  CreatedFill,
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

function usePositionMutation<TInput, TResult = unknown>(
  mutationFn: (input: TInput) => Promise<TResult>,
  successMsg: string,
  reason: PositionChangeReason,
  positionId?: string,
  /**
   * A SECOND state change the same request produced, read off its response.
   *
   * One request can move a position twice — an exit fill that balances the
   * entered quantity is recorded AND closes the position, in one transaction.
   * Both are real, both matter to different listeners, and only the server can
   * say whether the second happened, so it is read from the response rather than
   * guessed at here. Return `null` when it did not.
   */
  alsoPublish?: (result: TResult) => PositionChangeReason | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      eventBus.publish('positions:cache-invalidate', { reason, positionId });
      // Second, and in this order, because that is the order it happened in: the
      // fill was recorded, and recording it closed the position.
      const also = alsoPublish?.(result) ?? null;
      if (also !== null) {
        eventBus.publish('positions:cache-invalidate', { reason: also, positionId });
      }
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

// An exit fill that leaves nothing open CLOSES the position, server-side, in the
// same transaction that records it (`addFill` in positions.service.ts) — there is
// no second request to hang a 'closed' event off. So the response says whether it
// happened and this publishes it, exactly as `useClosePosition` would: the close
// posts realized P&L to the ledger and moves the account balance, so the
// balance-derived queries have to be invalidated whether a button or an exit did
// it. The guided walkthrough's close step waits on the same signal.
export function useAddFill(positionId: string) {
  return usePositionMutation<CreateFillInput, CreatedFill>(
    (data) => api.post<CreatedFill>(`/positions/${positionId}/fills`, data),
    'Fill added',
    'fill-added',
    positionId,
    (created) => (created.positionClosed ? 'closed' : null),
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
