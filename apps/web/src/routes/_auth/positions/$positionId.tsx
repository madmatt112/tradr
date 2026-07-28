import { createFileRoute } from '@tanstack/react-router';

import { PositionDetailView } from '@/features/positions/components/PositionDetail';

export const Route = createFileRoute('/_auth/positions/$positionId')({
  component: () => {
    const { positionId } = Route.useParams();
    return <PositionDetailView positionId={positionId} />;
  },
});
