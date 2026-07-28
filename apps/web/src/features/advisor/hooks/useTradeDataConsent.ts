// useTradeDataConsent — TanStack Query hooks for the trade-data consent flag
// (design §Component 9; REQ-10.1b, REQ-10.3). Wraps the consent endpoints
// (Task 23): GET/PUT /api/advisor/trade-data-consent.
//
// The flag defaults to OFF (REQ-10.1b). The mutation is OPTIMISTIC: the toggle
// flips immediately and ROLLS BACK to the previous value if the PUT fails
// (REQ-10.3), following the existing settings mutation pattern.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const tradeDataConsentKeys = {
  status: () => ['advisor', 'trade-data-consent'] as const,
};

/** GET/PUT response shape — `{ consent: boolean }` (Task 23). */
export interface TradeDataConsentResult {
  consent: boolean;
}

/** REQ-10.1b — read the stored consent flag (defaults to false). */
export function useTradeDataConsent() {
  return useQuery<TradeDataConsentResult>({
    queryKey: tradeDataConsentKeys.status(),
    queryFn: () => api.get<TradeDataConsentResult>('/advisor/trade-data-consent'),
  });
}

/**
 * REQ-10.3 — set the consent flag with an optimistic update. The cache flips
 * immediately; on error it rolls back to the previously-cached value.
 */
export function useSetTradeDataConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (consent: boolean) =>
      api.put<TradeDataConsentResult>('/advisor/trade-data-consent', { consent }),
    onMutate: async (consent) => {
      await queryClient.cancelQueries({ queryKey: tradeDataConsentKeys.status() });
      const previous = queryClient.getQueryData<TradeDataConsentResult>(
        tradeDataConsentKeys.status(),
      );
      queryClient.setQueryData<TradeDataConsentResult>(tradeDataConsentKeys.status(), { consent });
      return { previous };
    },
    onError: (_err, _consent, context) => {
      // Roll back to the previous value on failure (REQ-10.3).
      if (context?.previous !== undefined) {
        queryClient.setQueryData(tradeDataConsentKeys.status(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tradeDataConsentKeys.status() });
    },
  });
}
