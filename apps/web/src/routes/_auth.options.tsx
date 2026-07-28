import { createFileRoute } from '@tanstack/react-router';

import { OptionsPage } from '@/features/options/components/OptionsPage';

export const Route = createFileRoute('/_auth/options')({
  component: OptionsPage,
});
