import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { Account } from '@tradr/shared';
import { CreateCashMovementInputSchema } from '@tradr/shared/schemas/accounting';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatMoney } from '@/lib/format';

import { useRecordCashMovement } from '../hooks/useCashMovements';

interface Props {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A `datetime-local` value ("YYYY-MM-DDTHH:mm") fails the API schema's
// `.datetime({ offset: true })` rule, which wants a full RFC-3339 instant. The
// form validates the RAW widget value, so validate the widget's own format here
// and convert to ISO in `onSubmit`; the API contract is untouched. Same pattern
// as FillDialog's `localDateTime`.
const localDateTime = z
  .string()
  .min(1, 'Required')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time');

const CashMovementFormSchema = CreateCashMovementInputSchema.extend({ occurredAt: localDateTime });
type CashMovementFormValues = z.infer<typeof CashMovementFormSchema>;

/** `new Date()` as "YYYY-MM-DDTHH:mm" in LOCAL wall time for a `datetime-local`
 * control. `toISOString().slice(0, 16)` (as FillDialog uses) would put UTC wall
 * time in a local widget, so build it from the local getters instead (D16). */
function nowLocalInputValue(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Round to 4dp — the ledger's `numeric(18, 4)` precision. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Parse the amount field, or return null when it is empty/unparseable/non-positive.
 * Kept tolerant on purpose: this drives the live preview while the user is still
 * typing. Unsigned and positive — a cash movement magnitude is always > 0; the
 * server derives the direction. Zod (via the resolver) is what actually gates
 * submission.
 *
 * Float arithmetic is fine here: this only feeds the PREVIEW. The server
 * recomputes the resulting balance with decimal.js inside its own transaction.
 */
function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Record a manual deposit or withdrawal (Req 6).
 *
 * The user picks the direction and enters a positive magnitude; the server
 * derives the ledger row's direction, entry type and resulting balance. The
 * resulting-balance figure here is a preview only. An overdraw is accepted with
 * a warning, not blocked (Req 6.4) — Tradr's balance is cash only and carries no
 * mark-to-market for open positions.
 */
export function RecordCashMovementDialog({ account, open, onOpenChange }: Props) {
  const record = useRecordCashMovement(account.id);

  const form = useForm<CashMovementFormValues>({
    resolver: zodResolver(CashMovementFormSchema),
    defaultValues: { type: 'deposit', amount: '', occurredAt: nowLocalInputValue() },
  });

  // Reset between openings so a stale amount or a drifted "now" never resurfaces.
  useEffect(() => {
    if (open) form.reset({ type: 'deposit', amount: '', occurredAt: nowLocalInputValue() });
  }, [open, form]);

  const type = form.watch('type');
  const current = Number(account.balance ?? '0');
  const parsed = parseAmount(form.watch('amount'));
  const resulting =
    parsed === null ? null : round4(type === 'deposit' ? current + parsed : current - parsed);

  const onSubmit = form.handleSubmit(async (values) => {
    await record.mutateAsync({
      type: values.type,
      amount: values.amount,
      occurredAt: new Date(values.occurredAt).toISOString(),
    });
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deposit or withdrawal</DialogTitle>
          <DialogDescription>
            Record money you moved into or out of this brokerage account. Tradr adds one ledger
            entry in the account&apos;s currency and moves the balance by the amount.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cashMovementType">Type</Label>
            <Select
              value={type}
              onValueChange={(val) => form.setValue('type', val as 'deposit' | 'withdrawal')}
            >
              <SelectTrigger id="cashMovementType" className="w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit">Deposit</SelectItem>
                <SelectItem value="withdrawal">Withdrawal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cashMovementAmount">Amount ({account.currency})</Label>
            <Input
              id="cashMovementAmount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              {...form.register('amount', {
                setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim() : v),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cashMovementOccurredAt">Date and time</Label>
            <Input
              id="cashMovementOccurredAt"
              type="datetime-local"
              {...form.register('occurredAt')}
            />
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Current balance</span>
            <span className="font-medium" data-testid="cash-movement-current-balance">
              {formatMoney(current.toString(), account.currency)}
            </span>
          </div>

          <div className="flex items-center justify-between border-t pt-3 text-sm">
            <span className="text-muted-foreground">Resulting balance</span>
            {resulting === null ? (
              <span className="text-muted-foreground" data-testid="cash-movement-resulting-balance">
                —
              </span>
            ) : (
              <span className="font-medium" data-testid="cash-movement-resulting-balance">
                {formatMoney(resulting.toString(), account.currency)}
              </span>
            )}
          </div>

          {resulting !== null && resulting < 0 && (
            <p className="text-sm text-warning" data-testid="cash-movement-negative-warning">
              The balance will go below zero. Tradr&apos;s balance is cash only and does not include
              the market value of open positions.
            </p>
          )}

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
              disabled={parsed === null || record.isPending}
            >
              {record.isPending
                ? 'Recording…'
                : type === 'deposit'
                  ? 'Record deposit'
                  : 'Record withdrawal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
