import type { Account } from '@tradr/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';

interface Props {
  account: Account;
}

export function AccountBalance({ account }: Props) {
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
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {account.balance !== undefined ? formatMoney(account.balance, account.currency) : '—'}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">{account.currency}</div>
      </CardContent>
    </Card>
  );
}
