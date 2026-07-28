import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { DisplayCurrencySelect } from '@/features/accounting/components/DisplayCurrencySelect';
import { ExchangeRatesPage } from '@/features/accounting/components/ExchangeRatesPage';

// FX/display-currency settings live under the Profile tab (design §Component 8).
const ProfileSearchSchema = z.object({
  base: z.string().length(3).optional(),
  quote: z.string().length(3).optional(),
});

function SettingsProfile() {
  const { base, quote } = Route.useSearch();
  return (
    <div className="space-y-8">
      <DisplayCurrencySelect />
      <ExchangeRatesPage initialBase={base} initialQuote={quote} />
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/profile')({
  validateSearch: ProfileSearchSchema,
  component: SettingsProfile,
});
