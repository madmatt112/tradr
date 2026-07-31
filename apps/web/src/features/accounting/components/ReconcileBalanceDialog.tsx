import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import type { Account } from '@tradr/shared';
import {
  ReconcileBalanceInputSchema,
  type ReconcileBalanceInput,
} from '@tradr/shared/schemas/accounting';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/format';

import { useReconcileBalance } from '../hooks/useReconcileBalance';

interface Props {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Round to 4dp — the ledger's `numeric(18, 4)` precision. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Parse the target field, or return null when it is empty/unparseable. Kept
 * tolerant on purpose: this drives the live preview while the user is still
 * typing, so a half-entered value must not throw. Zod (via the resolver) is
 * what actually gates submission.
 *
 * Float arithmetic is fine here and follows the same convention as
 * `LedgerView.computeRunningBalances` — this delta is only a PREVIEW. The
 * server recomputes it with decimal.js inside the transaction that writes the
 * row (Req 8.2), so the value actually stored is never derived from this.
 */
function parseTarget(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cash balance reconciliation (Req 8.11).
 *
 * The user states what the account's cash balance actually is; Tradr posts one
 * adjusting ledger entry for the difference. The delta shown here is a preview
 * — the server recomputes it inside its own transaction, so what gets written
 * is correct even if a position closes while this dialog is open.
 *
 * The disclosure copy is required, not decorative: Tradr's balance is starting
 * balance plus realized P&L and carries no mark-to-market, so the user needs to
 * know which figure to type. Open positions deliberately do not block or warn.
 */
export function ReconcileBalanceDialog({ account, open, onOpenChange }: Props) {
  const reconcile = useReconcileBalance(account.id);

  const form = useForm<ReconcileBalanceInput>({
    resolver: zodResolver(ReconcileBalanceInputSchema),
    defaultValues: { targetBalance: '' },
  });

  // Reset between openings so a previously-typed figure never resurfaces
  // against a balance that has since moved.
  useEffect(() => {
    if (open) form.reset({ targetBalance: '' });
  }, [open, form]);

  const current = Number(account.balance ?? '0');
  const target = parseTarget(form.watch('targetBalance'));
  const delta = target === null ? null : round4(target - current);
  const isNoop = delta !== null && delta === 0;

  const onSubmit = form.handleSubmit(async (values) => {
    await reconcile.mutateAsync(values.targetBalance);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconcile cash balance</DialogTitle>
          <DialogDescription>
            Tradr tracks this account&apos;s cash balance: your starting balance plus realized
            P&amp;L from closed trades. It does not include the market value of open positions.
            Enter the cash balance this account should show — Tradr posts a single adjusting entry
            for the difference.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Current balance</span>
            <span className="font-medium" data-testid="reconcile-current-balance">
              {formatMoney(current.toString(), account.currency)}
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="targetBalance">Actual cash balance</Label>
            <Input
              id="targetBalance"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              {...form.register('targetBalance', {
                setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim() : v),
              })}
            />
            {form.formState.errors.targetBalance && (
              <p className="text-sm text-destructive">
                {form.formState.errors.targetBalance.message}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between border-t pt-3 text-sm">
            <span className="text-muted-foreground">Adjustment</span>
            {delta === null ? (
              <span className="text-muted-foreground">—</span>
            ) : isNoop ? (
              <span className="text-muted-foreground" data-testid="reconcile-adjustment">
                No change — the balance already matches
              </span>
            ) : (
              <span className="font-medium" data-testid="reconcile-adjustment">
                {delta > 0 ? '+' : '−'}
                {formatMoney(Math.abs(delta).toString(), account.currency)}{' '}
                <span className="text-muted-foreground">({delta > 0 ? 'credit' : 'debit'})</span>
              </span>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="cursor-pointer"
              disabled={delta === null || isNoop || reconcile.isPending}
            >
              {reconcile.isPending ? 'Posting…' : 'Post adjustment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
