import { useEffect, useState, type FormEvent } from 'react';

import type { PositionGroupEntry } from '@tradr/shared';

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

import { useAccountFeeSchedule } from '../hooks/useAccountFeeSchedule';
import { useCloseGroup } from '../hooks/usePositionGroups';
import { computeFillFee } from '../utils/fillFees';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

interface Props {
  group: PositionGroupEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LegFormState {
  price: string;
  fee: string;
  /** Once the user has typed into the fee field directly, a later price edit
   * stops recomputing it — a typed value is never silently overwritten. */
  feeTouched: boolean;
}

function initialLegState(legs: PositionGroupEntry['legs']): Record<string, LegFormState> {
  return Object.fromEntries(
    legs
      .filter((leg) => leg.status === 'open')
      .map((leg) => [leg.id, { price: '', fee: '0', feeTouched: false }]),
  );
}

/**
 * Closes every open leg of a group in one submit (design C13, Requirement
 * 4). A price of 0 is accepted (AC 4.5) — `computeFillFee` returns null at a
 * price of 0 (`apps/web/src/features/positions/utils/fillFees.ts:34`), so
 * the fee preview reads 0 and stays directly editable rather than locked, as
 * `FillDialog`'s calculated field is.
 */
export function CloseGroupDialog({ group, open, onOpenChange }: Props) {
  const closeGroup = useCloseGroup(group.id);
  const feeSchedule = useAccountFeeSchedule(group.accountId);
  const openLegs = group.legs.filter((leg) => leg.status === 'open');

  const [legState, setLegState] = useState<Record<string, LegFormState>>(() =>
    initialLegState(group.legs),
  );
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed on each open — the dialog stays mounted across opens, exactly as
  // FillDialog's own effect does (apps/web/src/features/positions/components/FillDialog.tsx:172-187).
  useEffect(() => {
    if (!open) return;
    setLegState(initialLegState(group.legs));
    setDate('');
    setError(null);
    // Re-seeds on an open transition or a change of group identity, not on
    // every render of the (stable, query-cached) `group` object.
  }, [open, group.id]);

  function setPrice(legId: string, price: string) {
    const leg = openLegs.find((l) => l.id === legId);
    setLegState((prev) => {
      const row = prev[legId];
      if (!row || !leg) return prev;
      const fee = row.feeTouched
        ? row.fee
        : feeSchedule
          ? (computeFillFee({
              schedule: feeSchedule,
              assetType: leg.assetType,
              positionSide: leg.side,
              type: 'exit',
              price,
              quantity: String(leg.openUnits),
            }) ?? '0')
          : row.fee;
      return { ...prev, [legId]: { ...row, price, fee } };
    });
  }

  function setFee(legId: string, fee: string) {
    setLegState((prev) => {
      const row = prev[legId];
      if (!row) return prev;
      return { ...prev, [legId]: { ...row, fee, feeTouched: true } };
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await closeGroup.mutateAsync({
        exits: openLegs.map((leg) => ({
          positionId: leg.id,
          price: legState[leg.id]?.price ?? '',
          fees: legState[leg.id]?.fee ?? '0',
        })),
        ...(date ? { closedAt: new Date(date).toISOString() } : {}),
      });
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to close group'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle>Close all legs</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {openLegs.map((leg) => (
              <div key={leg.id} className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                <div className="space-y-2">
                  <Label htmlFor={`price-${leg.id}`}>Exit price ({leg.symbol})</Label>
                  <Input
                    id={`price-${leg.id}`}
                    value={legState[leg.id]?.price ?? ''}
                    onChange={(e) => setPrice(leg.id, e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`fee-${leg.id}`}>Fee ({leg.symbol})</Label>
                  <Input
                    id={`fee-${leg.id}`}
                    value={legState[leg.id]?.fee ?? '0'}
                    onChange={(e) => setFee(leg.id, e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="closedAt">Date</Label>
              <Input
                id="closedAt"
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
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
            <Button type="submit" className="cursor-pointer" disabled={closeGroup.isPending}>
              {closeGroup.isPending ? 'Closing...' : 'Close all'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
