// useMarketDataKey — TanStack Query hooks for the Unusual Whales market-data
// BYOK key surface (design §Component 9; REQ-10.1, REQ-10.4). Wraps the
// market-data-key endpoints (Task 9): GET/PUT/DELETE /api/advisor/market-data-key.
//
// SECURITY: the plaintext key is NEVER cached client-side. The status query
// holds only the masking hint (keyHintTail) + verification flag — never key
// material — and the save mutation passes the plaintext straight into the PUT
// body without writing it to any query cache or hook state. Mutations
// invalidate the status query so the UI reflects the new state.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const marketDataKeyKeys = {
  status: () => ['advisor', 'market-data-key'] as const,
};

/** GET response — masked status only, never key material (REQ-10.4). */
export type MarketDataKeyStatus =
  | { configured: false }
  | { configured: true; keyHintTail: string; verified: boolean };

/** PUT response — the masked status of the freshly saved key. */
export interface SaveMarketDataKeyResult {
  configured: true;
  keyHintTail: string;
  verified: boolean;
}

/** REQ-10.4 — read the masked status of the user's Unusual Whales key. */
export function useMarketDataKey() {
  return useQuery<MarketDataKeyStatus>({
    queryKey: marketDataKeyKeys.status(),
    queryFn: () => api.get<MarketDataKeyStatus>('/advisor/market-data-key'),
  });
}

/**
 * REQ-10.1 — save (or replace) the Unusual Whales key. The plaintext `apiKey`
 * is sent only in the PUT body; it is never returned by the API nor stored in
 * cache. Invalidates the status query on success.
 */
export function useSaveMarketDataKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      api.put<SaveMarketDataKeyResult>('/advisor/market-data-key', { apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketDataKeyKeys.status() });
    },
  });
}

/** REQ-10.1 — delete the Unusual Whales key, then refetch the status. */
export function useDeleteMarketDataKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/advisor/market-data-key'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketDataKeyKeys.status() });
    },
  });
}
