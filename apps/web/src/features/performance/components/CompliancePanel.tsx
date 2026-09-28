import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTradingRules } from '@/features/trading-rules/hooks/useTradingRules';

import { useBreakdown } from '../hooks/useBreakdown';
import { complianceRateDocsUrl } from '../utils/statAnchors';

import type { DimensionBreakdownTableProps } from './DimensionBreakdownTable';

// The two scored rows the panel shows, in a fixed order. `unscored` is
// deliberately not shown — the panel is about the compliant-vs-non-compliant
// split beside the statistics (Requirement 8.1).
const SHOWN_KEYS = ['compliant', 'non_compliant'] as const;

/** Props mirror the `params`/`currency` of `DimensionBreakdownTable` (C11). */
export type CompliancePanelProps = Pick<DimensionBreakdownTableProps, 'params' | 'currency'>;

/**
 * CompliancePanel — the compliance rate and the compliant-vs-non-compliant split
 * beside the Statistics (design C11; Requirement 8). Rendered by `PerformancePage`
 * right after `StatsPanel`.
 *
 * It issues its own `by=compliance` breakdown, independent of the breakdown
 * selector, and takes every figure from that response through `Numeric` — it adds
 * no statistics formula (the API computes the rate, D11). Rule existence comes
 * from the rules list (`useTradingRules`, D5): the breakdown response carries no
 * rules-existence flag and cannot tell a user with no rules from one whose
 * positions are all unscored (Requirement 8.3), so with no rules the panel links
 * to the Rules tab instead of showing figures. Loading, empty and error stay
 * inside the panel.
 */
export function CompliancePanel({ params, currency }: CompliancePanelProps) {
  const rulesQuery = useTradingRules();
  const breakdown = useBreakdown({
    by: 'compliance',
    start: params.start,
    end: params.end,
    tz: params.tz,
    currency,
  });

  const noRules = rulesQuery.data !== undefined && rulesQuery.data.length === 0;

  let body: ReactNode;
  if (noRules) {
    body = (
      <p className="text-sm text-muted-foreground" data-testid="compliance-no-rules">
        No rules yet.{' '}
        <Link
          to="/settings/rules"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          data-testid="compliance-rules-link"
        >
          Set up rules
        </Link>{' '}
        to see your compliance rate.
      </p>
    );
  } else if (breakdown.status === 'pending') {
    body = (
      <div className="space-y-4" data-testid="compliance-loading">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (breakdown.status === 'error') {
    body = (
      <span
        className="inline-flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="compliance-error"
      >
        Couldn&apos;t load compliance.
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={() => void breakdown.refetch()}
        >
          Retry
        </Button>
      </span>
    );
  } else {
    // The page always requests the active currency, so the response carries a
    // single entry for that code; match it, falling back to the first.
    const currencyEntry =
      breakdown.data.currencies.find((c) => c.code === currency) ?? breakdown.data.currencies[0];

    if (!currencyEntry) {
      body = (
        <p className="text-sm text-muted-foreground" data-testid="compliance-empty">
          No closed positions in this timeframe.
        </p>
      );
    } else {
      const rate = currencyEntry.complianceRate ?? null;
      const rowByKey = new Map(currencyEntry.rows.map((row) => [row.key, row]));
      body = (
        <div className="space-y-4">
          <div className="flex flex-col">
            <span className="text-sm text-muted-foreground">
              {/* The rate label deep-links to its glossary definition, as the
                  StatsPanel labels do. New tab: the reader is mid-analysis. */}
              <a
                href={complianceRateDocsUrl()}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                Compliance rate
              </a>
            </span>
            <span className="text-2xl font-bold" data-testid="compliance-rate">
              {/* An em dash when the compliant + non-compliant sum is zero (D11);
                  `Numeric` renders that absent state for a null value. */}
              <Numeric value={rate} kind="percent" direction="none" />
            </span>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">Positions</TableHead>
                <TableHead className="text-right">Net P&L</TableHead>
                <TableHead className="text-right">Win rate</TableHead>
                <TableHead className="text-right">Expectancy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SHOWN_KEYS.map((key) => {
                const row = rowByKey.get(key);
                if (!row) return null;
                const stats = row.stats;
                return (
                  <TableRow key={key} data-testid={`compliance-row-${key}`}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell className="text-right">
                      <Numeric value={stats.totalPositions} kind="integer" direction="none" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Numeric
                        value={stats.totalNetPnl}
                        kind="money"
                        currency={currency}
                        direction="auto"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Numeric value={stats.winRate} kind="percent" direction="none" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Numeric
                        value={stats.expectancy}
                        kind="money"
                        currency={currency}
                        direction="auto"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      );
    }
  }

  return (
    <Card data-testid="compliance-panel">
      <CardHeader>
        <CardTitle>Compliance</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

export default CompliancePanel;
