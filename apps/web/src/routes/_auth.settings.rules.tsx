import { createFileRoute } from '@tanstack/react-router';

import { RulesSettings } from '@/features/trading-rules/components/RulesSettings';

function SettingsRules() {
  return (
    <div className="space-y-6" data-slot="settings-rules">
      <div>
        <h2 className="text-lg font-medium">Rules</h2>
        <p className="text-sm text-muted-foreground">
          The limits and habits you mean to trade by. Tradr scores every open and closed position
          against your enabled rules — it never blocks or changes a trade.
        </p>
      </div>

      <RulesSettings />
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/rules')({
  component: SettingsRules,
});
