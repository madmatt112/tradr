import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDashboardTotalQuery } from '@/features/accounting/hooks/useDashboardTotal';
import { useMissingRatePrompt } from '@/features/accounting/hooks/useMissingRatePrompt';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { formatMoney } from '@/lib/format';

/**
 * Cross-currency aggregate total widget for the dashboard.
 *
 * Hidden entirely when the user has accounts in only one currency (Req 4.9):
 * single-currency users see no cross-currency UI at all. When a rate is missing
 * for a needed pair, renders "—" with a tooltip listing the missing pairs and
 * an inline deeplink to the settings page to enter the missing rate.
 */
export function CrossCurrencyTotal() {
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const { data: total, isLoading: totalLoading } = useDashboardTotalQuery();
  const { shouldPrompt, missingPairs, deeplinkTo } = useMissingRatePrompt();

  // Don't flash the widget while accounts are loading. Once accounts have
  // resolved, the multi-currency gate below determines visibility.
  if (accountsLoading || !accounts) return null;

  const distinctCurrencies = new Set(accounts.map((a) => a.currency));
  if (distinctCurrencies.size <= 1) return null;

  if (totalLoading || !total) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Total (all accounts)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-muted-foreground">…</div>
        </CardContent>
      </Card>
    );
  }

  const { displayCurrency } = total;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Total (all accounts)</CardTitle>
      </CardHeader>
      <CardContent>
        {shouldPrompt || total.total === null || displayCurrency === null ? (
          <div className="flex items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="text-2xl font-bold cursor-help"
                  data-testid="cross-currency-total-missing"
                >
                  —
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <div className="text-xs">
                  <p className="mb-1 font-medium">Missing exchange rate(s):</p>
                  <ul className="space-y-0.5">
                    {missingPairs.map((p) => (
                      <li key={`${p.baseCurrency}-${p.quoteCurrency}`}>
                        {p.baseCurrency} → {p.quoteCurrency}
                      </li>
                    ))}
                  </ul>
                </div>
              </TooltipContent>
            </Tooltip>
            {deeplinkTo && (
              <a
                href={deeplinkTo}
                className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline"
              >
                Enter rate
              </a>
            )}
          </div>
        ) : (
          <div className="text-2xl font-bold" data-testid="cross-currency-total">
            {formatMoney(total.total, displayCurrency)}
          </div>
        )}
        {displayCurrency && (
          <div className="mt-1 text-sm text-muted-foreground">{displayCurrency}</div>
        )}
      </CardContent>
    </Card>
  );
}
