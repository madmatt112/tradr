import { useQuery } from '@tanstack/react-query';

import type { PositionLotsResponse } from '@tradr/shared';

import { api } from '@/lib/api';

/**
 * A position's entry lots for the fill dialog's specific-identification
 * picker. `exitFillId` excludes that exit's own reservation from `available`
 * when editing its selection (design C11); pass `null` while recording a new
 * exit. `enabled` keeps the dialog from fetching while closed or on an entry,
 * where the picker never shows.
 */
export function usePositionLots(positionId: string, exitFillId: string | null, enabled: boolean) {
  return useQuery<PositionLotsResponse>({
    queryKey: ['positions', 'lots', positionId, exitFillId],
    queryFn: () =>
      api.get<PositionLotsResponse>(
        `/positions/${positionId}/lots${exitFillId ? `?exitFillId=${exitFillId}` : ''}`,
      ),
    enabled,
  });
}
