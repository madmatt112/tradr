// useIbkrConnections — TanStack Query hooks for the IBKR Flex connection
// surface (design C10; Req 1.9, 1.10, 7.2). Wraps GET/PUT/DELETE
// /ibkr/connections[/:accountId] (design C2, C9).
//
// SECURITY: the plaintext token and query id are NEVER cached client-side.
// The status query holds only the masking hint (tokenHintTail) and the
// last-fetch record — never token or query-id material — and the save
// mutation passes the plaintext straight into the PUT body without writing
// it to any query cache or hook state.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { IbkrConnectionSave, IbkrConnectionStatus } from '@tradr/shared';

import { api } from '@/lib/api';

export const ibkrConnectionKeys = {
  all: () => ['ibkr', 'connections'] as const,
};

/** Req 7.2 — read the masked status of every IBKR Flex connection. */
export function useIbkrConnections() {
  return useQuery<IbkrConnectionStatus[]>({
    queryKey: ibkrConnectionKeys.all(),
    queryFn: () => api.get<IbkrConnectionStatus[]>('/ibkr/connections'),
  });
}

/**
 * Req 1.9 — save (or replace) the IBKR Flex connection for an account. The
 * plaintext token and query id are sent only in the PUT body; the response
 * carries the masked status only. Invalidates the connections list on
 * success.
 */
export function useSaveIbkrConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, input }: { accountId: string; input: IbkrConnectionSave }) =>
      api.put<IbkrConnectionStatus>(`/ibkr/connections/${accountId}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ibkrConnectionKeys.all() });
    },
  });
}

/** Req 1.9 — remove the IBKR Flex connection for an account. */
export function useDeleteIbkrConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.delete(`/ibkr/connections/${accountId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ibkrConnectionKeys.all() });
    },
  });
}
