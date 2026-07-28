import { Link, createFileRoute } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountBalance } from '@/features/accounting/components/AccountBalance';
import { LedgerView } from '@/features/accounting/components/LedgerView';
import { useAccount } from '@/features/accounting/hooks/useAccount';

// NOTE: this page composes `AccountBalance` (native account currency) and
// `LedgerView` (also native account currency); nothing on this page is
// denominated in display currency. Per design §Open Design Question 7, the
// display-currency-change handler in
// `apps/web/src/features/accounting/hooks/useDisplayCurrency.ts` does NOT
// invalidate `['accounts', 'detail', accountId]`. If a future change adds a
// display-currency-denominated element here (e.g., a "≈ <displayCurrency>"
// aside on `AccountBalance`), that handler MUST be updated in lockstep to
// also invalidate `['accounts', 'detail', accountId]`.

function AccountDetailPage({ accountId }: { accountId: string }) {
  const { data: account, isLoading } = useAccount(accountId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        Account not found.
        <div className="mt-4">
          <Button asChild variant="outline" className="cursor-pointer">
            <Link to="/accounts">Back to accounts</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{account.name}</h1>
          {account.brokerageName && (
            <div className="text-sm text-muted-foreground">{account.brokerageName}</div>
          )}
        </div>
        <Button asChild variant="outline" className="cursor-pointer">
          <Link to="/accounts">Back</Link>
        </Button>
      </div>

      <AccountBalance account={account} />

      <div>
        <h2 className="mb-3 text-lg font-semibold">Ledger</h2>
        <LedgerView accountId={account.id} currency={account.currency} />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/_auth/accounts/$accountId')({
  component: () => {
    const { accountId } = Route.useParams();
    return <AccountDetailPage accountId={accountId} />;
  },
});
