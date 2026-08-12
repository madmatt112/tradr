import { createFileRoute } from '@tanstack/react-router';

import { WalkthroughLauncher } from '@/features/onboarding/components/WalkthroughLauncher';

function SettingsHelp() {
  return (
    <div className="space-y-6" data-slot="settings-help">
      <div>
        <h2 className="text-lg font-medium">Help</h2>
        <p className="text-sm text-muted-foreground">
          Start the guided walkthrough again, whenever you want it.
        </p>
      </div>

      <WalkthroughLauncher />
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/help')({
  component: SettingsHelp,
});
