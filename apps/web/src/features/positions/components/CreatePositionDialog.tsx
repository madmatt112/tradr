import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { CreatePositionInput } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { approachingRemaining, isAccountWritable } from '@/features/billing/tier-usage';
import { UpgradeLink } from '@/features/billing/UpgradeLink';
import { useTierState } from '@/features/billing/useTierState';

import { getPositionErrorCode, useCreatePosition } from '../hooks/usePositions';
import { encodeContract, occErrorField, type OptionContractInputs } from '../utils/occForm';

import { OptionContractFields } from './OptionContractFields';

/**
 * Local UI-only form schema (structure.md "Forms"). NOT `CreatePositionSchema`:
 * in option mode the wire `symbol` is empty until encoded, which the (now
 * option-gated) shared schema would reject. The per-field option checks here are
 * ADVISORY UX only — they attach errors to the right field early but never
 * contradict the encoder's bounds. `encodeContract` (the shared
 * `encodeOccCompact`) is the single authoritative gate at submit; representability
 * and compact-length are left to it.
 */
const CreatePositionFormSchema = z
  .object({
    accountId: z.string().uuid('Select an account'),
    side: z.enum(['long', 'short']),
    assetType: z.enum(['stock', 'option']),
    notes: z.string().max(10000).nullable().optional(),
    // Stock-only ticker (trim/upper-case mirrors the shared schema, byte-for-byte).
    symbol: z.string().trim().toUpperCase(),
    // Option-only structured inputs.
    underlying: z.string(),
    expiry: z.string(),
    optionType: z.enum(['call', 'put']),
    strike: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.assetType === 'stock') {
      if (data.symbol.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['symbol'],
          message: 'Symbol is required',
        });
      } else if (data.symbol.length > 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['symbol'],
          message: 'Symbol must be at most 20 characters',
        });
      }
      return;
    }

    // Option mode — advisory per-field checks (Req 4.1–4.3, 4.5).
    const underlying = data.underlying.trim().toUpperCase();
    if (!/^[A-Z][A-Z.]{0,5}$/.test(underlying)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['underlying'],
        message: 'Underlying must be 1–6 letters',
      });
    }

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.expiry);
    let validExpiry = false;
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y >= 2000 && y <= 2049) {
        const dt = new Date(Date.UTC(y, mo - 1, d));
        validExpiry =
          dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
      }
    }
    if (!validExpiry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiry'],
        message: 'Expiry must be a valid date in 2000–2049',
      });
    }

    // Advisory only: require a positive, in-range number. Decimal precision is
    // the encoder's authoritative call — a raw-string-length decimal-place check
    // here would wrongly block trailing-zero strikes the encoder accepts (e.g.
    // `1.5000`/`150.00`). `encodeContract` rejects over-precise strikes at submit
    // (OCC_STRIKE_PRECISION → strike field).
    const strikeStr = data.strike.trim();
    const strikeNum = Number(strikeStr);
    if (strikeStr === '' || !Number.isFinite(strikeNum) || strikeNum <= 0 || strikeNum >= 100000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strike'],
        message: 'Strike must be greater than 0 and less than 100000',
      });
    }
  });

type CreatePositionFormInput = z.infer<typeof CreatePositionFormSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// The plan-tiers refusal codes this dialog maps (REQ-11.5). Branching is on
// the machine-readable CODE only, never on message text.
const TIER_REFUSAL_MESSAGES: Record<string, string> = {
  TIER_LIMIT_POSITIONS: "You've reached your plan's position limit.",
  TIER_ACCOUNT_NOT_WRITABLE:
    'This account is read-only on your plan — pick your writable account, or change it on the Accounts page.',
};

