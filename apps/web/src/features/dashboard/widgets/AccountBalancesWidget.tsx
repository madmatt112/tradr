import { Link } from '@tanstack/react-router';

import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardTotalQuery } from '@/features/accounting/hooks/useDashboardTotal';
import { useMissingRatePrompt } from '@/features/accounting/hooks/useMissingRatePrompt';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { CrossCurrencyTotal } from '@/features/dashboard/components/CrossCurrencyTotal';
import { formatMoney } from '@/lib/format';

/**
 * Account Balances widget (Req 6.4).
 *
 * - Multi-currency users (>1 distinct currency): reuses `<CrossCurrencyTotal />`.
 * - Single-currency users: per-account list with total from `useDashboardTotalQuery.total`.
 * - `displayCurrency == null`: per-account list + "Set display currency" CTA.
 *
 * A missing-rate banner is shown when `useMissingRatePrompt` reports a prompt.
 */
function AccountBalancesWidget() {
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const { data: total, isLoading: totalLoading } = useDashboardTotalQuery();
  const { shouldPrompt, missingPairs, deeplinkTo } = useMissingRatePrompt();

  if (accountsLoading || !accounts) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        title="No accounts yet."
        description="Create an account to start tracking balances."
        action={
          <Link
            to="/accounts"
            className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline"
          >
            Go to accounts
          </Link>
        }
      />
    );
  }

  const distinctCurrencies = new Set(accounts.map((a) => a.currency));
  const isMultiCurrency = distinctCurrencies.size > 1;
  const displayCurrency = total?.displayCurrency ?? null;

  const banner = shouldPrompt ? (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-warning/50 bg-warning/10 px-3 py-2 text-sm">
      <span>
        Missing exchange rate
        {missingPairs.length > 1 ? 's' : ''}:{' '}
        {missingPairs.map((p) => `${p.baseCurrency} → ${p.quoteCurrency}`).join(', ')}
      </span>
      {deeplinkTo && (
        <a
          href={deeplinkTo}
          className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline"
        >
          Enter rate
        </a>
      )}
    </div>
  ) : null;

  // Multi-currency: defer entirely to <CrossCurrencyTotal />, which has its own
  // missing-rate UX. We don't duplicate its logic.
  if (isMultiCurrency) {
    return <CrossCurrencyTotal />;
  }

  // Single-currency (or displayCurrency == null) view: per-account list.
  const accountCurrency = accounts[0]?.currency ?? null;
  const totalCurrency = displayCurrency ?? accountCurrency;

  return (
    <div className="space-y-3">
      {banner}
      <ul className="divide-y divide-border">
        {accounts.map((account) => (
          <li key={account.id} className="flex items-center justify-between py-2">
            <span className="font-medium">{account.name}</span>
            <div className="flex flex-col items-end">
              <Numeric
                value={account.balance != null && account.currency ? account.balance : null}
                kind="money"
                currency={account.currency ?? undefined}
                direction="none"
                className="text-muted-foreground"
              />
              {/*
                Cash / positions split (ledger-balances Req 10) — the two halves
                of the balance above, shown only when the account actually holds
                open positions. A flat account's split is all cash, so the second
                line would just repeat the first.
              */}
              {account.cash != null &&
                account.positionValue != null &&
                Number(account.positionValue) !== 0 && (
                  <span className="text-xs text-muted-foreground">
                    {formatMoney(account.cash, account.currency ?? 'USD')} cash ·{' '}
                    {formatMoney(account.positionValue, account.currency ?? 'USD')} pos
                  </span>
                )}
            </div>
          </li>
        ))}
      </ul>
      {totalCurrency && !totalLoading && total?.total != null ? (
        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-sm text-muted-foreground">Total</span>
          <Numeric
            value={total.total}
            kind="money"
            currency={totalCurrency}
            direction="none"
            className="text-lg font-semibold"
          />
        </div>
      ) : null}
      {displayCurrency === null && (
        <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm">
          <Link
            to="/settings"
            className="cursor-pointer text-primary underline-offset-4 hover:underline"
          >
            Set display currency
          </Link>{' '}
          to see your total.
        </div>
      )}
    </div>
  );
}

export default AccountBalancesWidget;
