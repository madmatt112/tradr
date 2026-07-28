import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import type { PositionListItem } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Alert } from '@/components/ui/alert';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useDrawerStore } from '@/stores/drawer.store';

function directionLabel(p: PositionListItem): string {
  return p.side === 'long' ? 'Long' : 'Short';
}

function costBasis(p: PositionListItem): number {
  return (
    Math.abs(p.totalEntryQuantity - p.totalExitQuantity) *
    Number(p.avgEntryPrice ?? 0) *
    (p.assetType === 'option' ? 100 : 1)
  );
}

/**
 * OpenPositionsTab — Side-drawer tab listing all open positions sorted by
 * `openedAt desc` (null-tolerant: null sorts LAST). Per REQ-4.2 / v4-4 the
 * column shows Cost Basis only — unrealized P&L is deferred until a quote
 * feed lands (see ibkr-integration spec).
 *
 * Row click closes the drawer on mobile (REQ-4.6) so the linked detail page
 * is visible without the drawer overlay.
 */
export function OpenPositionsTab() {
  const { data, isLoading, error } = usePositions({ status: 'open' });
  const close = useDrawerStore((s) => s.close);
  const isMobile = useMediaQuery('(max-width: 767px)');

  const rows = useMemo(
    () => (data ?? []).slice().sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? '')),
    [data],
  );

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            data-testid="open-positions-skeleton"
            className="animate-pulse h-14 w-full rounded bg-muted"
          />
        ))}
      </div>
    );
  }

  if (error) {
    const message = error instanceof Error ? error.message : 'Failed to load open positions';
    return (
      <div className="p-4">
        <Alert variant="destructive">{message}</Alert>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm p-4">
        No open positions. Open one from the Positions page.
      </p>
    );
  }

  return (
    <div>
      <p className="text-muted-foreground text-xs px-4 py-2">
        Cost Basis only — live P&amp;L coming in a future release.
      </p>
      {rows.map((p) => (
        <Link
          key={p.id}
          to="/positions/$positionId"
          params={{ positionId: p.id }}
          onClick={() => {
            if (isMobile) close();
          }}
          className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-accent cursor-pointer"
        >
          <div className="flex flex-col">
            <span className="text-sm font-medium">{p.symbol}</span>
            <span className="text-xs text-muted-foreground">
              {directionLabel(p)} · {Math.abs(p.totalEntryQuantity - p.totalExitQuantity)}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <Numeric
              value={Number(p.avgEntryPrice ?? 0)}
              kind="money"
              currency={p.accountCurrency}
              direction="none"
              className="text-xs text-muted-foreground"
            />
            <Numeric
              value={costBasis(p)}
              kind="money"
              currency={p.accountCurrency}
              direction="none"
              className="text-sm"
            />
          </div>
        </Link>
      ))}
    </div>
  );
}

export default OpenPositionsTab;
