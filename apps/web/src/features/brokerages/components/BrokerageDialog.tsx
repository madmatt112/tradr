import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { type Brokerage, FeeScheduleSchema } from '@tradr/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import {
  useCreateBrokerage,
  useUpdateBrokerage,
  useDuplicateBrokerage,
  useBrokeragePositionCount,
} from '../hooks/useBrokerages';

import { FeeScheduleFields } from './FeeScheduleFields';

const BrokerageFormSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  notes: z.string().max(10000).nullable().optional(),
  feeSchedule: FeeScheduleSchema,
});

type BrokerageFormValues = z.infer<typeof BrokerageFormSchema>;

const DEFAULT_FEE_SCHEDULE: BrokerageFormValues['feeSchedule'] = {
  stockPerShareCommission: '0',
  stockMinPerFill: '0',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

interface BrokerageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brokerage?: Brokerage | null;
}

export function BrokerageDialog({ open, onOpenChange, brokerage }: BrokerageDialogProps) {
  const isEdit = !!brokerage;
  const isView = isEdit && brokerage.isSystem;

  const createBrokerage = useCreateBrokerage();
  const updateBrokerage = useUpdateBrokerage();
  const duplicateBrokerage = useDuplicateBrokerage();
  const positionCount = useBrokeragePositionCount(brokerage?.id);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingData, setPendingData] = useState<BrokerageFormValues | null>(null);

  const form = useForm<BrokerageFormValues>({
    resolver: zodResolver(BrokerageFormSchema),
    defaultValues: {
      name: brokerage?.name ?? '',
      notes: brokerage?.notes ?? '',
      feeSchedule: brokerage?.feeSchedule ?? DEFAULT_FEE_SCHEDULE,
    },
  });

  const isPending =
    createBrokerage.isPending || updateBrokerage.isPending || duplicateBrokerage.isPending;

  function hasFeeChanges(data: BrokerageFormValues): boolean {
    if (!brokerage) return false;
    const fs = brokerage.feeSchedule;
    const newFs = data.feeSchedule;
    return (
      fs.stockPerShareCommission !== newFs.stockPerShareCommission ||
      fs.stockMinPerFill !== newFs.stockMinPerFill ||
      fs.stockMaxPerFill !== newFs.stockMaxPerFill ||
      fs.optionsPerContractCommission !== newFs.optionsPerContractCommission ||
      fs.optionsPerContractExchangeFee !== newFs.optionsPerContractExchangeFee ||
      fs.optionsMinPerFill !== newFs.optionsMinPerFill ||
      fs.optionsMaxPerFill !== newFs.optionsMaxPerFill
    );
  }

  async function submitEdit(data: BrokerageFormValues) {
    await updateBrokerage.mutateAsync({
      id: brokerage!.id,
      data: {
        name: data.name,
        notes: data.notes,
        feeSchedule: data.feeSchedule,
      },
    });
    onOpenChange(false);
    form.reset();
  }

  const onSubmit = form.handleSubmit(async (data) => {
    if (isEdit) {
      const count = positionCount.data?.count ?? 0;
      if (brokerage.id && hasFeeChanges(data) && count > 0) {
        setPendingData(data);
        setConfirmOpen(true);
        return;
      }
      await submitEdit(data);
    } else {
      await createBrokerage.mutateAsync({ name: data.name, notes: data.notes });
      onOpenChange(false);
      form.reset();
    }
  });

  async function handleDuplicate() {
    if (!brokerage) return;
    await duplicateBrokerage.mutateAsync(brokerage.id);
    onOpenChange(false);
  }

  const title = isView ? 'View System Brokerage' : isEdit ? 'Edit Brokerage' : 'New Brokerage';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="brokerage-name">Name</Label>
              <Input
                id="brokerage-name"
                {...form.register('name')}
                placeholder="e.g., Interactive Brokers"
                disabled={isView}
              />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="brokerage-notes">Notes</Label>
              <Textarea
                id="brokerage-notes"
                {...form.register('notes')}
                placeholder="Optional notes"
                disabled={isView}
              />
            </div>

            {isEdit && <FeeScheduleFields control={form.control} disabled={isView} />}

            <div className="flex justify-end gap-2">
              {isView ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => onOpenChange(false)}
                  >
                    Close
                  </Button>
                  <Button
                    type="button"
                    className="cursor-pointer"
                    disabled={isPending}
                    onClick={handleDuplicate}
                  >
                    {duplicateBrokerage.isPending ? 'Copying...' : 'Create Editable Copy'}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" className="cursor-pointer" disabled={isPending}>
                    {isPending ? 'Saving...' : isEdit ? 'Save' : 'Create'}
                  </Button>
                </>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Fee Schedule Change</AlertDialogTitle>
            <AlertDialogDescription>
              This brokerage is referenced by {positionCount.data?.count ?? 0} position
              {(positionCount.data?.count ?? 0) === 1 ? '' : 's'}. Changing the fee schedule will
              affect fee calculations for those positions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={async () => {
                if (pendingData) {
                  await submitEdit(pendingData);
                  setPendingData(null);
                }
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
