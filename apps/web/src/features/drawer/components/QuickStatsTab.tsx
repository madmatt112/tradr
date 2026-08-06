import { useMemo } from 'react';

import type { PositionListItem } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { usePerformance } from '@/features/performance/hooks/usePerformance';
import {
  DEFAULT_CURRENCY_HISTORY_RANGE,
  derivePresetRange,
} from '@/features/performance/utils/derivePresetRange';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useNow } from '@/hooks/useNow';
import { useUserTimezone } from '@/hooks/useUserTimezone';

function openNotional(positions: PositionListItem[], displayCurrency: string): number {
  return positions
    .filter((p) => p.status === 'open' && p.accountCurrency === displayCurrency)
    .reduce(
      (acc, p) =>
        acc +
        Math.abs(p.totalEntryQuantity - p.totalExitQuantity) *
          Number(p.avgEntryPrice ?? 0) *
          (p.assetType === 'option' ? 100 : 1),
      0,
    );
}

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SkeletonValue({ slug }: { slug: string }) {
  return (
    <div
      data-testid={`quick-stats-${slug}-skeleton`}
      className="animate-pulse h-6 w-20 rounded bg-muted"
    />
  );
}

/**
 * QuickStatsTab — Side-drawer tab summarising 4 headline metrics for the
 * user's display currency: Win Rate, Avg Win, Avg Loss, Open Notional.
 *
 * Uses a single `usePerformance` call (all-time window) plus `usePositions`
 * for the Open Notional sum. All four cards share a unified loading
 * predicate; errors render a single Alert spanning the grid.
 */
export function QuickStatsTab() {
  const { data: displayCurrencyData, isLoading: isDisplayCurrencyLoading } =
    useDisplayCurrencyQuery();
  const displayCurrency = displayCurrencyData?.currency ?? null;

  const now = useNow(60_000);
  // The user's STORED reporting timezone (user-onboarding R2.4), `undefined`
  // until that query settles. `derivePresetRange` resolves calendar boundaries
  // through `Intl`, so it cannot run before the zone is known.
  const timezone = useUserTimezone();
  const range = useMemo(
    () =>
      timezone
        ? derivePresetRange('all-time', DEFAULT_CURRENCY_HISTORY_RANGE, now, timezone, 1)
        : null,
    [now, timezone],
  );

  const performanceQuery = usePerformance(
    timezone && range
      ? {
          granularity: range.granularity,
          start: range.start,
          end: range.end,
          tz: timezone,
          ...(displayCurrency ? { currency: displayCurrency } : {}),
        }
      : null,
  );
  const positionsQuery = usePositions({ status: 'open' });

  const currencyEntry = displayCurrency
    ? performanceQuery.data?.currencies.find((c) => c.code === displayCurrency)
    : undefined;

  // `timezone === undefined` joins the predicate for the same reason
  // `displayCurrency === null` already does: the performance query is disabled
  // until it lands, and a disabled query reports `isLoading: false`.
  const isLoading =
    timezone === undefined ||
    performanceQuery.isLoading ||
    positionsQuery.isLoading ||
    isDisplayCurrencyLoading ||
    displayCurrency === null;

  if (performanceQuery.error || positionsQuery.error) {
    const err = performanceQuery.error ?? positionsQuery.error;
    const message = err instanceof Error ? err.message : 'Failed to load quick stats';
    return (
      <div className="p-4">
        <Alert variant="destructive">{message}</Alert>
      </div>
    );
  }

  const winRateValue = currencyEntry?.stats.winRate;
  const avgWinRaw = currencyEntry?.stats.avgWin;
  const avgLossRaw = currencyEntry?.stats.avgLoss;
  const avgWinNum = avgWinRaw != null ? Number(avgWinRaw) : null;
  const avgLossNum = avgLossRaw != null ? Number(avgLossRaw) : null;

  const positions = positionsQuery.data ?? [];
  const openNotionalValue = displayCurrency !== null ? openNotional(positions, displayCurrency) : 0;
  const excludedCount =
    displayCurrency !== null
      ? positions.filter((p) => p.status === 'open' && p.accountCurrency !== displayCurrency).length
      : 0;

  const showEmptyCopy =
    !isLoading &&
    performanceQuery.data !== undefined &&
    currencyEntry === undefined &&
    displayCurrency !== null;

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <CardShell title="Win Rate">
          {isLoading ? (
            <SkeletonValue slug="win-rate" />
          ) : (
            <div data-testid="quick-stats-win-rate-value">
              <Numeric
                value={winRateValue ?? null}
                kind="percent"
                direction="none"
                className="text-2xl font-semibold"
              />
            </div>
          )}
        </CardShell>

        <CardShell title="Avg Win">
          {isLoading ? (
            <SkeletonValue slug="avg-win" />
          ) : (
            <div data-testid="quick-stats-avg-win-value">
              <Numeric
                value={displayCurrency ? avgWinNum : null}
                kind="money"
                currency={displayCurrency ?? undefined}
                direction="auto"
                className="text-2xl font-semibold"
              />
            </div>
          )}
        </CardShell>

        <CardShell title="Avg Loss">
          {isLoading ? (
            <SkeletonValue slug="avg-loss" />
          ) : (
            <div data-testid="quick-stats-avg-loss-value">
              <Numeric
                value={displayCurrency ? avgLossNum : null}
                kind="money"
                currency={displayCurrency ?? undefined}
                direction="auto"
                className="text-2xl font-semibold"
              />
            </div>
          )}
        </CardShell>

        <CardShell title="Open Notional">
          {isLoading ? (
            <SkeletonValue slug="open-notional" />
          ) : (
            <>
              <div data-testid="quick-stats-open-notional-value">
                <Numeric
                  value={displayCurrency ? openNotionalValue : null}
                  kind="money"
                  currency={displayCurrency ?? undefined}
                  direction="none"
                  className="text-2xl font-semibold"
                />
              </div>
              {excludedCount > 0 ? (
                <p className="text-xs text-muted-foreground mt-1">
                  {excludedCount} position(s) in other currencies excluded.
                </p>
              ) : null}
            </>
          )}
        </CardShell>
      </div>

      {showEmptyCopy ? (
        <p className="text-sm text-muted-foreground">
          No closed positions yet in {displayCurrency}.
        </p>
      ) : null}
    </div>
  );
}

export default QuickStatsTab;
