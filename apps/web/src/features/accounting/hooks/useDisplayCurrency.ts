import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api } from '@/lib/api';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

interface DisplayCurrencyResponse {
  currency: string | null;
}

export function useDisplayCurrencyQuery() {
  return useQuery<DisplayCurrencyResponse>({
    queryKey: ['users', 'me', 'display-currency'],
    queryFn: () => api.get<DisplayCurrencyResponse>('/users/me/display-currency'),
  });
}

export function useDisplayCurrencyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (currency: string) =>
      api.put<DisplayCurrencyResponse>('/users/me/display-currency', { currency }),
    onSuccess: async () => {
      // Per expenses-tax Task 22 / v2-10 — cancel any in-flight expenses
      // fetches (prefix covers both fee-rollup and tax-summary) BEFORE
      // invalidating, to avoid stale-display-currency responses landing.
      await queryClient.cancelQueries({ queryKey: ['expenses'] });
      // Per Req 4.11 — invalidate exactly these three keys.
      queryClient.invalidateQueries({ queryKey: ['accounts', 'list'], exact: true });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'], exact: true });
      queryClient.invalidateQueries({ queryKey: ['ledger'], type: 'active' });
      // Reflect the new selection in the DisplayCurrencySelect dropdown.
      queryClient.invalidateQueries({ queryKey: ['users', 'me', 'display-currency'] });
      // Per expenses-tax Task 22 — fee-rollup and tax-summary are display-
      // currency-dependent, so also invalidate those prefixes.
      queryClient.invalidateQueries({ queryKey: ['expenses', 'fee-rollup'] });
      queryClient.invalidateQueries({ queryKey: ['expenses', 'tax-summary'] });
      // Intentionally NOT invalidating ['exchange-rates','list'] or
      // ['accounts','detail',...] — see design §Open Design Question 7.
      toast.success('Display currency updated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update display currency'));
    },
  });
}
