import { createFileRoute } from '@tanstack/react-router';

import { ExportCard } from '@/features/account-data/components/ExportCard';
import { ImportFlow } from '@/features/account-data/components/ImportFlow';

function SettingsData() {
  return (
    <div className="space-y-6" data-slot="settings-data">
      <div>
        <h2 className="text-lg font-medium">Data</h2>
        <p className="text-sm text-muted-foreground">
          Export everything in your account as one archive, or import an archive into an empty
          account.
        </p>
      </div>

      <ExportCard />
      <ImportFlow />
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/data')({
  component: SettingsData,
});
