import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { OptionOutcome, SettleLegInput } from '@tradr/shared';

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

import { useSettleLeg, useSettlementContext } from '../hooks/useOptionLifecycle';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

const OUTCOME_LABELS: Record<OptionOutcome, string> = {
  worthless: 'Worthless',
  assigned: 'Assigned',
  exercised: 'Exercised',
};

interface Props {
  // The row menu passes a PositionListItem, the detail header a
  // PositionDetail — only the id and symbol are needed here.
  position: { id: string; symbol: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Records how an option leg ended (design C10). Callers (`PositionRowActions`,
 * `PositionDetail`) mount this only while `open`, so its settlement-context
 * query never runs behind a missing QueryClientProvider in their own tests.
 *
 * No outcome is pre-selected unless the context carries `suggestedOutcome`
 * (AC 2.2/2.3) — the suggestion is applied once, on the first context the
 * dialog sees, so a later refetch never overwrites a choice the user already
 * made.
 */
export function SettleLegDialog({ position, open, onOpenChange }: Props) {
  const { data: context } = useSettlementContext(position.id, open);
  const settleLeg = useSettleLeg(position.id);

  const [outcome, setOutcome] = useState<OptionOutcome | null>(null);
  const [date, setDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [fee, setFee] = useState('');
  const [rowOrder, setRowOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const appliedSuggestion = useRef(false);

  useEffect(() => {
    if (!context || appliedSuggestion.current) return;
    appliedSuggestion.current = true;
    setOutcome(context.suggestedOutcome);
    setRowOrder(context.heldRows.map((row) => row.positionId));
  }, [context]);

  function moveRow(index: number, direction: -1 | 1) {
    setRowOrder((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!outcome) return;
    setError(null);
    const payload: SettleLegInput = { outcome, fees: fee || '0' };
    // Worthless takes the full open quantity at the expiry instant
    // server-side (Req 2.4) — the date and quantity fields apply only to
    // assigned/exercised (Req 2.5).
    if (outcome !== 'worthless') {
      if (date) payload.settledAt = new Date(date).toISOString();
      if (quantity) payload.quantity = quantity;
    }
    if (context && context.heldRows.length >= 2) {
      payload.stockRowOrder = rowOrder;
    }
    try {
      await settleLeg.mutateAsync(payload);
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to settle leg'));
    }
  }

  const heldRowsById = new Map((context?.heldRows ?? []).map((row) => [row.positionId, row]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle>Settle {position.symbol}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              OCC automatically exercises any option in the money by $0.01 or more at its 17:30 ET
              cut-off.
            </p>
            <div className="flex gap-2">
              {(context?.legalOutcomes ?? []).map((candidate) => (
                <Button
                  key={candidate}
                  type="button"
                  variant={outcome === candidate ? 'default' : 'outline'}
                  aria-pressed={outcome === candidate}
                  className="cursor-pointer"
                  onClick={() => setOutcome(candidate)}
                >
                  {OUTCOME_LABELS[candidate]}
                </Button>
              ))}
            </div>
            {outcome && outcome !== 'worthless' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="settled-at">Date</Label>
                  <Input
                    id="settled-at"
                    type="datetime-local"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input
                    id="quantity"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="All open units"
                  />
                </div>
              </>
            )}
            {outcome && (
              <div className="space-y-2">
                <Label htmlFor="fee">Fee</Label>
                <Input
                  id="fee"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            )}
            {context && context.heldRows.length >= 2 && (
              <div data-testid="stock-row-order" className="space-y-2">
                <Label>Stock row order</Label>
                <ul className="space-y-1">
                  {rowOrder.map((positionId, index) => {
                    const row = heldRowsById.get(positionId);
                    if (!row) return null;
                    return (
                      <li key={positionId} className="flex items-center justify-between gap-2">
                        <span className="text-sm">{row.symbol}</span>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="cursor-pointer"
                            disabled={index === 0}
                            onClick={() => moveRow(index, -1)}
                          >
                            <span aria-hidden="true">↑</span>
                            <span className="sr-only">Move {row.symbol} earlier</span>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="cursor-pointer"
                            disabled={index === rowOrder.length - 1}
                            onClick={() => moveRow(index, 1)}
                          >
                            <span aria-hidden="true">↓</span>
                            <span className="sr-only">Move {row.symbol} later</span>
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
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
            <Button
              type="submit"
              className="cursor-pointer"
              disabled={!outcome || settleLeg.isPending}
            >
              {settleLeg.isPending ? 'Settling...' : 'Settle'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
