// ChangelogPage — release notes surface (REQ-4.2, 4.5) + the mark-viewed
// trigger (REQ-5(a)(3)).
//
// This module is lazy-loaded at the route boundary (_auth.changelog.tsx) so
// react-markdown/remark-gfm/rehype-sanitize never land in the initial app
// bundle (REQ-4.7).

import { useEffect, useRef } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';

import { ReleaseCard } from '../components/ReleaseCard';
import { useChangelogReleases, useMarkChangelogViewed } from '../hooks/useChangelog';

export function ChangelogPage() {
  const releases = useChangelogReleases();
  const { mutate: markViewed } = useMarkChangelogViewed();

  // Mark-viewed fires once per mount, only when the releases query has data
  // (success, including stale — the user saw what was served). Gating on data
  // means an unavailable visit never advances the floor past releases the user
  // never saw. The ref guard absorbs StrictMode's dev double-effect; the write
  // is idempotent anyway. Mutation errors are swallowed — invisible
  // bookkeeping, no toast (design Component 9, Error Scenario 7).
  const markedRef = useRef(false);
  const hasData = releases.data !== undefined;
  useEffect(() => {
    if (!hasData || markedRef.current) return;
    markedRef.current = true;
    markViewed();
  }, [hasData, markViewed]);

  let body;
  if (releases.isPending) {
    body = (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (releases.isError) {
    // The api client throws the parsed error envelope with `status` attached,
    // so the coded 503 lives at err.error.code (the api.ts idiom). Both the
    // CHANGELOG_UNAVAILABLE branch and any other error render the same
    // non-alarming unavailable state (REQ-2.5, REQ-4.5).
    const err = releases.error as { error?: { code?: string } } | null;
    const unavailable = err?.error?.code === 'CHANGELOG_UNAVAILABLE';
    body = (
      <EmptyState
        title="Release notes are temporarily unavailable"
        description={
          unavailable
            ? 'We could not reach the release feed. Please check back later.'
            : 'Something went wrong loading release notes. Please check back later.'
        }
      />
    );
  } else if (releases.data.releases.length === 0) {
    body = <EmptyState title="No releases yet" />;
  } else {
    body = (
      <>
        {releases.data.stale && (
          <p className="text-sm text-muted-foreground">Showing previously fetched release notes</p>
        )}
        <div className="space-y-4">
          {/* Server order — already sorted desc by publishedAt; do not re-sort. */}
          {releases.data.releases.map((release) => (
            <ReleaseCard key={release.id} release={release} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader page="Changelog" />
      {body}
    </div>
  );
}
