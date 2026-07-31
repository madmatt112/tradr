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
      </CardContent>
      <ReconcileBalanceDialog
        account={account}
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
      />
    </Card>
  );
}
