import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import type { LedgerEntry } from '@tradr/shared/schemas/accounting';

import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLedgerQuery } from '@/features/accounting/hooks/useLedger';
import { formatMoney } from '@/lib/format';

const PAGE_SIZE = 50;

interface Props {
  accountId: string;
  currency: string;
}

/**
 * Compute per-row running balances by summing forward from
 * `runningBalanceAtFirstRow`. Entries are ordered newest-first
 * (occurredAt DESC, createdAt DESC). The anchor represents the cumulative
 * balance up to (exclusive) the first page row — i.e., the balance state
 * immediately BEFORE the newest displayed entry was applied.
 *
 * Recurrence: B[0] = anchor + delta[0]; B[i] = B[i-1] − delta[i-1]
 *   where delta[i] = (direction === 'credit' ? +amount : −amount).
 */
function computeRunningBalances(
  entries: LedgerEntry[],
  runningBalanceAtFirstRow: string,
): number[] {
  if (entries.length === 0) return [];
  const anchor = Number(runningBalanceAtFirstRow);
  const balances = new Array<number>(entries.length);
  const delta = (e: LedgerEntry) =>
    e.direction === 'credit' ? Number(e.amount) : -Number(e.amount);
  balances[0] = anchor + delta(entries[0]);
  for (let i = 1; i < entries.length; i++) {
    balances[i] = balances[i - 1] - delta(entries[i - 1]);
  }
  return balances;
}

function formatNumber(n: number, currency: string): string {
  // Round to 4dp to match ledger amount precision before formatting.
  const rounded = Math.round(n * 10000) / 10000;
  return formatMoney(rounded.toString(), currency);
}

export function LedgerView({ accountId, currency }: Props) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useLedgerQuery({ accountId, page });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!data || data.entries.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="No activity yet — close a position to see ledger entries here"
      />
    );
  }

  const runningBalances = computeRunningBalances(data.entries, data.runningBalanceAtFirstRow);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Occurred at</TableHead>
            <TableHead>Position</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.entries.map((entry, i) => {
            const isReversal = entry.entryType === 'position_pnl_reversal';
            // Branch on entryType BEFORE positionId. A balance adjustment has no
            // position by design (Req 8.12), so falling through to the
            // positionId-null branch below would label it "(deleted)" and read
            // as an orphaned trade row.
            const isAdjustment = entry.entryType === 'balance_adjustment';
            return (
              <TableRow key={entry.id}>
                <TableCell>{new Date(entry.occurredAt).toLocaleString()}</TableCell>
                <TableCell>
                  {isAdjustment ? (
                    <Badge variant="secondary">Balance adjustment</Badge>
                  ) : entry.positionId ? (
                    <Link
                      to="/positions/$positionId"
                      params={{ positionId: entry.positionId }}
                      className="font-medium hover:underline"
                    >
                      {entry.symbol ?? '—'}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">
                      {entry.symbol ? `${entry.symbol} (deleted)` : '(deleted)'}
                    </span>
                  )}
                  {isReversal && (
                    <Badge variant="outline" className="ml-2">
                      (reversal)
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {entry.direction === 'debit' ? formatMoney(entry.amount, entry.currency) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {entry.direction === 'credit' ? formatMoney(entry.amount, entry.currency) : '—'}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatNumber(runningBalances[i], currency)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {(page > 1 || data.hasMore) && (
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} · {PAGE_SIZE} per page
          </span>
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={!data.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