export function CreatePositionDialog({ open, onOpenChange }: Props) {
  const { data: accounts } = useAccounts();
  const createPosition = useCreatePosition();
  const { data: tierState } = useTierState();
  // The rare non-field encoder error (e.g. OCC_COMPACT_TOO_LONG) lives here and
  // renders in OptionContractFields' form slot — not as an RHF field error.
  const [formError, setFormError] = useState<string | null>(null);
  // Tier refusal code from the last submit (TIER_LIMIT_POSITIONS /
  // TIER_ACCOUNT_NOT_WRITABLE) — rendered inline with the upgrade path.
  const [tierRefusalCode, setTierRefusalCode] = useState<string | null>(null);

  // ≥80% L2 hint (REQ-11.6 working default) from the already-fetched tier
  // state; usage is null on self-host/admin, so the hint stays off there.
  const currentCaps = tierState?.usage ? tierState.limits[tierState.tier] : undefined;
  const positionsHint = approachingRemaining(
    tierState?.usage?.positions.used,
    currentCaps?.positions,
  );

  const form = useForm<CreatePositionFormInput>({
    resolver: zodResolver(CreatePositionFormSchema),
    defaultValues: {
      accountId: '',
      side: 'long',
      assetType: 'stock',
      notes: null,
      symbol: '',
      underlying: '',
      expiry: '',
      optionType: 'call',
      strike: '',
    },
  });

  const assetType = form.watch('assetType');

  // Req 1.3: preserve side/account/notes; clear the stock symbol and all option
  // inputs; reset Type → Call. Values are NOT restored on toggle-back.
  function handleAssetTypeChange(next: 'stock' | 'option') {
    form.setValue('assetType', next);
    form.setValue('symbol', '');
    form.setValue('underlying', '');
    form.setValue('expiry', '');
    form.setValue('optionType', 'call');
    form.setValue('strike', '');
    form.clearErrors(['symbol', 'underlying', 'expiry', 'strike']);
    setFormError(null);
  }

  const onSubmit = form.handleSubmit(async (data) => {
    setFormError(null);
    setTierRefusalCode(null);

    let symbol: string;
    if (data.assetType === 'stock') {
      symbol = data.symbol; // Req 2.4 — no OCC encoding for stock.
    } else {
      const result = encodeContract({
        underlying: data.underlying,
        expiry: data.expiry,
        type: data.optionType,
        strike: data.strike,
      });
      if (!result.ok) {
        // encodeContract is the single authoritative submit gate (Req 4.4).
        const field = occErrorField(result.error.code);
        if (field === 'form') {
          setFormError(result.error.message);
        } else {
          form.setError(field, { message: result.error.message });
        }
        return;
      }
      symbol = result.value;
    }

    const payload: CreatePositionInput = {
      accountId: data.accountId,
      symbol,
      side: data.side,
      assetType: data.assetType,
      notes: data.notes,
    };
    try {
      await createPosition.mutateAsync(payload);
    } catch (err) {
      // Keep the dialog (and the typed form) open on failure. Tier refusals
      // render inline below, mapped on the CODE; everything else already
      // toasted via the mutation's onError.
      const code = getPositionErrorCode(err);
      if (code && code in TIER_REFUSAL_MESSAGES) setTierRefusalCode(code);
      return;
    }
    onOpenChange(false);
    form.reset();
    setFormError(null);
  });

  const optionInputs: OptionContractInputs = {
    underlying: form.watch('underlying'),
    expiry: form.watch('expiry'),
    type: form.watch('optionType'),
    strike: form.watch('strike'),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Position</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {tierRefusalCode && (
            <div
              data-testid="position-tier-refusal"
              data-error-code={tierRefusalCode}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3"
            >
              <span className="text-sm text-destructive">
                {TIER_REFUSAL_MESSAGES[tierRefusalCode]}
              </span>
              {tierState?.purchasable && <UpgradeLink surface="position-dialog" />}
            </div>
          )}

          {positionsHint !== null && (
            <p data-testid="tier-positions-hint" className="text-xs text-muted-foreground">
              {positionsHint} position{positionsHint === 1 ? '' : 's'} left on your plan
            </p>
          )}

          {assetType === 'stock' ? (
            <div className="space-y-2">
              <Label htmlFor="symbol">Symbol</Label>
              <Input id="symbol" {...form.register('symbol')} placeholder="e.g., AAPL" />
              {form.formState.errors.symbol && (
                <p className="text-sm text-destructive">{form.formState.errors.symbol.message}</p>
              )}
            </div>
          ) : (
            <OptionContractFields
              value={optionInputs}
              onChange={(next) => {
                form.setValue('underlying', next.underlying);
                form.setValue('expiry', next.expiry);
                form.setValue('optionType', next.type);
                form.setValue('strike', next.strike);
              }}
              errors={{
                underlying: form.formState.errors.underlying?.message,
                expiry: form.formState.errors.expiry?.message,
                strike: form.formState.errors.strike?.message,
                form: formError ?? undefined,
              }}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Side</Label>
              <Select
                value={form.watch('side')}
                onValueChange={(val) => form.setValue('side', val as 'long' | 'short')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="long">Long</SelectItem>
                  <SelectItem value="short">Short</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Asset Type</Label>
              <Select
                value={assetType}
                onValueChange={(val) => handleAssetTypeChange(val as 'stock' | 'option')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stock">Stock</SelectItem>
                  <SelectItem value="option">Option</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Account</Label>
            <Select
              value={form.watch('accountId')}
              onValueChange={(val) => form.setValue('accountId', val)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {/* Non-writable accounts are disabled + badged instead of
                    inviting a 403 (plan-tiers D18) — writable on self-host,
                    Pro, and under the cap. */}
                {accounts?.map((a) => {
                  const writable = isAccountWritable(tierState, a.id);
                  return (
                    <SelectItem key={a.id} value={a.id} disabled={!writable}>
                      {a.name} ({a.currency}){writable ? '' : ' — read-only on your plan'}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {form.formState.errors.accountId && (
              <p className="text-sm text-destructive">{form.formState.errors.accountId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" {...form.register('notes')} placeholder="Optional notes..." />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="cursor-pointer" disabled={createPosition.isPending}>
              {createPosition.isPending ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
