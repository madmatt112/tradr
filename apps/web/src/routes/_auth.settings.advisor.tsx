import { createFileRoute } from '@tanstack/react-router';

import { MarketDataKeyCard } from '@/features/advisor/components/MarketDataKeyCard';
import { PersonaList } from '@/features/advisor/components/PersonaList';
import { ProviderKeyCard } from '@/features/advisor/components/ProviderKeyCard';
import { TradeDataConsentToggle } from '@/features/advisor/components/TradeDataConsentToggle';

function SettingsAdvisor() {
  return (
    <div className="space-y-8" data-slot="settings-advisor">
      <div>
        <h2 className="text-lg font-medium">Advisor</h2>
        <p className="text-sm text-muted-foreground">
          Manage provider keys and personas for the AI advisor.
        </p>
      </div>

      <section className="space-y-4">
        <h3 className="text-base font-medium">Provider keys</h3>
        <ProviderKeyCard providerId="claude" />
        <ProviderKeyCard providerId="openai" />
        <ProviderKeyCard providerId="gemini" />
        <ProviderKeyCard providerId="openrouter" />
      </section>

      <section className="space-y-4">
        <h3 className="text-base font-medium">Market data &amp; trade-data access</h3>
        <MarketDataKeyCard />
        <TradeDataConsentToggle />
      </section>

      <section>
        <PersonaList />
      </section>
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/advisor')({
  component: SettingsAdvisor,
});
