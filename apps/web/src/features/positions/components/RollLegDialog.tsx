import { useState, type FormEvent } from 'react';

import type { RollLegInput } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useRollLeg } from '../hooks/useOptionLifecycle';
import { encodeContract, occErrorField, type OptionContractInputs } from '../utils/occForm';

import { OptionContractFields } from './OptionContractFields';

function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

// The plan-tiers refusal code a roll can draw (AC 5.5), mapped the same way
// CreatePositionDialog.tsx maps its own — branch on the CODE only, never
// message text.
const TIER_REFUSAL_MESSAGES: Record<string, string> = {
  TIER_LIMIT_POSITIONS: "You've reached your plan's position limit.",
};

interface Props {
  position: { id: string; symbol: string; openUnits: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rolls an open option leg into a new contract (design C6/C10): the new
 * contract through `OptionContractFields`, quantity defaulted to the leg's
 * open units, close/open prices, both fees and a required date.
 */
export function RollLegDialog({ position, open, onOpenChange }: Props) {
  const rollLeg = useRollLeg(position.id);

  const [contract, setContract] = useState<OptionContractInputs>({
    underlying: '',
    expiry: '',
    type: 'call',
    strike: '',
  });
  const [quantity, setQuantity] = useState(String(position.openUnits));
  const [closePrice, setClosePrice] = useState('');
  const [openPrice, setOpenPrice] = useState('');
  const [closeFees, setCloseFees] = useState('');
  const [openFees, setOpenFees] = useState('');
  const [date, setDate] = useState('');
  const [contractErrors, setContractErrors] = useState<
    Partial<Record<'underlying' | 'expiry' | 'strike' | 'form', string>>
  >({});
  const [tierRefusalCode, setTierRefusalCode] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setContractErrors({});
    setTierRefusalCode(null);

    // encodeContract is the single authoritative gate on the new symbol
    // (same rule CreatePositionDialog follows for its own contract entry).
    const encoded = encodeContract(contract);
    if (!encoded.ok) {
      setContractErrors({ [occErrorField(encoded.error.code)]: encoded.error.message });
      return;
    }

    const payload: RollLegInput = {
      newSymbol: encoded.value,
      quantity,
      closePrice,
      openPrice,
      rolledAt: new Date(date).toISOString(),
    };
    if (closeFees) payload.closeFees = closeFees;
    if (openFees) payload.openFees = openFees;

    try {
      await rollLeg.mutateAsync(payload);
    } catch (err) {
      const code = getErrorCode(err);
      if (code && code in TIER_REFUSAL_MESSAGES) {
        setTierRefusalCode(code);
      } else {
        setContractErrors({ form: getErrorMessage(err, 'Failed to roll leg') });
      }
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle>Roll {position.symbol}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {tierRefusalCode && (
              <div
                data-testid="roll-tier-refusal"
                data-error-code={tierRefusalCode}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3"
              >
                <span className="text-sm text-destructive">
                  {TIER_REFUSAL_MESSAGES[tierRefusalCode]}
                </span>
              </div>
            )}

            <OptionContractFields
              value={contract}
              onChange={setContract}
              errors={contractErrors}
              idPrefix="roll"
            />

            <div className="space-y-2">
              <Label htmlFor="roll-quantity">Quantity</Label>
              <Input
                id="roll-quantity"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-close-price">Close price</Label>
              <Input
                id="roll-close-price"
                value={closePrice}
                onChange={(e) => setClosePrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-open-price">Open price</Label>
              <Input
                id="roll-open-price"
                value={openPrice}
                onChange={(e) => setOpenPrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-close-fee">Close fee</Label>
              <Input
                id="roll-close-fee"
                value={closeFees}
                onChange={(e) => setCloseFees(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-open-fee">Open fee</Label>
              <Input
                id="roll-open-fee"
                value={openFees}
                onChange={(e) => setOpenFees(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-date">Date</Label>
              <Input
                id="roll-date"
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
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
            <Button type="submit" className="cursor-pointer" disabled={rollLeg.isPending}>
              {rollLeg.isPending ? 'Rolling...' : 'Roll'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
