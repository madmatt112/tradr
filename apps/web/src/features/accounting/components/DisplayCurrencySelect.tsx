import { useMemo } from 'react';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useDisplayCurrencyMutation,
  useDisplayCurrencyQuery,
} from '@/features/accounting/hooks/useDisplayCurrency';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';

/**
 * Dropdown of the currencies the user currently has accounts in. Saves the
 * selection via `useDisplayCurrencyMutation`, which on success invalidates the
 * accounts list, dashboard total, and active ledger queries (per Req 4.11).
 *
 * Mounted on the settings route alongside `ExchangeRatesPage`.
 */
export function DisplayCurrencySelect() {
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const { data: currentDisplayCurrency, isLoading: currencyLoading } = useDisplayCurrencyQuery();
  const mutation = useDisplayCurrencyMutation();

  const currencyOptions = useMemo(() => {
    if (!accounts) return [] as string[];
    return Array.from(new Set(accounts.map((a) => a.currency))).sort();
  }, [accounts]);

  const isLoading = accountsLoading || currencyLoading;
  const selected = currentDisplayCurrency?.currency ?? undefined;
  const hasNoAccounts = !isLoading && currencyOptions.length === 0;

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-lg font-semibold">Display currency</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The currency used for the dashboard cross-currency total. Per-account balances stay in
          their native currency.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="displayCurrency">Currency</Label>
        {isLoading ? (
          <Skeleton className="h-9 w-48" />
        ) : hasNoAccounts ? (
          <p className="text-sm text-muted-foreground">
            Create an account to choose a display currency.
          </p>
        ) : (
          <Select
            value={selected}
            onValueChange={(val) => mutation.mutate(val)}
            disabled={mutation.isPending}
          >
            <SelectTrigger id="displayCurrency" className="w-48 cursor-pointer">
              <SelectValue placeholder="Select currency" />
            </SelectTrigger>
            <SelectContent>
              {currencyOptions.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
