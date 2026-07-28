import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { SUPPORTED_CURRENCIES } from '@tradr/shared';
import {
  CreateExchangeRateInputSchema,
  type CreateExchangeRateInput,
  type ExchangeRate,
  type PreviewRateChangeResponse,
} from '@tradr/shared/schemas/accounting';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RateChangeConfirmModal } from '@/features/accounting/components/RateChangeConfirmModal';
import {
  useCreateExchangeRate,
  useDeleteExchangeRate,
  useExchangeRates,
  usePreviewRateChange,
} from '@/features/accounting/hooks/useExchangeRates';

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ExchangeRatesPageProps {
  initialBase?: string;
  initialQuote?: string;
}

type PendingAction =
  | { kind: 'upsert'; rate: CreateExchangeRateInput }
  | { kind: 'delete'; rateId: string };

export function ExchangeRatesPage({ initialBase, initialQuote }: ExchangeRatesPageProps) {
  const { data: rates, isLoading } = useExchangeRates();
  const createRate = useCreateExchangeRate();
  const deleteRate = useDeleteExchangeRate();
  const previewRateChange = usePreviewRateChange();
  const [deleteTarget, setDeleteTarget] = useState<ExchangeRate | null>(null);
  const [pendingPreview, setPendingPreview] = useState<PreviewRateChangeResponse | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const form = useForm<CreateExchangeRateInput>({
    resolver: zodResolver(CreateExchangeRateInputSchema),
    defaultValues: {
      baseCurrency: initialBase ?? 'USD',
      quoteCurrency: initialQuote ?? 'EUR',
      rate: '',
      effectiveDate: todayUTC(),
    },
  });

  // Reflect URL-driven prefill changes (Task 22.5 deeplink scenario).
  useEffect(() => {
    if (initialBase) form.setValue('baseCurrency', initialBase);
    if (initialQuote) form.setValue('quoteCurrency', initialQuote);
  }, [initialBase, initialQuote, form]);

  const baseCurrency = form.watch('baseCurrency');
  const quoteCurrency = form.watch('quoteCurrency');

  const commitUpsert = async (data: CreateExchangeRateInput) => {
    await createRate.mutateAsync(data);
    form.reset({
      baseCurrency: data.baseCurrency,
      quoteCurrency: data.quoteCurrency,
      rate: '',
      effectiveDate: todayUTC(),
    });
  };

  const commitDelete = async (rateId: string) => {
    await deleteRate.mutateAsync(rateId);
  };

  // Run a preview before any write; only surface the modal when the change
  // exceeds the 5% threshold AND the user has a display currency materialized.
  // When displayCurrency is null (pre-first-account window or otherwise) the
  // modal would render "undefined"-as-currency money, so we short-circuit and
  // proceed immediately. The modal is symmetric across the upsert and delete
  // intents — both flow through this gate.
  const gateWrite = async (action: PendingAction) => {
    const preview = await previewRateChange.mutateAsync(
      action.kind === 'upsert'
        ? { intent: 'upsert', rate: action.rate }
        : { intent: 'delete', rateId: action.rateId },
    );
    if (preview.exceedsThreshold && preview.displayCurrency !== null) {
      setPendingPreview(preview);
      setPendingAction(action);
      return;
    }
    if (action.kind === 'upsert') {
      await commitUpsert(action.rate);
    } else {
      await commitDelete(action.rateId);
    }
  };

  const onSubmit = form.handleSubmit(async (data) => {
    await gateWrite({ kind: 'upsert', rate: data });
  });

  const prefillFromRow = (row: ExchangeRate) => {
    form.reset({
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rate: row.rate,
      effectiveDate: row.effectiveDate,
    });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    await gateWrite({ kind: 'delete', rateId: target.id });
  };

  const onConfirmModal = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingPreview(null);
    setPendingAction(null);
    if (action.kind === 'upsert') {
      await commitUpsert(action.rate);
    } else {
      await commitDelete(action.rateId);
    }
  };

  const onCancelModal = () => {
    setPendingPreview(null);
    setPendingAction(null);
  };

  const writePending = createRate.isPending || deleteRate.isPending || previewRateChange.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Exchange Rates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the rates used to convert account balances into your display currency.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 rounded-md border p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="baseCurrency">Base currency</Label>
            <Select
              value={baseCurrency}
              onValueChange={(val) => form.setValue('baseCurrency', val)}
            >
              <SelectTrigger id="baseCurrency" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_CURRENCIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.baseCurrency && (
              <p className="text-sm text-destructive">
                {form.formState.errors.baseCurrency.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="quoteCurrency">Quote currency</Label>
            <Select
              value={quoteCurrency}
              onValueChange={(val) => form.setValue('quoteCurrency', val)}
            >
              <SelectTrigger id="quoteCurrency" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_CURRENCIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.quoteCurrency && (
              <p className="text-sm text-destructive">
                {form.formState.errors.quoteCurrency.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="rate">
              Rate ({baseCurrency} → {quoteCurrency})
            </Label>
            <Input
              id="rate"
              inputMode="decimal"
              placeholder="e.g., 0.92"
              {...form.register('rate')}
            />
            {form.formState.errors.rate && (
              <p className="text-sm text-destructive">{form.formState.errors.rate.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="effectiveDate">Effective date</Label>
            <Input id="effectiveDate" type="date" {...form.register('effectiveDate')} />
            {form.formState.errors.effectiveDate && (
              <p className="text-sm text-destructive">
                {form.formState.errors.effectiveDate.message}
              </p>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Rates are stored as UTC dates. Your entered date may be one day behind your local date
          depending on your timezone.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() =>
              form.reset({
                baseCurrency: initialBase ?? 'USD',
                quoteCurrency: initialQuote ?? 'EUR',
                rate: '',
                effectiveDate: todayUTC(),
              })
            }
          >
            Reset
          </Button>
          <Button type="submit" className="cursor-pointer" disabled={writePending}>
            {writePending ? 'Saving...' : 'Save rate'}
          </Button>
        </div>
      </form>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Saved rates</h2>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !rates?.length ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No rates yet. Add one above to start converting balances.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pair</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Effective date</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => prefillFromRow(row)}
                >
                  <TableCell className="font-medium">
                    {row.baseCurrency} → {row.quoteCurrency}
                  </TableCell>
                  <TableCell>{row.rate}</TableCell>
                  <TableCell>{row.effectiveDate}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="cursor-pointer text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(row);
                      }}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete exchange rate</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  Delete the {deleteTarget.baseCurrency} → {deleteTarget.quoteCurrency} rate
                  effective {deleteTarget.effectiveDate}? This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RateChangeConfirmModal
        preview={pendingPreview}
        open={pendingPreview !== null}
        onOpenChange={(open) => {
          if (!open) onCancelModal();
        }}
        onConfirm={onConfirmModal}
        onCancel={onCancelModal}
        isPending={createRate.isPending || deleteRate.isPending}
      />
    </div>
  );
}
