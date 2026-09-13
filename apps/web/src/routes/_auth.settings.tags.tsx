import { createFileRoute } from '@tanstack/react-router';

import { TagsSettings } from '@/features/tags/components/TagsSettings';

function SettingsTags() {
  return (
    <div className="space-y-6" data-slot="settings-tags">
      <div>
        <h2 className="text-lg font-medium">Tags</h2>
        <p className="text-sm text-muted-foreground">
          Your setups, emotions, mistakes and other labels. Tags apply to positions from a
          position's page.
        </p>
      </div>

      <TagsSettings />
    </div>
  );
}

export const Route = createFileRoute('/_auth/settings/tags')({
  component: SettingsTags,
});
