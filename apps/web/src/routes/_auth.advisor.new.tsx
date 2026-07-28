import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const AdvisorPage = lazy(() =>
  import('@/features/advisor/pages/AdvisorPage').then((m) => ({ default: m.AdvisorPage })),
);

function AdvisorNewRoute() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading advisor…</div>}>
      <AdvisorPage conversationId={null} isNew />
    </Suspense>
  );
}

export const Route = createFileRoute('/_auth/advisor/new')({
  component: AdvisorNewRoute,
});
