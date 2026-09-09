import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { ChunkLoadFallback } from '@/components/ChunkLoadFallback';

import { redirectWhenAdvisorDisabled } from './_auth.advisor.index';

const AdvisorPage = lazy(() =>
  import('@/features/advisor/pages/AdvisorPage').then((m) => ({ default: m.AdvisorPage })),
);

function AdvisorConversationRoute() {
  const { id } = Route.useParams();
  return (
    <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
      <Suspense fallback={<div className="p-6 text-muted-foreground">Loading advisor…</div>}>
        <AdvisorPage conversationId={id} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}

export const Route = createFileRoute('/_auth/advisor/$id')({
  beforeLoad: redirectWhenAdvisorDisabled,
  component: AdvisorConversationRoute,
});
