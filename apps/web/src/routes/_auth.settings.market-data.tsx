import { createFileRoute } from '@tanstack/react-router';

import { MarketDataKeyCard } from '@/features/advisor/components/MarketDataKeyCard';

function SettingsMarketData() {
  return (
    <div className="space-y-6" data-slot="settings-market-data">
      <div>
        <h2 className="text-lg font-medium">Market data</h2>
        <p className="text-sm text-muted-foreground">
          Connect an Unusual Whales key to power the options chain and the calculator&apos;s
          option path.
        </p>
      </div>

      <MarketDataKeyCard />
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/market-data')({
  component: SettingsMarketData,
});
