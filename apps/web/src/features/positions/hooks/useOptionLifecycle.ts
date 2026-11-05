import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CaptureEntryGreeksInput,
  EntryGreeksDetail,
  RollLegInput,
  RollResult,
  SettleLegInput,
  SettlementContext,
  SettlementResult,
} from '@tradr/shared';

import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

// GET /:id/settlement-context (design C8): drives the settle dialog's choice
// of legal outcomes and suggested default. `enabled` is threaded through so
// the query never fires while the dialog is closed — the context is only
// meaningful mid-settlement.
export function useSettlementContext(positionId: string, enabled: boolean) {
  return useQuery<SettlementContext>({
    queryKey: ['positions', positionId, 'settlement-context'],
    queryFn: () => api.get<SettlementContext>(`/positions/${positionId}/settlement-context`),
    enabled,
  });
}

interface UnsettleLegInput {
  settlementId: string;
}

function useLifecycleMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
  positionId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
      // 'updated' is the bus's existing reason for a position state change
      // with no dedicated reason of its own (design C8 Prompt).
      eventBus.publish('positions:cache-invalidate', { reason: 'updated', positionId });
    },
  });
}

// POST /:id/settle (design C8).
export function useSettleLeg(positionId: string) {
  return useLifecycleMutation<SettleLegInput, SettlementResult>(
    (input) => api.post<SettlementResult>(`/positions/${positionId}/settle`, input),
    positionId,
  );
}

// POST /:id/settlements/:settlementId/unsettle (design C8).
export function useUnsettleLeg(positionId: string) {
  return useLifecycleMutation<UnsettleLegInput, void>(
    ({ settlementId }) =>
      api.post<void>(`/positions/${positionId}/settlements/${settlementId}/unsettle`),
    positionId,
  );
}

// POST /:id/roll (design C8).
export function useRollLeg(positionId: string) {
  return useLifecycleMutation<RollLegInput, RollResult>(
    (input) => api.post<RollResult>(`/positions/${positionId}/roll`, input),
    positionId,
  );
}

// PUT /:id/entry-greeks (design C8).
export function useCaptureEntryGreeks(positionId: string) {
  return useLifecycleMutation<CaptureEntryGreeksInput, EntryGreeksDetail>(
    (input) => api.put<EntryGreeksDetail>(`/positions/${positionId}/entry-greeks`, input),
    positionId,
  );
}
