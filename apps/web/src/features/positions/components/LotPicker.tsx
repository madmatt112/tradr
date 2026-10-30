import { holdTerm, type PositionLot } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface LotSelectionItem {
  entryFillId: string;
  quantity: string;
}

interface Props {
  lots: PositionLot[];
  jurisdiction: 'US' | 'CA' | 'other';
  /** The dialog's raw `filledAt` field value, used to compute each lot's term. */
  filledAt: string;
  /** The exit fill's quantity field value, compared against the picked sum. */
  quantity: string;
  value: LotSelectionItem[] | null;
  onChange: (value: LotSelectionItem[] | null) => void;
}

/** Sum of a lot selection's quantities; `null` (FIFO) sums to 0. */
export function sumLotSelection(value: LotSelectionItem[] | null): number {
  if (!value) return 0;
  return value.reduce((total, item) => total + (Number(item.quantity) || 0), 0);
}

/** FIFO / "Pick lots" toggle and, in pick mode, a quantity input per lot (design C11). */
export function LotPicker({ lots, jurisdiction, filledAt, quantity, value, onChange }: Props) {
  const mode = value === null ? 'fifo' : 'pick';

  const setQuantity = (entryFillId: string, raw: string) => {
    const next = (value ?? []).filter((item) => item.entryFillId !== entryFillId);
    if (raw.trim() !== '') {
      next.push({ entryFillId, quantity: raw });
    }
    onChange(next);
  };

  const picked = sumLotSelection(value);
  const target = Number(quantity) || 0;
  const difference = Math.abs(target - picked);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={mode === 'fifo' ? 'default' : 'outline'}
          size="sm"
          className="cursor-pointer"
          aria-pressed={mode === 'fifo'}
          onClick={() => onChange(null)}
        >
          FIFO
        </Button>
        <Button
          type="button"
          variant={mode === 'pick' ? 'default' : 'outline'}
          size="sm"
          className="cursor-pointer"
          aria-pressed={mode === 'pick'}
          onClick={() => onChange(value ?? [])}
        >
          Pick lots
        </Button>
      </div>

      {mode === 'pick' && (
        <div className="space-y-2">
          {lots.map((lot) => {
            const inputId = `lot-qty-${lot.entryFillId}`;
            const current =
              value?.find((item) => item.entryFillId === lot.entryFillId)?.quantity ?? '';
            return (
              <div
                key={lot.entryFillId}
                data-testid={`lot-row-${lot.entryFillId}`}
                className="flex items-center gap-2 text-sm"
              >
                <span className="w-40">{lot.filledAt}</span>
                <span className="w-20">{lot.price}</span>
                <span className="w-16">{lot.available}</span>
                {jurisdiction === 'US' && (
                  <span className="w-12">{holdTerm(lot.filledAt, filledAt)}</span>
                )}
                <Label htmlFor={inputId} className="sr-only">
                  Quantity from this lot
                </Label>
                <Input
                  id={inputId}
                  value={current}
                  onChange={(e) => setQuantity(lot.entryFillId, e.target.value)}
                  placeholder="0"
                  className="w-24"
                />
              </div>
            );
          })}
          <p data-testid="lot-picker-difference" className="text-xs text-muted-foreground">
            Picked {picked} of {target} &mdash; difference {difference}
          </p>
        </div>
      )}
    </div>
  );
}
