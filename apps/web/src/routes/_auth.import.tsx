import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { ChunkLoadFallback } from '@/components/ChunkLoadFallback';

const ImportPage = lazy(() =>
  import('@/features/csv-import/components/ImportPage').then((m) => ({ default: m.ImportPage })),
);

function ImportRoute() {
  return (
    <ChunkErrorBoundary fallback={({ reload }) => <ChunkLoadFallback onReload={reload} />}>
      <Suspense fallback={<div className="p-6 text-muted-foreground">Loading import…</div>}>
        <ImportPage />
      </Suspense>
    </ChunkErrorBoundary>
  );
}

export const Route = createFileRoute('/_auth/import')({
  component: ImportRoute,
});
