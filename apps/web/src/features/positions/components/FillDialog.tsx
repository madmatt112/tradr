import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import {
  CreateFillSchema,
  UpdateFillSchema,
  type CreateFillInput,
  type UpdateFillInput,
  type Fill,
} from '@tradr/shared';

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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import { useAccountFeeSchedule } from '../hooks/useAccountFeeSchedule';
import { useAddFill, useUpdateFill } from '../hooks/usePosition';
import { QUANTITY_PRESETS, defaultFillPrice, presetQuantity } from '../utils/fillDefaults';
import { computeFillFee } from '../utils/fillFees';

// A `datetime-local` input yields "YYYY-MM-DDTHH:mm", which the API schemas'
// `.datetime()` rule rejects (it wants a full ISO instant). The form validates
// the RAW widget value, so reusing the API schema verbatim made every submit
// fail zod validation and silently no-op — `handleSubmit` never reached the
// mutation, and nothing in the dialog surfaced the filledAt error. Validate the
// widget's own format here; `onSubmit` still converts to ISO before the request,
// so the API contract is untouched.
const localDateTime = z
  .string()
  .min(1, 'Required')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time');

const FillFormSchema = CreateFillSchema.extend({ filledAt: localDateTime });
const FillEditFormSchema = UpdateFillSchema.extend({ filledAt: localDateTime.optional() });

/** The parts of a position the dialog needs to prefill and price a fill. */
export interface FillPositionContext {
  accountId: string;
  assetType: 'stock' | 'option';
  side: 'long' | 'short';
  openUnits: number;
  avgEntryPrice: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positionId: string;
  positionStatus: string;
  isClosedPosition?: boolean;
  fill?: Fill | null;
  /**
   * Pre-selects the fill type and hides the type picker. Set by the row's
   * single-purpose "+" (entry) and "−" (exit) buttons, which each mean exactly
   * one type — re-asking in the dialog would be redundant. Omitted on the
   * detail page's generic "Add Fill", which still offers the choice.
   */
  defaultType?: 'entry' | 'exit';
  /**
   * Enables the prefill, quantity presets and brokerage fee preview. Supplied
   * by the add-fill flows; omitted when correcting an existing fill, where
   * none of those apply and the recorded fee must stay editable.
   */
  position?: FillPositionContext;
}

