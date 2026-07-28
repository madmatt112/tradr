// StatsCards — platform stats section of the admin page (design §Component 11).
//
// Labels are pinned by the spec: the active-user card says "Active now
// (last 30 min)" (derived from the schema's literal `activeUsersWindowMinutes`,
// never presented as a precise live count) and revenue is captioned
// "purchased-credit volume" — micro-USD purchased-credit sums, not fiat
// bookkeeping. A fresh instance gets zero-value cards from the API, never an
// error state here.

import type { AdminStats } from '@tradr/shared/schemas/admin';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { formatMicroUsd } from '../lib/format';

interface StatsCardsProps {
  stats: AdminStats | undefined;
  isLoading: boolean;
}

export function StatsCards({ stats, isLoading }: StatsCardsProps) {
  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Total users</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{stats.totalUsers}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Active now (last {stats.activeUsersWindowMinutes} min)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{stats.activeUsers}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Positions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{stats.positions.total}</p>
          <p className="text-xs text-muted-foreground">
            {stats.positions.draft} draft · {stats.positions.open} open · {stats.positions.closed}{' '}
            closed
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Revenue</CardTitle>
          <CardDescription>purchased-credit volume</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatMicroUsd(stats.revenue.allTime)}</p>
          <p className="text-xs text-muted-foreground">
            {formatMicroUsd(stats.revenue.currentMonth)} this month
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
