// UsageSection — usage & cost section of the admin page (design §Components
// 5 + 11; REQ-4.1/4.2/4.3, REQ-7.5).
//
// Billed vs provider cost are DISTINCT figures with the pinned Component 5
// captions: `billedCredits` is billed / as-charged consumption (it embeds
// PRICING_MARKUP); `providerCost` is the pre-markup sum of persisted
// `raw_cost` over covered rows only — never derived from current pricing
// config, and never summed or conflated with the billed figure. Rows charged
// before migration 0013 have no recorded raw cost; partial coverage is
// disclosed via the response's coverage counts. (The Component 5 response
// carries no first-covered date, so the disclosure is count-based — see the
// Task 20 implementation log.)
//
// UsageChart is the admin feature's ONLY Recharts importer, loaded via
// React.lazy + Suspense so Recharts stays in its own async chunk (REQ-7.5),
// per the features/performance PerformancePage precedent.

import { lazy, Suspense, useMemo, useState } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { useAdminUsage } from '../hooks/useAdminUsage';
import { formatIntString, formatMicroUsd } from '../lib/format';

const UsageChart = lazy(() => import('./UsageChart'));

const PRESET_DAYS = [7, 30, 90] as const;
type PresetDays = (typeof PRESET_DAYS)[number];

const DAY_MS = 86_400_000;

export function UsageSection() {
  const [days, setDays] = useState<PresetDays>(30);

  // Recomputed only on preset change so the ['admin','usage',{from,to}]
  // query key stays stable across renders.
  const period = useMemo(() => {
    const to = new Date();
    return {
      from: new Date(to.getTime() - days * DAY_MS).toISOString(),
      to: to.toISOString(),
    };
  }, [days]);

  const usage = useAdminUsage(period);
  const data = usage.data;

  return (
    <div className="space-y-4">
      <Tabs value={String(days)} onValueChange={(value) => setDays(Number(value) as PresetDays)}>
        <TabsList aria-label="Usage period">
          {PRESET_DAYS.map((preset) => (
            <TabsTrigger key={preset} value={String(preset)} className="cursor-pointer">
              {preset} days
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {usage.isError ? (
        <p className="text-sm text-muted-foreground">Failed to load usage.</p>
      ) : !data ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-[320px] w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          {/* Billed and provider cost are separate cards and never summed. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Billed credits</CardTitle>
                <CardDescription>
                  Billed / as-charged consumption (markup-inclusive)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">
                  {formatMicroUsd(data.totals.billedCredits)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Provider cost</CardTitle>
                <CardDescription>
                  Pre-markup provider cost from persisted raw cost — never derived from current
                  pricing config
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">
                  {data.totals.providerCost === null
                    ? '—'
                    : formatMicroUsd(data.totals.providerCost)}
                </p>
                <ProviderCoverageNote totals={data.totals} />
              </CardContent>
            </Card>
          </div>

          {data.series.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage recorded in this period.</p>
          ) : (
            <Suspense fallback={<Skeleton className="h-[320px] w-full" />}>
              <UsageChart series={data.series} />
            </Suspense>
          )}

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">Top users</h3>
              <p className="text-xs text-muted-foreground">top 50 by billed credits</p>
            </div>
            {data.topUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No user activity in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Billed credits</TableHead>
                    <TableHead className="text-right">Input tokens</TableHead>
                    <TableHead className="text-right">Output tokens</TableHead>
                    <TableHead className="text-right">Turns</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topUsers.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell>{user.email}</TableCell>
                      <TableCell className="text-right">
                        {formatMicroUsd(user.billedCredits)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatIntString(user.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatIntString(user.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right">{user.turns}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface ProviderCoverageNoteProps {
  totals: {
    providerCost: string | null;
    providerCostCoverage: { records: number; recordsWithRawCost: number };
  };
}

// Coverage honesty (REQ-4.2): rows charged before migration 0013 have no
// persisted raw_cost and are excluded from providerCost — when coverage is
// partial that exclusion is disclosed explicitly, never back-derived.
function ProviderCoverageNote({ totals }: ProviderCoverageNoteProps) {
  const { records, recordsWithRawCost } = totals.providerCostCoverage;

  if (totals.providerCost === null) {
    return (
      <p className="text-xs text-muted-foreground">
        No records with recorded provider cost in this period.
      </p>
    );
  }

  if (recordsWithRawCost < records) {
    return (
      <p className="text-xs text-muted-foreground">
        Partial coverage: provider cost recorded for {recordsWithRawCost} of {records} records in
        this period — earlier records predate provider-cost capture and are excluded.
      </p>
    );
  }

  return null;
}
