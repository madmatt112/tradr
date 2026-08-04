import { useState } from 'react';

import type { Account } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';

import { ReconcileBalanceDialog } from './ReconcileBalanceDialog';

interface Props {
  account: Account;
}

export function AccountBalance({ account }: Props) {
  const [reconcileOpen, setReconcileOpen] = useState(false);

  // NOTE: nothing on this card is denominated in display currency — `balance`
  // is in the account's native currency. If a display-currency-denominated
  // element is ever added to this page (e.g., a "≈ <displayCurrency>" aside),
  // the display-currency-change handler in `useDisplayCurrency.ts` MUST also
  // invalidate `['accounts', 'detail', accountId]` (per design §Open Design
  // Question 7).
  return (
    <Card>
      <CardHeader>
        <CardTitle>Balance</CardTitle>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => setReconcileOpen(true)}
          >
            Reconcile
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid="account-balance">
          {account.balance !== undefined ? formatMoney(account.balance, account.currency) : '—'}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">{account.currency}</div>
        {/*
          The two halves of the balance (ledger-balances Req 10). Rendered only
          when both are present — they arrive together from accounts LIST/GET,
          and the schema keeps them optional for fixtures that predate them.

          `positionValue` is COST BASIS, never mark-to-market: there is no quote
          source, so it moves only when fills change. The caption says so, or
          the number reads as a stale market value. It is negative for shorts,
          where the unexited size is proceeds received against shares still owed
          — which is why a shorting account can show cash above its balance.
        */}
        {account.cash !== undefined && account.positionValue !== undefined && (
          <div className="mt-4 space-y-1 border-t pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Cash</span>
              <span className="text-sm font-medium" data-testid="account-cash">
                {formatMoney(account.cash, account.currency)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Positions</span>
              <span className="text-sm font-medium" data-testid="account-position-value">
                {formatMoney(account.positionValue, account.currency)}
              </span>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              Open positions at cost basis — not market value.
            </p>
          </div>
        )}
      </CardContent>
      <ReconcileBalanceDialog
        account={account}
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
      />
    </Card>
  );
}
