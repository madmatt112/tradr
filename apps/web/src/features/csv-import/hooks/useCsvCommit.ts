import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { CsvCommitRequest, CsvCommitResponse } from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

/**
 * Commit a previewed CSV import (consumes the single-use token). JSON endpoint,
 * so it goes through the shared `api` client.
 *
 * A commit records fills — usually many — in one transaction, and the fills post
 * realized P&L to the ledger just as a manually recorded fill does. So account
 * balances, dashboard totals and performance are all stale the moment it
 * returns, exactly as they are after a close. Announcing it on the bus once,
 * after the whole commit, is what refreshes them: the EventBusBridge owns that
 * key set for every bulk path, so this hook names none of those keys and there
 * is no per-row invalidation to storm the API with.
 */
export function useCsvCommit() {
  const queryClient = useQueryClient();
  return useMutation<CsvCommitResponse, unknown, CsvCommitRequest>({
    mutationFn: (body) => api.post<CsvCommitResponse>('/csv-import/commit', body),
    onSuccess: () => {
      eventBus.publish('accounts:cache-invalidate', { reason: 'csv-imported' });
      // Display hygiene (plan-tiers Component 12): usage.csvImports.used (and
      // the positions/accounts counts) live on the tier key — keep same-page
      // disclosures ("N of 10 imports remaining") fresh after a commit. Billing
      // is this hook's own concern, not a derived-surface refresh, so it stays
      // here rather than on the bus.
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
    },
  });
}
