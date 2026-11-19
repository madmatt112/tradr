import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import type { PositionListEntry, PositionListItem } from '@tradr/shared';
import { computeUnrealised } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Alert } from '@/components/ui/alert';
import { CostBasisOnly } from '@/features/positions/components/CostBasisOnly';
import { PastExpiryChip } from '@/features/positions/components/PastExpiryChip';
import { QuoteStaleness } from '@/features/positions/components/QuoteStaleness';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { firstOpenLegId, isGroupEntry } from '@/features/positions/utils/listEntries';
import { markReason, quoteSymbolsFor } from '@/features/positions/utils/markToMarket';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { oldestFetchedAt, useStockQuotes } from '@/hooks/useStockQuotes';
import { useDrawerStore } from '@/stores/drawer.store';

function directionLabel(p: PositionListItem): string {
  return p.side === 'long' ? 'Long' : 'Short';
}

function reasonFor(entry: PositionListEntry): string | null {
  if (isGroupEntry(entry)) {
    return markReason({
      isGroup: true,
      groupId: null,
      assetType: 'stock',
      accountCurrency: entry.accountCurrency,
    });
  }
  return markReason({
    isGroup: false,
    groupId: null,
    assetType: entry.assetType,
    accountCurrency: entry.accountCurrency,
  });
}

/**
 * OpenPositionsTab — Side-drawer tab listing all open positions sorted by
 * `openedAt desc` (null-tolerant: null sorts LAST).
 *
 * Cost basis comes from the API's `openCostBasis` (ledger-balances Req 10) —
 * the same per-position figure the account's `positionValue` sums, so the
 * drawer and the account balance card can never disagree. Every row keeps its
 * average entry price and absolute cost basis. When the stock quote provider
 * is configured (design C7/C11), an eligible row additionally shows last
 * price, unrealised P&L and unrealised percent; a group, option or non-USD
 * row instead shows a "Cost basis only" reason, rendered as plain visible
 * text rather than a focusable tooltip trigger because the whole row is
 * itself a link (design D13).
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

  const { configured, quote } = useStockQuotes(quoteSymbolsFor(rows));

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

  const priceCells = configured
    ? rows
        .filter(
          (entry): entry is PositionListItem => !isGroupEntry(entry) && reasonFor(entry) === null,
        )
        .map((entry) => quote(entry.symbol))
    : [];

  return (
    <div>
      {configured ? (
        <div className="px-4 py-2 flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">Cost basis includes entry fees.</p>
          <QuoteStaleness oldestFetchedAt={oldestFetchedAt(priceCells)} />
        </div>
      ) : (
        <p className="text-muted-foreground text-xs px-4 py-2">Cost basis only, fees included.</p>
      )}
      {rows.map((entry) => {
        if (isGroupEntry(entry)) {
          const reason = reasonFor(entry);
          return (
            <Link
              key={entry.id}
              to="/positions/$positionId"
              params={{ positionId: firstOpenLegId(entry) }}
              onClick={() => {
                if (isMobile) close();
              }}
              className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-accent cursor-pointer"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {entry.underlying} {entry.label}
                </span>
                {!!entry.pastExpiryLegCount && <PastExpiryChip count={entry.pastExpiryLegCount} />}
              </div>
              <div className="flex flex-col items-end">
                <Numeric
                  value={Math.abs(entry.openCostBasis)}
                  kind="money"
                  currency={entry.accountCurrency}
                  direction="none"
                  className="text-sm"
                />
                {configured && reason && <CostBasisOnly reason={reason} variant="inline" />}
              </div>
            </Link>
          );
        }

        const p = entry;
        const reason = reasonFor(p);
        const cell = configured && reason === null ? quote(p.symbol) : null;
        const unrealised =
          cell && cell.state === 'price'
            ? computeUnrealised({
                side: p.side,
                openQty: p.totalEntryQuantity - p.totalExitQuantity,
                openCostBasis: p.openCostBasis,
                lastPrice: cell.lastPrice,
                currency: p.accountCurrency,
              })
            : null;
        const numericState = cell?.state === 'loading' ? 'loading' : 'value';

        return (
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
              {p.pastExpiryUnsettled && <PastExpiryChip />}
            </div>
            <div className="flex flex-col items-end">
              <Numeric
                value={Number(p.avgEntryPrice ?? 0)}
                kind="money"
                currency={p.accountCurrency}
                direction="none"
                className="text-xs text-muted-foreground"
              />
              {/*
                MAGNITUDE, deliberately. `openCostBasis` is signed — negative for
                shorts — but this column is a per-row size and the row already
                labels the direction ("Short · 10") two lines to the left. The sign
                is load-bearing in the ACCOUNT aggregate, where cash + positions
                must equal the balance; here it would only duplicate the label.

                Not left to `direction="none"` to hide: that renders a negative
                with no sign at all, which would make this row silently
                indistinguishable from a long's. Taking the absolute value says so
                out loud.
              */}
              <Numeric
                value={Math.abs(p.openCostBasis)}
                kind="money"
                currency={p.accountCurrency}
                direction="none"
                className="text-sm"
              />
              {configured && reason !== null && <CostBasisOnly reason={reason} variant="inline" />}
              {configured && reason === null && (
                <>
                  <Numeric
                    value={cell?.state === 'price' ? cell.lastPrice : null}
                    kind="money"
                    currency={p.accountCurrency}
                    direction="none"
                    state={numericState}
                    className="text-xs"
                  />
                  <Numeric
                    value={unrealised ? unrealised.unrealisedPnl : null}
                    kind="money"
                    direction="auto"
                    state={numericState}
                    className="text-xs"
                  />
                  <Numeric
                    value={unrealised ? unrealised.unrealisedPercent : null}
                    kind="percent"
                    precision={2}
                    direction="auto"
                    state={numericState}
                    className="text-xs"
                  />
                </>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export default OpenPositionsTab;
