import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { CreateFillSchema, UpdateFillSchema, type CreateFillInput, type UpdateFillInput, type Fill } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { Textarea } from '@/components/ui/textarea';

import { useAddFill, useUpdateFill } from '../hooks/usePosition';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positionId: string;
  positionStatus: string;
  isClosedPosition?: boolean;
  fill?: Fill | null;
}

export function FillDialog({ open, onOpenChange, positionId, positionStatus, isClosedPosition, fill }: Props) {
  const isEdit = !!fill;
  const addFill = useAddFill(positionId);
  const updateFill = useUpdateFill(positionId);

  const form = useForm<CreateFillInput>({
    resolver: zodResolver(isEdit ? UpdateFillSchema : CreateFillSchema),
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
          type: 'entry',
          price: '',
          quantity: '',
          fees: '0',
          notes: null,
          filledAt: new Date().toISOString().slice(0, 16),
        },
  });

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
      await addFill.mutateAsync({ ...data, filledAt });
    }
    onOpenChange(false);
    form.reset();
  });

  const isPending = addFill.isPending || updateFill.isPending;

  // Determine available fill types
  const typeOptions = positionStatus === 'draft'
    ? [{ value: 'entry', label: 'Entry' }]
    : [{ value: 'entry', label: 'Entry' }, { value: 'exit', label: 'Exit' }];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Fill' : 'Add Fill'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {!isEdit && (
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={form.watch('type')}
                onValueChange={(val) => form.setValue('type', val as 'entry' | 'exit')}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {typeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
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
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="fees">Fees</Label>
              <Input id="fees" {...form.register('fees')} placeholder="0.00" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="filledAt">Date & Time</Label>
              <Input id="filledAt" type="datetime-local" {...form.register('filledAt')} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="fill-notes">Notes</Label>
            <Textarea id="fill-notes" {...form.register('notes')} placeholder="Optional..." />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="cursor-pointer" onClick={() => onOpenChange(false)}>
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
