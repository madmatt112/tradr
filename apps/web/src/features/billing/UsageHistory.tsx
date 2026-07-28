// UsageHistory — paginated wallet/usage history list (design §Component 8; REQ-7.3).
//
// Renders one row per wallet transaction: credit/reversal purchase entries and
// debit entries with their per-turn usage detail (provider/model/tokens) when
// joined. Credits are shown as a credit COUNT (never labeled displayCurrency).

import type { WalletHistoryItem } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeTime } from '@/lib/format';

import { useWalletHistory } from './useWalletHistory';

const KIND_LABEL: Record<WalletHistoryItem['kind'], string> = {
  credit: 'Purchase',
  debit: 'Usage',
  reversal: 'Reversal',
};

function HistoryRow({ item }: { item: WalletHistoryItem }) {
  return (
    <li
      data-testid="usage-history-row"
      className="flex items-start justify-between gap-4 border-b py-3 last:border-b-0"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{KIND_LABEL[item.kind]}</p>
        {item.usage ? (
          <p className="text-xs text-muted-foreground">
            {item.usage.providerId} · {item.usage.model} · {item.usage.inputTokens} in /{' '}
            {item.usage.outputTokens} out tokens
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{formatRelativeTime(item.createdAt)}</p>
      </div>
      {/* The credit/debit figure is MONEY-DIRECTION, not a status: a credit reads
          as a gain (+ / text-gain), a debit as a loss. direction="auto"
          replaces the former hue-only green/foreground encoding. */}
      <span className="shrink-0 text-sm">
        <Numeric value={item.amount} kind="integer" direction="auto" /> credits
      </span>
    </li>
  );
}

export function UsageHistory() {
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useWalletHistory();

  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card data-testid="usage-history">
      <CardHeader>
        <CardTitle>Usage history</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load history.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <>
            <ul className="flex flex-col">
              {items.map((item) => (
                <HistoryRow key={item.id} item={item} />
              ))}
            </ul>
            {hasNextPage ? (
              <div className="pt-4">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
