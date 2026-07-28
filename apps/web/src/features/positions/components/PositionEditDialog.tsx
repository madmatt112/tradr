import { useEffect, useState } from 'react';

import { parseOccSymbol, type PositionDetail, type UpdatePositionInput } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { useUpdatePosition } from '../hooks/usePosition';
import {
  decodeContract,
  encodeContract,
  occErrorField,
  type OptionContractInputs,
} from '../utils/occForm';

import { OptionContractFields } from './OptionContractFields';

const EMPTY_CONTRACT: OptionContractInputs = {
  underlying: '',
  expiry: '',
  type: 'call',
  strike: '',
};

type ContractErrors = Partial<Record<'underlying' | 'expiry' | 'strike' | 'form', string>>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: PositionDetail;
}

/**
 * Edit dialog for a position. The edit surface is decided when the dialog opens,
 * via the `decodeContract` (i.e. `parseOccSymbol`) predicate:
 *
 * - DRAFT OPTION whose symbol parses as OCC → structured `OptionContractFields`
 *   prefilled with normalised values + Notes; save re-encodes and PUTs
 *   `{ symbol, assetType:'option', notes }` (Req 3.2).
 * - DRAFT OPTION with a legacy non-OCC symbol → an inline raw Symbol `Input`
 *   (not `OptionContractFields`) + Notes; an unchanged-symbol save omits `symbol`
 *   AND `assetType` (PUT `{ notes }`), a changed symbol must `parseOccSymbol` or
 *   block, then PUTs `{ symbol, assetType:'option', notes }` (Req 3.4).
 * - Everything else (draft stock / any open / any closed) → notes only (Req 7.2).
 *
 * Asset type is fixed in every branch (Req 3.3). Reuses `useUpdatePosition` — no
 * API change.
 */
export function PositionEditDialog({ open, onOpenChange, position }: Props) {
  const updatePosition = useUpdatePosition(position.id);

  const isDraftOption = position.status === 'draft' && position.assetType === 'option';
  const decoded = isDraftOption ? decodeContract(position.symbol) : null;
  const mode: 'structured' | 'legacy' | 'notes' = !isDraftOption
    ? 'notes'
    : decoded
      ? 'structured'
      : 'legacy';

  const [notes, setNotes] = useState(position.notes ?? '');
  const [contract, setContract] = useState<OptionContractInputs>(decoded ?? EMPTY_CONTRACT);
  const [rawSymbol, setRawSymbol] = useState(position.symbol);
  const [targetPrice, setTargetPrice] = useState(
    position.targetPrice != null ? String(position.targetPrice) : '',
  );
  const [stopLoss, setStopLoss] = useState(
    position.stopLoss != null ? String(position.stopLoss) : '',
  );
  const [contractErrors, setContractErrors] = useState<ContractErrors>({});
  const [symbolError, setSymbolError] = useState<string | null>(null);

  // Re-seed the editable state each time the dialog (re)opens, so a cancelled edit
  // doesn't leak into the next open and the prefill reflects the latest data. The
  // branch + prefill are thus decided at open time. Deps are intentionally just
  // `open` — re-seeding on every `position` change would wipe in-progress edits.
  useEffect(() => {
    if (!open) return;
    const next = position.status === 'draft' && position.assetType === 'option';
    setNotes(position.notes ?? '');
    setRawSymbol(position.symbol);
    setContract(next ? (decodeContract(position.symbol) ?? EMPTY_CONTRACT) : EMPTY_CONTRACT);
    setTargetPrice(position.targetPrice != null ? String(position.targetPrice) : '');
    setStopLoss(position.stopLoss != null ? String(position.stopLoss) : '');
    setContractErrors({});
    setSymbolError(null);
  }, [open]);

  const handleSave = async () => {
    // Trade-plan fields are accepted on any status (R14). Empty input clears the
    // value (null); otherwise send the trimmed decimal string for the server-side
    // schema to validate.
    const planFields: Pick<UpdatePositionInput, 'targetPrice' | 'stopLoss'> = {
      targetPrice: targetPrice.trim() === '' ? null : targetPrice.trim(),
      stopLoss: stopLoss.trim() === '' ? null : stopLoss.trim(),
    };

    if (mode === 'structured') {
      const result = encodeContract(contract);
      if (!result.ok) {
        setContractErrors({ [occErrorField(result.error.code)]: result.error.message });
        return;
      }
      const data: UpdatePositionInput = {
        ...planFields,
        symbol: result.value,
        assetType: 'option',
        notes,
      };
      await updatePosition.mutateAsync(data);
    } else if (mode === 'legacy') {
      if (rawSymbol === position.symbol) {
        // Unchanged legacy symbol: omit `symbol` AND `assetType` so the route's
        // option-symbol edge refine isn't triggered (notes-only save, Req 3.4).
        await updatePosition.mutateAsync({ ...planFields, notes });
      } else {
        const next = rawSymbol.trim().toUpperCase();
        if (!parseOccSymbol(next).ok) {
          setSymbolError('Option symbol must be a valid OCC contract (e.g. NVDA260321C120)');
          return;
        }
        const data: UpdatePositionInput = {
          ...planFields,
          symbol: next,
          assetType: 'option',
          notes,
        };
        await updatePosition.mutateAsync(data);
      }
    } else {
      await updatePosition.mutateAsync({ ...planFields, notes });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Position</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {mode === 'structured' && (
            <OptionContractFields
              value={contract}
              onChange={(next) => {
                setContract(next);
                setContractErrors({});
              }}
              errors={contractErrors}
            />
          )}

          {mode === 'legacy' && (
            <div className="space-y-2">
              <Label htmlFor="edit-symbol">Symbol</Label>
              <Input
                id="edit-symbol"
                type="text"
                autoComplete="off"
                value={rawSymbol}
                onChange={(e) => {
                  setRawSymbol(e.target.value);
                  setSymbolError(null);
                }}
                aria-invalid={symbolError ? true : undefined}
                aria-describedby={symbolError ? 'edit-symbol-error' : undefined}
              />
              {symbolError && (
                <p id="edit-symbol-error" className="text-sm text-destructive">
                  {symbolError}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="edit-target-price">Target Price</Label>
            <Input
              id="edit-target-price"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-stop-loss">Stop Loss</Label>
            <Input
              id="edit-stop-loss"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={stopLoss}
              onChange={(e) => setStopLoss(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-notes">Notes</Label>
            <Textarea id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              onClick={handleSave}
              disabled={updatePosition.isPending}
            >
              {updatePosition.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
