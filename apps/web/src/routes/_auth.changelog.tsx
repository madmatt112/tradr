import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

// Lazy-load the changelog surface so its bundle (react-markdown, remark-gfm,
// rehype-sanitize) never lands in the initial app bundle (REQ-4.7) — the
// router does NOT auto-split routes; this is the _auth.advisor.tsx pattern.
const ChangelogPage = lazy(() =>
  import('@/features/changelog/pages/ChangelogPage').then((m) => ({ default: m.ChangelogPage })),
);

function ChangelogRoute() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading changelog…</div>}>
      <ChangelogPage />
    </Suspense>
  );
}

export const Route = createFileRoute('/_auth/changelog')({
  component: ChangelogRoute,
});
