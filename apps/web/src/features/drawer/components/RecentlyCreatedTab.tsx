import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import type { PositionListItem } from '@tradr/shared';

import { Alert } from '@/components/ui/alert';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useNow } from '@/hooks/useNow';
import { formatRelativeTime } from '@/lib/format';
import { useDrawerStore } from '@/stores/drawer.store';

function actionLabel(status: PositionListItem['status'], symbol: string): string {
  switch (status) {
    case 'draft':
      return `Drafted ${symbol}`;
    case 'open':
      return `Active: ${symbol}`;
    case 'closed':
      return `Closed ${symbol}`;
  }
}

/**
 * RecentlyCreatedTab — Side-drawer tab listing the 20 most-recently created
 * positions, sorted by `createdAt desc`. Per REQ-7 this is a per-position
 * activity feed; per-fill history is deferred.
 *
 * Row click closes the drawer on mobile (REQ-7) so the linked detail page is
 * visible without the drawer overlay.
 */
export function RecentlyCreatedTab() {
  const { data, isLoading, error } = usePositions({});
  const close = useDrawerStore((s) => s.close);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const now = useNow(60_000);

  const rows = useMemo(
    () =>
      (data ?? [])
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20),
    [data],
  );

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            data-testid="recently-created-skeleton"
            className="animate-pulse h-10 w-full rounded bg-muted"
          />
        ))}
      </div>
    );
  }

  if (error) {
    const message = error instanceof Error ? error.message : 'Failed to load recent positions';
    return (
      <div className="p-4">
        <Alert variant="destructive">{message}</Alert>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          No positions yet. Create your first position.
        </p>
        <Link
          to="/positions"
          onClick={() => {
            if (isMobile) close();
          }}
          className="inline-flex items-center justify-center rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer"
        >
          Go to Positions
        </Link>
      </div>
    );
  }

  return (
    <div>
      <p className="text-muted-foreground text-xs px-4 py-2">
        Sorted by creation date. Per-fill history coming in a future release.
      </p>
      {rows.map((p) => (
        <Link
          key={p.id}
          to="/positions/$positionId"
          params={{ positionId: p.id }}
          onClick={() => {
            if (isMobile) close();
          }}
          className="block px-4 py-2 text-sm hover:bg-accent cursor-pointer"
        >
          {actionLabel(p.status, p.symbol)} ·{' '}
          <span className="text-muted-foreground">{formatRelativeTime(p.createdAt, now)}</span>
        </Link>
      ))}
    </div>
  );
}

export default RecentlyCreatedTab;
