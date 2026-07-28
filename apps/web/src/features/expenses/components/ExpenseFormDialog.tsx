import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { type Resolver, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { CURRENCY_CODES } from '@tradr/shared/constants/currencies';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from '@tradr/shared/constants/expense-categories';
import {
  type CreateExpenseInput,
  CreateExpenseInputSchema,
  type Expense,
  type UpdateExpenseInput,
  UpdateExpenseInputSchema,
} from '@tradr/shared/schemas/expense';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { useCreateExpense, useUpdateExpense } from '@/features/expenses/hooks/useExpenses';

type Mode = 'create' | 'edit';

interface ExpenseFormDialogProps {
  mode: Mode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialExpense?: Expense | null;
}

interface FormValues {
  category: ExpenseCategory;
  description: string;
  amount: string;
  currency: string;
  occurredAt: string;
  notes: string;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultsFromExpense(expense: Expense | null | undefined): FormValues {
  return {
    category: expense?.category ?? 'other',
    description: expense?.description ?? '',
    amount: expense?.amount ?? '',
    currency: expense?.currency ?? 'USD',
    occurredAt: expense?.occurredAt ?? todayUTC(),
    notes: expense?.notes ?? '',
  };
}

interface ApiErrorShape {
  status?: number;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, string>;
  };
}

function asApiError(err: unknown): ApiErrorShape | null {
  if (typeof err !== 'object' || err === null) return null;
  return err as ApiErrorShape;
}

export function ExpenseFormDialog({
  mode,
  open,
  onOpenChange,
  initialExpense,
}: ExpenseFormDialogProps) {
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();

  const schema = mode === 'create' ? CreateExpenseInputSchema : UpdateExpenseInputSchema;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<FormValues>,
    defaultValues: defaultsFromExpense(initialExpense ?? null),
  });

  // Reset form when the dialog opens for a new row / mode swap.
  useEffect(() => {
    if (open) {
      form.reset(defaultsFromExpense(initialExpense ?? null));
    }
  }, [open, initialExpense, form]);

  const category = form.watch('category');
  const currency = form.watch('currency');

  const isPending = createExpense.isPending || updateExpense.isPending;

  const handleApiError = (err: unknown): void => {
    const apiErr = asApiError(err);
    const status = apiErr?.status;
    const details = apiErr?.error?.details;

    // 400 with field-level details — map onto form errors.
    if (status === 400 && details && Object.keys(details).length > 0) {
      const formFieldNames: Array<keyof FormValues> = [
        'category',
        'description',
        'amount',
        'currency',
        'occurredAt',
        'notes',
      ];
      let mappedAny = false;
      for (const [path, message] of Object.entries(details)) {
        // `details` keys are dotted paths from the Zod issue; the root segment
        // is the field name. Match against known form fields and ignore the rest.
        const root = path.split('.')[0] as keyof FormValues;
        if (formFieldNames.includes(root)) {
          form.setError(root, { type: 'server', message });
          mappedAny = true;
        }
      }
      // If we recognized any field, don't toast — the inline messages communicate.
      if (mappedAny) return;
    }

    // Otherwise (500, network, 400 without details) — surface the spec-mandated
    // wording from Req 5.3 and leave the dialog open.
    toast.error("Couldn't save expense. Try again.");
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const payload = {
      category: values.category,
      description: values.description,
      amount: values.amount,
      currency: values.currency,
      occurredAt: values.occurredAt,
      notes: values.notes.trim() === '' ? null : values.notes,
    };

    try {
      if (mode === 'create') {
        await createExpense.mutateAsync(payload as CreateExpenseInput);
        toast.success('Expense added');
      } else {
        if (!initialExpense) return;
        await updateExpense.mutateAsync({
          expenseId: initialExpense.id,
          patch: payload as UpdateExpenseInput,
        });
        toast.success('Expense updated');
      }
      onOpenChange(false);
    } catch (err) {
      handleApiError(err);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add expense' : 'Edit expense'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Record a deductible expense for your tax summary.'
              : 'Update this expense entry.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="expense-category">Category</Label>
            <Select
              value={category}
              onValueChange={(val) => form.setValue('category', val as ExpenseCategory)}
            >
              <SelectTrigger id="expense-category" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.category && (
              <p className="text-sm text-destructive">{form.formState.errors.category.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="expense-description">Description</Label>
            <Input
              id="expense-description"
              placeholder="e.g., TradingView Pro subscription"
              {...form.register('description')}
            />
            {form.formState.errors.description && (
              <p className="text-sm text-destructive">
                {form.formState.errors.description.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="expense-amount">Amount</Label>
              <Input
                id="expense-amount"
                inputMode="decimal"
                placeholder="e.g., 29.99"
                {...form.register('amount')}
              />
              {form.formState.errors.amount && (
                <p className="text-sm text-destructive">{form.formState.errors.amount.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="expense-currency">Currency</Label>
              <Select value={currency} onValueChange={(val) => form.setValue('currency', val)}>
                <SelectTrigger id="expense-currency" className="cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_CODES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.formState.errors.currency && (
                <p className="text-sm text-destructive">{form.formState.errors.currency.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expense-occurredAt">Date</Label>
            <Input id="expense-occurredAt" type="date" {...form.register('occurredAt')} />
            {form.formState.errors.occurredAt && (
              <p className="text-sm text-destructive">{form.formState.errors.occurredAt.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="expense-notes">Notes (optional)</Label>
            <Textarea
              id="expense-notes"
              rows={3}
              placeholder="Additional context..."
              {...form.register('notes')}
            />
            {form.formState.errors.notes && (
              <p className="text-sm text-destructive">{form.formState.errors.notes.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" className="cursor-pointer" disabled={isPending}>
              {isPending ? 'Saving...' : mode === 'create' ? 'Add expense' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
