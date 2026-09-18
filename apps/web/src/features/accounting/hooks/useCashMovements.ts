import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  CashMovementResponse,
  CreateCashMovementInput,
  ReverseCashMovementResponse,
} from '@tradr/shared/schemas/accounting';

import { api } from '@/lib/api';

// Private copy of the reconcile hook's helper (D21) — a six-line reader of the
// parsed error body is not worth a cross-hook import. `api` throws the JSON body
// on a non-2xx (apps/web/src/lib/api.ts), so a 409 surfaces the server's
// "Cash movement already reversed" verbatim.
function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

// Both writes touch the same three read models: the derived balance on the
// accounts list/detail/card (`['accounts']`), the account's ledger page and its
// running balances (`['ledger', accountId]`), and the cross-currency dashboard
// aggregate (`['dashboard', 'totals']`). Mirrors useReconcileBalance.
function invalidateLedgerReads(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string,
): void {
  queryClient.invalidateQueries({ queryKey: ['accounts'] });
  queryClient.invalidateQueries({ queryKey: ['ledger', accountId] });
  queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
}

/**
 * Record a manual deposit or withdrawal for an account (Req 6.6).
 *
 * The client sends the movement kind and a positive magnitude; the server
 * derives direction, entry type and the resulting balance.
 */
export function useRecordCashMovement(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCashMovementInput) =>
      api.post<CashMovementResponse>(`/ledger/${accountId}/cash-movements`, input),
    onSuccess: (_data, input) => {
      invalidateLedgerReads(queryClient, accountId);
      toast.success(input.type === 'deposit' ? 'Deposit recorded' : 'Withdrawal recorded');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to record cash movement'));
    },
  });
}

/**
 * Reverse a manual cash movement by appending a reversal row (Req 7.3).
 *
 * The same invalidation set as recording — the reversal moves the derived
 * balance back and adds a ledger row.
 */
export function useReverseCashMovement(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      api.delete<ReverseCashMovementResponse>(`/ledger/${accountId}/cash-movements/${entryId}`),
    onSuccess: () => {
      invalidateLedgerReads(queryClient, accountId);
      toast.success('Cash movement reversed');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to reverse cash movement'));
    },
  });
}
