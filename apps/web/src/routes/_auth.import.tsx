import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const ImportPage = lazy(() =>
  import('@/features/csv-import/components/ImportPage').then((m) => ({ default: m.ImportPage })),
);

function ImportRoute() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading import…</div>}>
      <ImportPage />
    </Suspense>
  );
}

export const Route = createFileRoute('/_auth/import')({
  component: ImportRoute,
});
