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

// Default-risk presets. The second line is the CONSEQUENCE of the setting
// rather than an adjective for it: ten losing trades in a row compound to
// 1 − 0.99^10 = 9.6%, 1 − 0.98^10 = 18.3% and 1 − 0.97^10 = 26.3% of the
// account. Naming the cost is the point — "conservative" is an argument, a
// drawdown is a fact.
const RISK_PRESETS = [
  { value: '1', label: '1%', note: '10 losses: -10%' },
  { value: '2', label: '2%', note: '10 losses: -18%' },
  { value: '3', label: '3%', note: '10 losses: -26%' },
] as const;

// Selected on create. NOT applied on edit: an account that stores no rule keeps
// storing none, because seeding a preset there would write a setting the user
// never chose the next time they saved anything else in this dialog.
const DEFAULT_RISK_PRESET = '2';

interface RiskOption {
  /** `undefined` is the "no rule" option — the same absence an empty field meant. */
  value: string | undefined;
  label: string;
  note: string;
}

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

  const formValues = (): CreateAccountInput => ({
    name: account?.name ?? '',
    currency: account?.currency ?? 'USD',
    brokerageId: account?.brokerageId ?? null,
    startingBalance: undefined,
    timezone: account?.timezone ?? DEFAULT_ACCOUNT_TIMEZONE,
    // The column is numeric(5,2), so the API hands back a normalised decimal
    // string ('1.5' stored comes back as '1.50'). Null means no rule is set,
    // which the form expresses as the "No rule" option.
    //
    // The 2% preset seeds CREATE only. On edit the stored value is the truth,
    // including its absence.
    defaultRiskPercent: account ? (account.defaultRiskPercent ?? undefined) : DEFAULT_RISK_PRESET,
  });

  const form = useForm<CreateAccountInput>({
    resolver: zodResolver(CreateAccountSchema),
    defaultValues: formValues(),
  });

  // `useForm` reads defaultValues once, but AccountList keeps a single dialog
  // mounted and swaps `account` to switch between create and edit — so the
  // fields must be re-seeded each time it opens, or edit shows the previous
  // occupant's values. Load-bearing for the risk rule specifically: an
  // unseeded (blank) field submits as null and would silently clear a stored
  // rule whenever the user edited anything else.
  //
  // The dependency list is deliberately narrow: it keys on the account *id*,
  // never the `account` object or `form`. A background accounts refetch hands
  // back a new object identity for the same account, so depending on either
  // would re-run the reset mid-edit and discard whatever the user had typed.
  // Widening these deps reintroduces that hazard — nothing lints it, since no
  // react-hooks plugin is registered in eslint.config.js.
  const accountId = account?.id;
  useEffect(() => {
    if (open) form.reset(formValues());
  }, [open, accountId]);

  const selectedBrokerageId = form.watch('brokerageId');
  const selectedCurrency = form.watch('currency');
  const riskValue = form.watch('defaultRiskPercent');

  // A stored rule that is not one of the presets — every value was typeable
  // before this control existed, and 3% was the old default — gets an option of
  // its own, showing the figure actually stored. Without it the group would
  // render with nothing selected and the first save would quietly replace the
  // user's setting with a preset.
  const storedRisk = account?.defaultRiskPercent ?? null;
  const customRisk =
    storedRisk && !RISK_PRESETS.some((p) => Number(p.value) === Number(storedRisk))
      ? storedRisk
      : null;
  const riskOptions: RiskOption[] = [
    ...RISK_PRESETS,
    ...(customRisk
      ? [{ value: customRisk, label: `${customRisk}%`, note: 'current setting' }]
      : []),
    // Absence stays reachable: the calculator seeds its risk percent only from
    // an account that HAS a rule, and clearing one is a documented action the
    // API models as an explicit null.
    { value: undefined, label: 'No rule', note: 'set it per calculation' },
  ];
  // Numeric comparison, because the API normalises to numeric(5,2): a stored
  // '1.00' is the 1% preset, not a fourth option.
  const isRiskSelected = (value: string | undefined) =>
    value === undefined
      ? riskValue === undefined
      : riskValue !== undefined && Number(riskValue) === Number(value);

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
      await updateAccount.mutateAsync({
        id: account!.id,
        // An emptied risk field must actually clear a rule that was set, and
        // on update only an explicit null does that — an omitted key leaves
        // the stored value untouched. The form's `undefined` therefore becomes
        // `null` here. Harmless when no rule existed: null overwrites null.
        data: { ...submitData, defaultRiskPercent: submitData.defaultRiskPercent ?? null },
      });
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
            {/* Trading-day timezone. Shown on create AND edit — unlike
                starting balance this stays editable, since it only affects
                subsequent trading-day evaluations. The option list is the
                runtime's own IANA set (shared with the server-side validator),
                so anything picked here always validates.

                The label names the boundary it governs, and the helper text
                disclaims the reporting timezone, because this dialog is one of
                only two places both zones are visible to the same user — the
                other being the settings control, which disclaims this one in
                return. */}
            <div className="space-y-2">
              <Label htmlFor="timezone">Trading-day timezone</Label>
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
                re-entered the same day. It is not your reporting timezone, which buckets your
                P&amp;L and is set in settings.
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
            {/* Default risk percentage. Shown on create AND edit — unlike
                starting balance it rewrites no history, it only seeds the
                position-size calculator.

                `#defaultRiskPercent` is the walkthrough's anchor for this
                field (features/onboarding/lib/steps/account.ts targets it by
                id), so it stays on the group now that the input is gone. */}
            <div className="space-y-2">
              <Label id="defaultRiskPercentLabel">Default risk %</Label>
              <div
                id="defaultRiskPercent"
                role="group"
                aria-labelledby="defaultRiskPercentLabel"
                className="flex flex-wrap gap-2"
              >
                {riskOptions.map((option) => {
                  const selected = isRiskSelected(option.value);
                  return (
                    <Button
                      key={option.value ?? NONE_SENTINEL}
                      type="button"
                      variant={selected ? 'default' : 'outline'}
                      aria-pressed={selected}
                      className="h-auto flex-col gap-0.5 px-3 py-2 cursor-pointer"
                      onClick={() =>
                        form.setValue('defaultRiskPercent', option.value, { shouldValidate: true })
                      }
                    >
                      <span>{option.label}</span>
                      <span className="text-xs font-normal opacity-80">{option.note}</span>
                    </Button>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">
                The share of this account&apos;s balance you risk on a single trade — it prefills
                the position-size calculator, and you can override it on any one calculation. The
                second figure is what ten losing trades in a row would cost.
              </p>
              {form.formState.errors.defaultRiskPercent && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.defaultRiskPercent.message}
                </p>
              )}
            </div>
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
              {/* `data-tour` is the walkthrough's anchor and nothing else —
                  the tour steps are data in features/onboarding/lib/steps and
                  must not have to match on markup structure to find this
                  button. */}
              <Button
                type="submit"
                data-tour="account-submit"
                className="cursor-pointer"
                disabled={isPending}
              >
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