export function FillDialog({
  open,
  onOpenChange,
  positionId,
  positionStatus,
  isClosedPosition,
  fill,
  defaultType,
  position,
}: Props) {
  const isEdit = !!fill;
  const addFill = useAddFill(positionId);
  const updateFill = useUpdateFill(positionId);
  const feeSchedule = useAccountFeeSchedule(position?.accountId);

  // Manual fees and the server's schedule-derived brokerageFees are ADDITIVE
  // (pnl.ts subtracts fill fees from realizedPnl, then netPnl subtracts
  // brokerageFees again). So when a schedule exists the dialog previews what
  // the server will charge and submits fees: '0' — writing the number here
  // would bill it twice. Turning on Override re-opens the field and does
  // stack on top of the schedule; the copy below says so.
  const feeIsCalculable = !isEdit && !!position && feeSchedule !== null;
  const [feeOverride, setFeeOverride] = useState(false);

  const form = useForm<CreateFillInput>({
    resolver: zodResolver(isEdit ? FillEditFormSchema : FillFormSchema),
    defaultValues: fill
      ? {
          type: fill.type as 'entry' | 'exit',
          price: fill.price,
          quantity: fill.quantity,
          fees: fill.fees,
          notes: fill.notes,
          filledAt: fill.filledAt ? new Date(fill.filledAt).toISOString().slice(0, 16) : '',
        }
      : {
          type: defaultType ?? 'entry',
          price: '',
          quantity: '',
          fees: '0',
          notes: null,
          filledAt: new Date().toISOString().slice(0, 16),
        },
  });

  // The dialog stays mounted across opens, so `defaultValues` (read once at
  // useForm time) would keep the type from the FIRST open — clicking "+" then
  // "−" would reuse 'entry'. Re-seed on each open instead, which is also where
  // the price prefill lands.
  useEffect(() => {
    if (!open || isEdit) return;
    const type = defaultType ?? 'entry';
    form.reset({
      type,
      price: position ? defaultFillPrice(type, position) : '',
      quantity: '',
      fees: '0',
      notes: null,
      filledAt: new Date().toISOString().slice(0, 16),
    });
    setFeeOverride(false);
    // `form` is stable across renders; re-seed only on an open transition or a
    // change of direction.
  }, [open, defaultType, isEdit, position, form]);

  const watchedType = form.watch('type');
  const watchedPrice = form.watch('price');
  const watchedQuantity = form.watch('quantity');

  // Recomputed on every keystroke so the preview tracks price and quantity.
  const previewFee =
    feeIsCalculable && feeSchedule && position
      ? computeFillFee({
          schedule: feeSchedule,
          assetType: position.assetType,
          positionSide: position.side,
          type: watchedType,
          price: watchedPrice,
          quantity: watchedQuantity,
        })
      : null;

  // Presets are fractions of currently-open size, so they only mean something
  // when reducing a position that still has something open.
  const showQuantityPresets =
    !isEdit && !!position && watchedType === 'exit' && position.openUnits > 0;

  const onSubmit = form.handleSubmit(async (data) => {
    const filledAt = new Date(data.filledAt).toISOString();
    if (isEdit) {
      const updateData: UpdateFillInput = {};
      if (data.price !== fill!.price) updateData.price = data.price;
      if (data.quantity !== fill!.quantity) updateData.quantity = data.quantity;
      if (data.fees !== fill!.fees) updateData.fees = data.fees;
      if (data.notes !== fill!.notes) updateData.notes = data.notes;
      if (filledAt !== fill!.filledAt) updateData.filledAt = filledAt;
      await updateFill.mutateAsync({ fillId: fill!.id, data: updateData });
    } else {
      // Schedule-derived fees are the server's job — submitting the previewed
      // number here would have the position count it twice.
      const fees = feeIsCalculable && !feeOverride ? '0' : data.fees;
      await addFill.mutateAsync({ ...data, fees, filledAt });
    }
    onOpenChange(false);
    form.reset();
  });

  const isPending = addFill.isPending || updateFill.isPending;

  // Determine available fill types
  const typeOptions =
    positionStatus === 'draft'
      ? [{ value: 'entry', label: 'Entry' }]
      : [
          { value: 'entry', label: 'Entry' },
          { value: 'exit', label: 'Exit' },
        ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? 'Edit Fill'
              : defaultType === 'entry'
                ? 'Add to position'
                : defaultType === 'exit'
                  ? 'Reduce position'
                  : 'Add Fill'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {!isEdit && !defaultType && (
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={form.watch('type')}
                onValueChange={(val) => form.setValue('type', val as 'entry' | 'exit')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="price">Price</Label>
              <Input id="price" {...form.register('price')} placeholder="0.00" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quantity">Quantity</Label>
              <Input
                id="quantity"
                {...form.register('quantity')}
                placeholder="0"
                disabled={isClosedPosition && isEdit}
              />
              {showQuantityPresets && position && (
                <div className="flex items-center gap-1">
                  {QUANTITY_PRESETS.map((preset) => (
                    <Button
                      key={preset.label}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="cursor-pointer"
                      onClick={() =>
                        form.setValue(
                          'quantity',
                          presetQuantity(position.openUnits, preset.fraction, position.assetType),
                          { shouldValidate: true },
                        )
                      }
                    >
                      {preset.label}
                    </Button>
                  ))}
                  <span className="ml-1 text-xs text-muted-foreground">
                    of {position.openUnits} open
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="fees">Fees</Label>
                {feeIsCalculable && (
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="fee-override"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Override
                    </Label>
                    <Switch
                      id="fee-override"
                      className="cursor-pointer"
                      checked={feeOverride}
                      onCheckedChange={setFeeOverride}
                    />
                  </div>
                )}
              </div>
              {feeIsCalculable && !feeOverride ? (
                <>
                  <Input
                    id="fees"
                    readOnly
                    tabIndex={-1}
                    className="bg-muted text-muted-foreground"
                    value={previewFee ?? ''}
                    placeholder="Enter price and quantity"
                  />
                  <p className="text-xs text-muted-foreground">
                    Calculated from the account&apos;s brokerage fee schedule.
                  </p>
                </>
              ) : (
                <>
                  <Input id="fees" {...form.register('fees')} placeholder="0.00" />
                  {feeIsCalculable && feeOverride && (
                    <p className="text-xs text-muted-foreground">
                      Added on top of the brokerage schedule, which still applies to this position.
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="filledAt">Date &amp; Time</Label>
              <Input id="filledAt" type="datetime-local" {...form.register('filledAt')} />
            </div>
          </div>

          {/* Validation errors were previously invisible, so a rejected submit
              looked like a dead button. */}
          {Object.values(form.formState.errors).length > 0 && (
            <ul className="space-y-1 text-sm text-destructive">
              {Object.entries(form.formState.errors).map(([field, error]) => (
                <li key={field}>{error?.message as string}</li>
              ))}
            </ul>
          )}

          <div className="space-y-2">
            <Label htmlFor="fill-notes">Notes</Label>
            <Textarea id="fill-notes" {...form.register('notes')} placeholder="Optional..." />
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
            <Button type="submit" className="cursor-pointer" disabled={isPending}>
              {isPending ? 'Saving...' : isEdit ? 'Save' : 'Add'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
