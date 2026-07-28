import { createFileRoute } from '@tanstack/react-router';

import { PositionList } from '@/features/positions/components/PositionList';

export const Route = createFileRoute('/_auth/positions/')({
  component: PositionList,
});
