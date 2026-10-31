import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { TransferLinkResponse } from '@tradr/shared';

import { api } from '@/lib/api';

/**
 * An exit fill's in-kind transfer link and eligible candidates (design C7).
 * `enabled` keeps the dialog from fetching while closed or on anything but an
 * exit edit, where the transfer-link section never shows.
 */
export function useTransferLink(positionId: string, fillId: string | null, enabled: boolean) {
  return useQuery<TransferLinkResponse>({
    queryKey: ['positions', 'transfer-link', positionId, fillId],
    queryFn: () =>
      api.get<TransferLinkResponse>(`/positions/${positionId}/fills/${fillId}/transfer-link`),
    enabled,
  });
}

export function useSetTransferLink(positionId: string, fillId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryFillId: string) =>
      api.put(`/positions/${positionId}/fills/${fillId}/transfer-link`, { entryFillId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['positions', 'transfer-link', positionId, fillId],
      });
      queryClient.invalidateQueries({ queryKey: ['expenses', 'tax-summary'] });
    },
  });
}

export function useRemoveTransferLink(positionId: string, fillId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/positions/${positionId}/fills/${fillId}/transfer-link`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['positions', 'transfer-link', positionId, fillId],
      });
      queryClient.invalidateQueries({ queryKey: ['expenses', 'tax-summary'] });
    },
  });
}
