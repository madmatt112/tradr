import type { ReactNode } from 'react';

import type { PerformanceStats } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { formatProfitFactor } from '../utils/formatPerformance';

export interface StatsPanelProps {
  stats: PerformanceStats;
  /** ISO 4217 code used to format money fields. */
  currency: string;
}

interface StatRow {
  label: string;
  render: () => ReactNode;
}

/**
 * StatsPanel — renders all REQ-4 trading statistics for the active currency
 * and timeframe. Null handling per REQ-4.11:
 *
 *   - Money / count nulls    → em-dash (U+2014)
 *   - winRate / breakevenRate `null` → em-dash
 *   - profitFactor `null` AND `hasWins && !hasLosses` → ∞
 *   - profitFactor `null` otherwise → em-dash
 *
 * Statistic rows render through `formatPerformance.ts` helpers (the only
 * place these formatting rules live) so the StatsPanel test exercising the
 * ∞-vs-em-dash branches is in `formatPerformance.test.ts`; here we just
 * confirm the wiring is correct.
 */
export function StatsPanel({ stats, currency }: StatsPanelProps) {
  const money = (value: string | null, direction: 'auto' | 'none') => (
    <Numeric value={value} kind="money" currency={currency} direction={direction} />
  );

  const rows: StatRow[] = [
    {
      label: 'Total Positions',
      render: () => <Numeric value={stats.totalPositions} kind="integer" direction="none" />,
    },
    { label: 'Total Net P&L', render: () => money(stats.totalNetPnl, 'auto') },
    {
      label: 'Win Rate',
      render: () => <Numeric value={stats.winRate} kind="percent" direction="none" />,
    },
    {
      label: 'Breakeven Rate',
      render: () => <Numeric value={stats.breakevenRate} kind="percent" direction="none" />,
    },
    { label: 'Avg Win', render: () => money(stats.avgWin, 'auto') },
    { label: 'Avg Loss', render: () => money(stats.avgLoss, 'auto') },
    {
      label: 'Profit Factor',
      // Finite profit factor routes through the primitive (neutral decimal); the
      // ∞ / em-dash branches the primitive does not model stay on formatProfitFactor.
      render: () =>
        stats.profitFactor !== null ? (
          <Numeric value={stats.profitFactor} kind="decimal" direction="none" />
        ) : (
          <span>{formatProfitFactor(stats.profitFactor, stats.hasWins, stats.hasLosses)}</span>
        ),
    },
    { label: 'Largest Win', render: () => money(stats.largestWin, 'auto') },
    { label: 'Largest Loss', render: () => money(stats.largestLoss, 'auto') },
  ];

  return (
    <Card data-testid="stats-panel">
      <CardHeader>
        <CardTitle>Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col">
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="font-medium" data-testid={`stat-${row.label}`}>
                {row.render()}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export default StatsPanel;
