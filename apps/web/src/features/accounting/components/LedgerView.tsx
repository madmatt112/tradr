import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { LedgerEntry } from '@tradr/shared/schemas/accounting';

import { EmptyState } from '@/components/EmptyState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { useReverseCashMovement } from '@/features/accounting/hooks/useCashMovements';
import { useLedgerQuery } from '@/features/accounting/hooks/useLedger';
import { formatMoney } from '@/lib/format';

const PAGE_SIZE = 50;

// The three reversal entry types share the "(reversal)" badge; a Set keeps the
// membership test open to new reversal kinds without touching the row markup
// (replaces the former `entryType === 'position_pnl_reversal'` check).
const REVERSAL_TYPES = new Set<LedgerEntry['entryType']>([
  'position_pnl_reversal',
  'deposit_reversal',
  'withdrawal_reversal',
]);

// Map a cash-movement entry type to its user-facing noun. A deposit and its
// reversal both read "Deposit"; a withdrawal and its reversal "Withdrawal".
// Everything else (trades, balance adjustments) returns null.
function cashMovementLabel(t: LedgerEntry['entryType']): 'Deposit' | 'Withdrawal' | null {
  if (t === 'deposit' || t === 'deposit_reversal') return 'Deposit';
  if (t === 'withdrawal' || t === 'withdrawal_reversal') return 'Withdrawal';
  return null;
}

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
  const [deleteTarget, setDeleteTarget] = useState<LedgerEntry | null>(null);
  const { data, isLoading } = useLedgerQuery({ accountId, page });
  const reverse = useReverseCashMovement(accountId);

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
        description="No activity yet — record a deposit or close a position to see ledger entries here"
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
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.entries.map((entry, i) => {
            const isReversal = REVERSAL_TYPES.has(entry.entryType);
            // Branch on entryType BEFORE positionId. A balance adjustment has no
            // position by design (Req 8.12), so falling through to the
            // positionId-null branch below would label it "(deleted)" and read
            // as an orphaned trade row. The same holds for cash movements.
            const isAdjustment = entry.entryType === 'balance_adjustment';
            const cashLabel = cashMovementLabel(entry.entryType);
            // Only originating movements are reversible; a reversal row is not
            // itself deletable (Req 7.2).
            const isCashMovement =
              entry.entryType === 'deposit' || entry.entryType === 'withdrawal';
            return (
              <TableRow key={entry.id}>
                <TableCell>{new Date(entry.occurredAt).toLocaleString()}</TableCell>
                <TableCell>
                  {isAdjustment ? (
                    <Badge variant="secondary">Balance adjustment</Badge>
                  ) : cashLabel !== null ? (
                    <Badge variant="secondary">{cashLabel}</Badge>
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
                <TableCell className="text-right">
                  {isCashMovement ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="cursor-pointer text-muted-foreground"
                      aria-label={`Delete ${cashLabel?.toLowerCase()}`}
                      data-testid="ledger-delete-cash-movement"
                      onClick={() => setDeleteTarget(entry)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  ) : null}
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

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget ? cashMovementLabel(deleteTarget.entryType) : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  Tradr adds a reversal entry for{' '}
                  {formatMoney(deleteTarget.amount, deleteTarget.currency)} and keeps the original.
                  The balance returns to what it was before this{' '}
                  {cashMovementLabel(deleteTarget.entryType)}.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => {
                if (deleteTarget) reverse.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
