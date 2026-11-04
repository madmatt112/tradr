import { useState } from 'react';

import {
  computeMaxLoss,
  computeNetEntry,
  detectStrategyLabel,
  getCurrencyMinorUnits,
  MAX_GROUP_LEGS,
  type Account,
  type StrategyLeg,
} from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { useCreatePositionGroup } from '../hooks/usePositionGroups';
import { getPositionErrorCode } from '../hooks/usePositions';
import { maxLossReasonText } from '../utils/listEntries';
import { encodeContract, type OptionContractInputs } from '../utils/occForm';

import { OptionContractFields } from './OptionContractFields';

const MIN_LEGS = 2;

// Mirrors CreatePositionDialog's TIER_REFUSAL_MESSAGES (REQ-11.5). Kept local
// rather than imported to avoid a circular import with that dialog, which
// renders this form.
const TIER_REFUSAL_MESSAGES: Record<string, string> = {
  TIER_LIMIT_POSITIONS: "You've reached your plan's position limit.",
  TIER_ACCOUNT_NOT_WRITABLE:
    'This account is read-only on your plan — pick your writable account, or change it on the Accounts page.',
};

interface LegRow {
  assetType: 'stock' | 'option';
  side: 'long' | 'short';
  symbol: string;
  option: OptionContractInputs;
  quantity: string;
  price: string;
  fee: string;
}

function emptyLeg(): LegRow {
  return {
    assetType: 'stock',
    side: 'long',
    symbol: '',
    option: { underlying: '', expiry: '', type: 'call', strike: '' },
    quantity: '',
    price: '',
    fee: '0',
  };
}

/** The leg's compact OCC symbol (option) or raw ticker (stock); '' when not yet encodable. */
function legSymbol(leg: LegRow): string {
  if (leg.assetType === 'stock') return leg.symbol.trim().toUpperCase();
  const result = encodeContract(leg.option);
  return result.ok ? result.value : '';
}

/**
 * Builds a `StrategyLeg` for the live preview (task 2's `detectStrategyLabel`
 * / `computeNetEntry` / `computeMaxLoss`): nothing is exited yet, so
 * `exitQty` is always `0` and `entryCost` is price times quantity with no
 * contract multiplier (the functions apply that themselves). Null when the
 * row isn't yet a complete leg.
 */
function toStrategyLeg(leg: LegRow): StrategyLeg | null {
  const quantity = Number(leg.quantity);
  const price = Number(leg.price);
  const fee = Number(leg.fee || '0');
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(price) || price < 0) return null;
  if (!Number.isFinite(fee) || fee < 0) return null;

  const symbol = legSymbol(leg);
  if (!symbol) return null;

  return {
    symbol,
    side: leg.side,
    assetType: leg.assetType,
    entryQty: leg.quantity,
    exitQty: '0',
    entryCost: String(quantity * price),
    entryFees: leg.fee || '0',
  };
}

function formatMoney(amount: number, minorUnits: number): string {
  return `$${amount.toFixed(minorUnits)}`;
}

/**
 * A two-way tab toggle (Stock/Option, Long/Short) that activates on a plain
 * click. `@/components/ui/tabs` (Radix) activates on `pointerdown`/roving
 * focus, which real browsers reach via the native focus-on-click side
 * effect but jsdom's synthetic `click` never produces — it's why this stays
 * a small hand-rolled control rather than the shared primitive.
 */
function RowTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div role="tablist" className="inline-flex items-center gap-[3px] rounded-lg bg-muted p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          data-state={value === option.value ? 'active' : 'inactive'}
          className={cn(
            'cursor-pointer rounded-md px-2 py-1 text-sm font-medium transition-all',
            value === option.value
              ? 'bg-background text-foreground shadow-xs'
              : 'text-foreground/60 hover:text-foreground',
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface Props {
  accounts: Account[] | undefined;
  onOpenChange: (open: boolean) => void;
}

export function MultiLegEntryForm({ accounts, onOpenChange }: Props) {
  const createGroup = useCreatePositionGroup();
  const [accountId, setAccountId] = useState('');
  const [filledAt, setFilledAt] = useState('');
  const [legs, setLegs] = useState<LegRow[]>([emptyLeg(), emptyLeg()]);
  const [labelOverride, setLabelOverride] = useState<string | null>(null);
  const [legErrors, setLegErrors] = useState<Record<number, string>>({});
  const [refusalCode, setRefusalCode] = useState<string | null>(null);

  function updateLeg(index: number, patch: Partial<LegRow>): void {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
  }

  function addLeg(): void {
    setLegs((prev) => (prev.length >= MAX_GROUP_LEGS ? prev : [...prev, emptyLeg()]));
  }

  function removeLeg(index: number): void {
    setLegs((prev) => (prev.length <= MIN_LEGS ? prev : prev.filter((_, i) => i !== index)));
  }

  const strategyLegs = legs.map(toStrategyLeg);
  const validLegs = strategyLegs.every((leg): leg is StrategyLeg => leg !== null)
    ? (strategyLegs as StrategyLeg[])
    : null;

  const selectedAccount = accounts?.find((a) => a.id === accountId);
  const minorUnits = getCurrencyMinorUnits(selectedAccount?.currency ?? 'USD');
  const detectedLabel = validLegs ? detectStrategyLabel(validLegs) : 'Multi-leg';
  const displayLabel = labelOverride ?? detectedLabel;
  const netEntry = validLegs ? computeNetEntry(validLegs, minorUnits) : null;
  const { maxLoss, maxLossReason } = validLegs
    ? computeMaxLoss(validLegs, minorUnits)
    : { maxLoss: null, maxLossReason: null };

  async function handleSubmit(): Promise<void> {
    setLegErrors({});
    setRefusalCode(null);
    if (!accountId || !filledAt) return;

    try {
      await createGroup.mutateAsync({
        accountId,
        filledAt: new Date(filledAt).toISOString(),
        labelOverride: displayLabel,
        legs: legs.map((leg) => ({
          symbol: legSymbol(leg),
          side: leg.side,
          assetType: leg.assetType,
          quantity: leg.quantity,
          price: leg.price,
          fees: leg.fee || '0',
        })),
      });
    } catch (err) {
      const code = getPositionErrorCode(err);
      if (code && code in TIER_REFUSAL_MESSAGES) {
        setRefusalCode(code);
        return;
      }
      const details = (err as { error?: { details?: Record<string, string> } } | undefined)?.error
        ?.details;
      const message = (err as { error?: { message?: string } } | undefined)?.error?.message;
      if (details?.legIndex !== undefined) {
        setLegErrors({ [Number(details.legIndex)]: message ?? 'That leg is invalid.' });
      }
      return;
    }

    onOpenChange(false);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      className="flex max-h-[70vh] flex-col gap-4"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {refusalCode && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {TIER_REFUSAL_MESSAGES[refusalCode]}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="multi-leg-filled-at">Fill date</Label>
            <Input
              id="multi-leg-filled-at"
              type="datetime-local"
              value={filledAt}
              onChange={(e) => setFilledAt(e.target.value)}
            />
          </div>
        </div>

        {legs.map((leg, index) => (
          <div key={index} className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <RowTabs
                value={leg.assetType}
                onChange={(v) => updateLeg(index, { assetType: v })}
                options={[
                  { value: 'stock', label: 'Stock' },
                  { value: 'option', label: 'Option' },
                ]}
              />
              <RowTabs
                value={leg.side}
                onChange={(v) => updateLeg(index, { side: v })}
                options={[
                  { value: 'long', label: 'Long' },
                  { value: 'short', label: 'Short' },
                ]}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={legs.length <= MIN_LEGS}
                onClick={() => removeLeg(index)}
              >
                Remove leg
              </Button>
            </div>

            {leg.assetType === 'stock' ? (
              <div className="space-y-2">
                <Label htmlFor={`leg-${index}-symbol`}>Symbol</Label>
                <Input
                  id={`leg-${index}-symbol`}
                  value={leg.symbol}
                  onChange={(e) => updateLeg(index, { symbol: e.target.value })}
                  placeholder="AAPL"
                />
              </div>
            ) : (
              <OptionContractFields
                idPrefix={`leg-${index}`}
                value={leg.option}
                onChange={(next) => updateLeg(index, { option: next })}
              />
            )}

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor={`leg-${index}-quantity`}>Quantity</Label>
                <Input
                  id={`leg-${index}-quantity`}
                  value={leg.quantity}
                  onChange={(e) => updateLeg(index, { quantity: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`leg-${index}-price`}>Price</Label>
                <Input
                  id={`leg-${index}-price`}
                  value={leg.price}
                  onChange={(e) => updateLeg(index, { price: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`leg-${index}-fee`}>Fee</Label>
                <Input
                  id={`leg-${index}-fee`}
                  value={leg.fee}
                  onChange={(e) => updateLeg(index, { fee: e.target.value })}
                />
              </div>
            </div>

            {legErrors[index] && (
              <p data-testid={`leg-${index}-error`} className="text-sm text-destructive">
                {legErrors[index]}
              </p>
            )}
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          className="cursor-pointer"
          disabled={legs.length >= MAX_GROUP_LEGS}
          onClick={addLeg}
        >
          Add leg
        </Button>

        <div className="space-y-2">
          <Label htmlFor="multi-leg-label">Label</Label>
          <Input
            id="multi-leg-label"
            value={displayLabel}
            onChange={(e) => setLabelOverride(e.target.value)}
          />
        </div>

        <div className="flex gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Net entry: </span>
            <span data-testid="multi-leg-net-entry">
              {netEntry === null ? '—' : formatMoney(netEntry, minorUnits)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Max loss: </span>
            <span data-testid="multi-leg-max-loss">
              {maxLossReason
                ? maxLossReasonText(maxLossReason)
                : maxLoss === null
                  ? '—'
                  : formatMoney(maxLoss, minorUnits)}
            </span>
          </div>
        </div>
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
        <Button type="submit" className="cursor-pointer" disabled={createGroup.isPending}>
          {createGroup.isPending ? 'Creating...' : 'Create group'}
        </Button>
      </div>
    </form>
  );
}
