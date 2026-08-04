import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { ReconcileBalanceResponse } from '@tradr/shared/schemas/accounting';

import { api } from '@/lib/api';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

/**
 * Post a cash balance reconciliation for an account (Req 8).
 *
 * Sends the TARGET balance, not a delta — the server computes the difference
 * inside its transaction, so nothing here has to worry about the balance moving
 * between render and submit.
 *
 * Invalidation set: `['accounts']` (the derived balance appears on the accounts
 * list, the detail page and the balance card), `['ledger', accountId]` (the new
 * row and every running balance after it), and `['dashboard', 'totals']` (the
 * cross-currency aggregate). NOT `['performance']` — that feature is computed
 * from positions and does not read the ledger.
 */
export function useReconcileBalance(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetBalance: string) =>
      api.post<ReconcileBalanceResponse>(`/ledger/${accountId}/reconcile`, { targetBalance }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['ledger', accountId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      toast.success('Balance reconciled');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to reconcile balance'));
    },
  });
}
