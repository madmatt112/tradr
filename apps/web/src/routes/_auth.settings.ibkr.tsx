import { createFileRoute } from '@tanstack/react-router';

import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { IbkrConnectionCard } from '@/features/ibkr/components/IbkrConnectionCard';

function SettingsIbkr() {
  const { data: accounts, isLoading, isError } = useAccounts();

  return (
    <div className="space-y-6" data-slot="settings-ibkr">
      <div>
        <h2 className="text-lg font-medium">IBKR</h2>
        <p className="text-sm text-muted-foreground">
          Connect an IBKR Flex Web Service token per account to import trades directly from
          Interactive Brokers.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading accounts…</p>}
      {isError && <p className="text-sm text-destructive">Couldn't load accounts. Try again.</p>}

      <div className="space-y-4">
        {accounts?.map((account) => (
          <IbkrConnectionCard key={account.id} accountId={account.id} accountName={account.name} />
        ))}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/ibkr')({
  component: SettingsIbkr,
});
