import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { CsvCommitRequest, CsvCommitResponse } from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';

/**
 * Commit a previewed CSV import (consumes the single-use token). JSON endpoint,
 * so it goes through the shared `api` client. On success the import is additive
 * to positions/accounts, so we invalidate both caches (design Component 13).
 * The `position:imported` event bus is owned by the `dashboard` spec and does
 * not exist yet, so cache invalidation only for now.
 */
export function useCsvCommit() {
  const queryClient = useQueryClient();
  return useMutation<CsvCommitResponse, unknown, CsvCommitRequest>({
    mutationFn: (body) => api.post<CsvCommitResponse>('/csv-import/commit', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      // Display hygiene (plan-tiers Component 12): usage.csvImports.used (and
      // the positions/accounts counts) live on the tier key — keep same-page
      // disclosures ("N of 10 imports remaining") fresh after a commit.
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
    },
  });
}
