import { createFileRoute, redirect } from '@tanstack/react-router';

import { MarketDataKeyCard } from '@/features/advisor/components/MarketDataKeyCard';
import { PersonaList } from '@/features/advisor/components/PersonaList';
import { ProviderKeyCard } from '@/features/advisor/components/ProviderKeyCard';
import { TradeDataConsentToggle } from '@/features/advisor/components/TradeDataConsentToggle';
import { isAdvisorEnabledForRoute } from '@/hooks/useRegistrationEnabled';

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
  // On an instance that has withdrawn the advisor the tab is not rendered, so
  // only a typed or stale URL lands here. Send it to `/settings`, whose own
  // redirect picks the first tab this instance shows.
  beforeLoad: async () => {
    if (!(await isAdvisorEnabledForRoute())) {
      throw redirect({ to: '/settings' });
    }
  },
  component: SettingsAdvisor,
});
