import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { CreateAccountSchema, type CreateAccountInput, type Account } from '@tradr/shared';
import { DEFAULT_ACCOUNT_TIMEZONE, IANA_TIMEZONES, SUPPORTED_CURRENCIES } from '@tradr/shared';

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UpgradeLink } from '@/features/billing/UpgradeLink';
import { useTierState } from '@/features/billing/useTierState';
import { useBrokerages } from '@/features/brokerages/hooks/useBrokerages';
import { api } from '@/lib/api';

import { getAccountErrorCode, useCreateAccount, useUpdateAccount } from '../hooks/useAccounts';

const NONE_SENTINEL = '__none__';

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: Account | null;
}

export function AccountDialog({ open, onOpenChange, account }: AccountDialogProps) {
  const isEdit = !!account;
  const queryClient = useQueryClient();
  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();
  const { data: brokerages } = useBrokerages();

  const [pendingData, setPendingData] = useState<CreateAccountInput | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [positionCount, setPositionCount] = useState(0);
  // TIER_LIMIT_ACCOUNTS refusal (plan-tiers REQ-6.1/11.5) — mapped on the
  // machine-readable CODE only, rendered inline so the remedy is in place.
  const [tierRefused, setTierRefused] = useState(false);
  const { data: tierState } = useTierState();

  useEffect(() => {
    if (!open) setTierRefused(false);
  }, [open]);

  const systemBrokerages = brokerages?.filter((b) => b.isSystem) ?? [];
  const userBrokerages = brokerages?.filter((b) => !b.isSystem) ?? [];

  const form = useForm<CreateAccountInput>({
    resolver: zodResolver(CreateAccountSchema),
    defaultValues: {
      name: account?.name ?? '',
      currency: account?.currency ?? 'USD',
      brokerageId: account?.brokerageId ?? null,
      startingBalance: undefined,
      timezone: account?.timezone ?? DEFAULT_ACCOUNT_TIMEZONE,
    },
  });

  const selectedBrokerageId = form.watch('brokerageId');
  const selectedCurrency = form.watch('currency');

  // Determine the select value: real UUID or sentinel for none
  const selectValue = selectedBrokerageId ?? NONE_SENTINEL;

  // Check if selected brokerage is a system preset
  const selectedBrokerage = brokerages?.find((b) => b.id === selectedBrokerageId);
  const isSystemSelected = selectedBrokerage?.isSystem ?? false;
  const showCurrencyWarning = isSystemSelected && selectedCurrency !== 'USD';

  const submitForm = async (data: CreateAccountInput) => {
    setTierRefused(false);
    // Convert sentinel to null
    const submitData = {
      ...data,
      brokerageId: data.brokerageId === NONE_SENTINEL ? null : (data.brokerageId ?? null),
    };

    if (isEdit) {
      await updateAccount.mutateAsync({ id: account!.id, data: submitData });
      // Invalidate positions if brokerage changed
      if ((submitData.brokerageId ?? null) !== (account?.brokerageId ?? null)) {
        queryClient.invalidateQueries({ queryKey: ['positions'] });
      }
    } else {
      try {
        await createAccount.mutateAsync(submitData);
      } catch (err) {
        // Keep the dialog open on failure. The tier refusal renders inline
        // (code-mapped); every other error already toasted via the hook.
        if (getAccountErrorCode(err) === 'TIER_LIMIT_ACCOUNTS') setTierRefused(true);
        return;
      }
    }
    onOpenChange(false);
    form.reset();
  };

  const onSubmit = form.handleSubmit(async (data) => {
    // If editing and brokerage changed, check position count for confirmation
    if (isEdit && (data.brokerageId ?? null) !== (account?.brokerageId ?? null)) {
      try {
        const result = await api.get<{ count: number }>(`/accounts/${account!.id}/position-count`);
        if (result.count > 0) {
          setPositionCount(result.count);
          setPendingData(data);
          setConfirmOpen(true);
          return;
        }
      } catch {
        // If fetch fails, proceed without confirmation
      }
    }
    await submitForm(data);
  });

  const handleConfirm = async () => {
    if (pendingData) {
      await submitForm(pendingData);
      setPendingData(null);
    }
    setConfirmOpen(false);
  };

  const handleConfirmCancel = () => {
    setPendingData(null);
    setConfirmOpen(false);
  };

  const isPending = createAccount.isPending || updateAccount.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit Account' : 'New Account'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            {tierRefused && (
              <div
                data-testid="account-tier-refusal"
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3"
              >
                <span className="text-sm text-destructive">
                  You&apos;ve reached your plan&apos;s account limit.
                </span>
                {tierState?.purchasable && <UpgradeLink surface="account-dialog" />}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" {...form.register('name')} placeholder="e.g., IBKR Main" />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="currency">Currency</Label>
              <Select
                value={form.watch('currency')}
                onValueChange={(val) => form.setValue('currency', val)}
              >
                <SelectTrigger id="currency" className="cursor-pointer">
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
            </div>
            {/* Trading-day timezone (R1/R9 amendment). Shown on create AND
                edit — unlike starting balance this stays editable, since it
                only affects subsequent trading-day evaluations. The option
                list is the runtime's own IANA set (shared with the server-side
                validator), so anything picked here always validates. */}
            <div className="space-y-2">
              <Label htmlFor="timezone">Timezone</Label>
              <Select
                value={form.watch('timezone') ?? DEFAULT_ACCOUNT_TIMEZONE}
                onValueChange={(val) => form.setValue('timezone', val)}
              >
                <SelectTrigger id="timezone" className="cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IANA_TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                Defines the trading day for this account — used to decide whether a position can be
                re-entered the same day.
              </p>
              {form.formState.errors.timezone && (
                <p className="text-sm text-destructive">{form.formState.errors.timezone.message}</p>
              )}
            </div>
            {!isEdit && (
              <div className="space-y-2">
                <Label htmlFor="startingBalance">Starting balance</Label>
                <Input
                  id="startingBalance"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register('startingBalance', {
                    // Empty field means "not provided" — the schema only
                    // accepts a decimal string or undefined, never ''.
                    setValueAs: (v: unknown) =>
                      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined,
                  })}
                />
                {form.formState.errors.startingBalance && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.startingBalance.message}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="brokerage">Brokerage</Label>
              <Select
                value={selectValue}
                onValueChange={(val) => {
                  form.setValue('brokerageId', val === NONE_SENTINEL ? null : val);
                }}
              >
                <SelectTrigger id="brokerage" className="cursor-pointer">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_SENTINEL}>None</SelectItem>
                  {systemBrokerages.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>System Presets</SelectLabel>
                      {systemBrokerages.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {userBrokerages.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Your Brokerages</SelectLabel>
                      {userBrokerages.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
              {showCurrencyWarning && (
                <p className="text-sm text-warning" aria-live="polite">
                  This preset assumes USD fees — amounts may not reflect accurate currency-adjusted
                  costs.
                </p>
              )}
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
                {isPending ? 'Saving...' : isEdit ? 'Save' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change brokerage?</AlertDialogTitle>
            <AlertDialogDescription>
              This account has {positionCount} position{positionCount !== 1 ? 's' : ''}. Changing
              the brokerage will affect fee calculations for existing positions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer" onClick={handleConfirmCancel}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction className="cursor-pointer" onClick={handleConfirm}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
