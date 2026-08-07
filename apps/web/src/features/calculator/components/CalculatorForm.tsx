import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  type Account,
  calculateTrade,
  type CalculatorInput,
  CalculatorInputSchema,
  type CalculatorOutput,
  FeeScheduleSchema,
  parseOccSymbol,
} from '@tradr/shared';

import { SymbolAutocomplete } from '@/components/SymbolAutocomplete';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { useBrokerages } from '@/features/brokerages/hooks/useBrokerages';
import { useBuyingPowerBasisQuery } from '@/features/calculator/hooks/useBuyingPowerBasis';
import { OptionsChainViewer } from '@/features/options/components/OptionsChainViewer';
import type { OptionContract } from '@/features/options/hooks/useOptionsChain';
import { useStockQuote } from '@/hooks/useStockQuote';
import { useStockQuoteConfig } from '@/hooks/useStockQuoteConfig';
import { formatMoney } from '@/lib/format';

import { CalculatorResults } from './CalculatorResults';

export type FeeMode = 'none' | 'brokerage' | 'manual';
export type RiskBasis = 'dollar' | 'percent';

// Pull-quote error copy per REQ-4.3's three caller-distinguishable codes (design
// §stock-quote.client error mapping). Unknown codes fall back to a generic note.
const QUOTE_ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'Symbol not found.',
  QUOTE_PROVIDER_UNAVAILABLE: 'Quote service is temporarily unavailable. Try again shortly.',
  QUOTE_PROVIDER_MISCONFIGURED: 'Quote service is misconfigured.',
};

/** Read the coded reason from a thrown API error envelope (`{ error: { code } }`). */
function quoteErrorMessage(err: unknown): string {
  let code: string | undefined;
  if (typeof err === 'object' && err !== null) {
    const e = err as { error?: { code?: string }; code?: string };
    code = e.error?.code ?? e.code;
  }
  return (code && QUOTE_ERROR_MESSAGES[code]) || 'Could not fetch the last price.';
}

export function CalculatorForm() {
  const form = useForm<CalculatorInput>({
    resolver: zodResolver(CalculatorInputSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      direction: 'long',
      mode: 'stock',
      entryPrice: '',
      stopLoss: '',
      dollarRisk: '',
    },
  });

  const {
    register,
    setValue,
    watch,
    clearErrors,
    formState: { errors, isValid },
  } = form;

  const [feeMode, setFeeMode] = useState<FeeMode>('none');
  const [selectedBrokerageId, setSelectedBrokerageId] = useState<string>('');
  const [riskBasis, setRiskBasis] = useState<RiskBasis>('dollar');
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  // Stock-mode symbol is UI-only local state (OD#4) — NOT a form field, so
  // CalculatorInputSchema and the calculator endpoint stay untouched (REQ-1.5).
  const [symbol, setSymbol] = useState<string>('');
  const [pulledDisclaimer, setPulledDisclaimer] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // Options-mode hand-off UI state.
  const [chainOpen, setChainOpen] = useState<boolean>(false);
  const [handedOffOcc, setHandedOffOcc] = useState<string | null>(null);
  const [manualPremiumNote, setManualPremiumNote] = useState<boolean>(false);

  const quoteConfig = useStockQuoteConfig();
  const stockQuote = useStockQuote();

  const brokeragesQuery = useBrokerages();
  const brokerages = brokeragesQuery.data ?? [];

  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];

  // Which account figure the buying-power cap sizes against. Defaults to 'cash'
  // while the preference is in flight so a slow settings fetch cannot silently
  // hand back the looser cap — the conservative value is the safe one to guess.
  const buyingPowerBasisQuery = useBuyingPowerBasisQuery();
  const capBasis = buyingPowerBasisQuery.data?.basis ?? 'cash';

  const values = watch();
  const direction = values.direction;
  const mode = values.mode;

  // Live-completeness gate (D4): recomputed from the watched values every render
  // so clearing an active-basis field closes the gate immediately — `isValid` is
  // blur-only here (the form never submits) and stays stale-`true` mid-type.
  const basisComplete =
    riskBasis === 'percent'
      ? values.balance !== undefined && values.riskPercent !== undefined
      : values.dollarRisk !== undefined;

  // The figure the buying-power CAP sizes against, derived rather than written
  // into the form. Deriving it means a preference that resolves after the user
  // has already picked an account still applies, and it cannot go stale against
  // `selectedAccount` — a `setValue` at account-select time would do neither.
  //
  // Undefined ⇒ `calculateTrade` caps against `balance`, which is the right
  // fallback for all three ways there is no cash figure to use: the 'balance'
  // preference, a hand-typed balance with no account selected, and an account
  // whose `cash` is absent (the field is optional for fixtures predating the
  // cash/position split).
  //
  // Only the cap. The risk budget stays `riskPercent × balance` either way.
  //
  // Supplied in BOTH risk bases. A direct dollar risk overshoots exactly as
  // readily as a percentage one — $1,000 of risk at a $2 stop is $25,000 of
  // stock however it was expressed — so the cap belongs wherever an account is
  // selected, not only where a balance happens to exist.
  //
  // Under the 'balance' preference this passes the account's balance rather than
  // undefined. In the percent basis that is the same figure the fallback would
  // have used, so nothing changes; in the dollar basis there is no fallback to
  // inherit, and passing it is what makes the preference mean the same thing in
  // both modes instead of silently doing nothing in one of them.
  const buyingPower = selectedAccount
    ? capBasis === 'cash'
      ? (selectedAccount.cash ?? undefined)
      : (selectedAccount.balance ?? undefined)
    : undefined;

  let result: CalculatorOutput | null = null;
  let error: string | null = null;
  if (isValid && basisComplete) {
    try {
      result = calculateTrade({ ...values, buyingPower });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Calculation error';
    }
  }

  // An account-sourced figure ⇒ the account's currency; else USD (D9). No longer
  // gated on the percent basis: the dollar basis can now source an account too,
  // and showing a CAD account's cap in dollars would misstate it.
  const currency = selectedAccount ? selectedAccount.currency : 'USD';

  const brokerageHint =
    feeMode === 'brokerage' && !values.feeSchedule
      ? 'Select a brokerage to see fee estimates'
      : undefined;

  const handleFeeModeChange = (next: string) => {
    const nextMode = next as FeeMode;
    setValue('feeSchedule', undefined, { shouldValidate: true });
    setValue('manualFees', undefined, { shouldValidate: true });
    setSelectedBrokerageId('');
    setFeeMode(nextMode);
  };

  // Mode-switch clear (REQ-5.5). ORDER IS LOAD-BEARING: clear the three
  // mode-scaled per-share inputs (entry/stop/target) FIRST with
  // shouldValidate:false, set `mode` LAST with shouldValidate:true so the
  // resolver recomputes isValid=false and closes the compute gate over the now-
  // empty required fields — so calculateTrade is never called with a blank
  // entryPrice and no raw [DecimalError] flashes — then clearErrors suppresses
  // the transient required-field messages without re-opening the gate. targetPrice
  // clears to `undefined` (not '') because its optional schema has no ''→undefined
  // preprocess and register's setValueAs does not run on setValue. Dollar-risk /
  // balance / percent / fees / direction are untouched.
  const handleModeChange = (next: string) => {
    const nextMode = next as 'stock' | 'options';
    setValue('entryPrice', '', { shouldValidate: false });
    setValue('stopLoss', '', { shouldValidate: false });
    setValue('targetPrice', undefined, { shouldValidate: false });
    setValue('mode', nextMode, { shouldValidate: true });
    clearErrors(['entryPrice', 'stopLoss', 'targetPrice']);
    setPulledDisclaimer(null);
    setQuoteError(null);
    setHandedOffOcc(null);
    setManualPremiumNote(false);
  };

  const handlePullQuote = () => {
    setQuoteError(null);
    stockQuote.mutate(symbol.trim().toUpperCase(), {
      onSuccess: (res) => {
        if (res.configured) {
          // Write the delayed last price into entry and show the disclaimer.
          setValue('entryPrice', String(res.lastPrice), { shouldValidate: true });
          setPulledDisclaimer('Last price is ~15 minutes delayed.');
        }
      },
      // Surface the distinct coded message; existing entry is left untouched.
      onError: (err) => setQuoteError(quoteErrorMessage(err)),
    });
  };

  // Option contract hand-off (REQ-6.2/6.3). ORDER IS PINNED (OD#9): set `mode`
  // via a BARE non-clearing setValue (must NOT route through handleModeChange,
  // which would wipe the premium), store the validated option_symbol, then write
  // entryPrice = the PREMIUM (contract.last_price, never the underlying spot) LAST.
  const handleContractSelected = (contract: OptionContract) => {
    setChainOpen(false);
    setValue('mode', 'options', { shouldValidate: false });
    if (contract.option_symbol) {
      const parsed = parseOccSymbol(contract.option_symbol);
      if (parsed.ok) setHandedOffOcc(contract.option_symbol);
    }
    if (contract.last_price != null) {
      setManualPremiumNote(false);
      setValue('entryPrice', String(contract.last_price), { shouldValidate: true });
    } else {
      setManualPremiumNote(true);
    }
  };

  const handleBrokerageSelect = (brokerageId: string) => {
    const brokerage = brokerages.find((b) => b.id === brokerageId);
    if (!brokerage) return;
    const parsed = FeeScheduleSchema.parse(brokerage.feeSchedule);
    setSelectedBrokerageId(brokerageId);
    setValue('feeSchedule', parsed, { shouldValidate: true });
  };

  // Seed the risk percent from the account's own rule (user-onboarding R1.2), at
  // the two points that already re-seed `balance`. READ PATH ONLY — the account
  // is never written back to from here (R1.3): a risk percent typed on one
  // calculation is that calculation's, and the stored rule is unchanged.
  //
  // Only when a rule EXISTS. An account without one deliberately leaves the field
  // exactly as it found it (R1.4) rather than clearing it the way an absent
  // `balance` clears the balance — every account predating the column has no
  // rule, so clearing would wipe a percent the user typed before picking their
  // account and change today's behaviour for every existing user.
  //
  // The value arrives numeric(5,2)-normalised ('1.50', not '1.5'). It is a
  // percent-basis field, so this is guarded by the basis at both call sites for
  // the same reason `balance` is: the schema's "exactly one risk basis" refine.
  const seedRiskPercent = (account: Account) => {
    if (account.defaultRiskPercent) {
      setValue('riskPercent', account.defaultRiskPercent, { shouldValidate: true });
    }
  };

  // The selected account SURVIVES a basis switch — it is meaningful in both now,
  // and dropping it would silently remove the cap from a user who only changed
  // how they express risk. Only the basis-scoped FIELDS are cleared, which the
  // "exactly one risk basis" refine requires.
  const handleRiskBasisChange = (next: string) => {
    const nextBasis = next as RiskBasis;
    if (nextBasis === 'percent') {
      setValue('dollarRisk', undefined, { shouldValidate: true });
      // Re-seed the balance the account carries. Without this, switching to
      // percent with an account already chosen shows a selected account and an
      // empty Balance — an incomplete form the user has to fix by re-picking
      // the account they can already see is picked.
      if (selectedAccount) {
        setValue('balance', selectedAccount.balance ?? undefined, { shouldValidate: true });
        seedRiskPercent(selectedAccount);
      }
    } else {
      setValue('balance', undefined, { shouldValidate: true });
      setValue('riskPercent', undefined, { shouldValidate: true });
    }
    setRiskBasis(nextBasis);
  };

  const handleAccountSelect = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    // The balance is a PERCENT-BASIS field. Setting it in dollar mode would put
    // a second risk basis on the form, and `CalculatorInputSchema`'s
    // "exactly one basis" refine would start rejecting the input the moment a
    // risk percent was also present. In dollar mode the account contributes only
    // the cap figure and the display currency.
    if (riskBasis === 'percent') {
      // Absent balance ⇒ not-yet-supplied → neutral incomplete state (D8, REQ-3.5).
      setValue('balance', account.balance ?? undefined, { shouldValidate: true });
      seedRiskPercent(account);
    }
    setSelectedAccount(account);
  };

  // Rendered in BOTH risk bases. In the percent basis it also supplies the
  // balance to size against; in the dollar basis it supplies only the cap figure
  // and the display currency, because a dollar risk is typed directly and a
  // `balance` set here would be a second, contradictory risk basis.
  // `data-tour` on this block and on the risk-basis tabs below are the
  // walkthrough's anchors (user-onboarding R6.7). Neither the account picker nor
  // the risk basis exposes a stable id of its own — the picker's trigger is
  // rebuilt per query state — and the steps are data, so they cannot match on
  // structure.
  const accountPicker = (
    <div className="space-y-2 pt-2" data-tour="calculator-account">
      <Label>Account</Label>
      {accountsQuery.isLoading ? (
        <Select disabled>
          <SelectTrigger className="w-full cursor-pointer">
            <SelectValue placeholder="Loading accounts…" />
          </SelectTrigger>
          <SelectContent />
        </Select>
      ) : accountsQuery.isError ? (
        <>
          <Select disabled>
            <SelectTrigger className="w-full cursor-pointer">
              <SelectValue placeholder="Failed to load accounts" />
            </SelectTrigger>
            <SelectContent />
          </Select>
          <p className="mt-1 text-sm text-destructive">Failed to load accounts</p>
        </>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No accounts configured —{' '}
          <Link to="/accounts" className="underline hover:text-foreground">
            set one up
          </Link>
        </p>
      ) : (
        <Select value={selectedAccount?.id ?? ''} onValueChange={handleAccountSelect}>
          <SelectTrigger className="w-full cursor-pointer">
            <SelectValue placeholder="Select an account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {/*
        The cap is otherwise invisible: two accounts with the same balance size
        differently depending on how much is deployed, and without this the
        smaller number has no visible cause. Shown only when a CASH figure is
        actually doing the capping — under the 'balance' preference, and for a
        hand-typed balance, the cap is the figure already on screen.

        The second clause differs by basis because the reassurance differs: in
        percent mode the worry is that the risk percentage changed too (it did
        not), and in dollar mode it is that the typed dollar risk changed (it
        did not).
      */}
      {capBasis === 'cash' && selectedAccount?.cash !== undefined && (
        <p className="text-xs text-muted-foreground" data-testid="cap-basis-note">
          Sizing capped by {formatMoney(selectedAccount.cash, selectedAccount.currency)} cash —{' '}
          {riskBasis === 'percent'
            ? 'risk stays a percent of the balance.'
            : 'your dollar risk is unchanged.'}
        </p>
      )}
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
        <div className="space-y-2">
          <Label htmlFor="direction">Direction</Label>
          <Tabs
            value={direction}
            onValueChange={(v) =>
              setValue('direction', v as 'long' | 'short', { shouldValidate: true })
            }
          >
            <TabsList>
              <TabsTrigger value="long" className="cursor-pointer">
                Long
              </TabsTrigger>
              <TabsTrigger value="short" className="cursor-pointer">
                Short
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mode">Mode</Label>
          <Tabs value={mode} onValueChange={handleModeChange}>
            <TabsList>
              <TabsTrigger value="stock" className="cursor-pointer">
                Stock
              </TabsTrigger>
              <TabsTrigger value="options" className="cursor-pointer">
                Options
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {mode === 'stock' ? (
          <div className="space-y-2">
            <Label htmlFor="symbol">Symbol</Label>
            <SymbolAutocomplete
              id="symbol"
              value={symbol}
              onChange={setSymbol}
              placeholder="AAPL"
            />
            {quoteConfig.data?.stockQuoteConfigured === true && symbol.trim() !== '' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={stockQuote.isPending}
                onClick={handlePullQuote}
              >
                {stockQuote.isPending ? 'Pulling…' : 'Pull last price'}
              </Button>
            )}
            {pulledDisclaimer && (
              <p className="text-sm text-muted-foreground">{pulledDisclaimer}</p>
            )}
            {quoteError && <p className="text-sm text-destructive">{quoteError}</p>}
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Contract</Label>
            <Dialog open={chainOpen} onOpenChange={setChainOpen}>
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={() => setChainOpen(true)}
              >
                Select from options chain
              </Button>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle>Select an options contract</DialogTitle>
                  <DialogDescription>
                    Pick a contract to use its premium as the entry price.
                  </DialogDescription>
                </DialogHeader>
                <OptionsChainViewer onSelectContract={handleContractSelected} />
              </DialogContent>
            </Dialog>
            {handedOffOcc && (
              <p className="text-sm text-muted-foreground">Selected contract: {handedOffOcc}</p>
            )}
            {manualPremiumNote && (
              <p className="text-sm text-muted-foreground">
                No last trade — enter the premium manually.
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="entryPrice">Entry price</Label>
          <Input
            id="entryPrice"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            {...register('entryPrice')}
          />
          {errors.entryPrice && (
            <p className="text-sm text-destructive">{errors.entryPrice.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="stopLoss">Stop loss</Label>
          <Input
            id="stopLoss"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            {...register('stopLoss')}
          />
          {errors.stopLoss && <p className="text-sm text-destructive">{errors.stopLoss.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="targetPrice">Target price (optional)</Label>
          <Input
            id="targetPrice"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            {...register('targetPrice', {
              setValueAs: (v) => (v === '' ? undefined : v),
            })}
          />
          {errors.targetPrice && (
            <p className="text-sm text-destructive">{errors.targetPrice.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Risk</Label>
          {/* `data-tour` sits on the BASIS CHOOSER, not on the block: the block
              also holds the balance/risk fields and the account picker, so the
              walkthrough's "Risk" step would otherwise highlight three separate
              controls and point at none of them. */}
          <Tabs data-tour="calculator-risk" value={riskBasis} onValueChange={handleRiskBasisChange}>
            <TabsList>
              <TabsTrigger value="dollar" className="cursor-pointer">
                Dollar
              </TabsTrigger>
              <TabsTrigger value="percent" className="cursor-pointer">
                Percent
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {riskBasis === 'dollar' && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="dollarRisk">Dollar risk</Label>
              <Input
                id="dollarRisk"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                {...register('dollarRisk', {
                  setValueAs: (v) => (v === '' ? undefined : v),
                })}
              />
              {errors.dollarRisk && (
                <p className="text-sm text-destructive">{errors.dollarRisk.message}</p>
              )}
            </div>
          )}

          {riskBasis === 'percent' && (
            <div className="space-y-2 pt-2">
              <div className="space-y-2">
                <Label htmlFor="balance">Balance</Label>
                <Input
                  id="balance"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...register('balance', {
                    setValueAs: (v) => (v === '' ? undefined : v),
                    // Fires only on user input, not on programmatic setValue, so
                    // selecting an account does not clear the association it sets (D8).
                    onChange: () => setSelectedAccount(null),
                  })}
                />
                {errors.balance && (
                  <p className="text-sm text-destructive">{errors.balance.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="riskPercent">Risk percent</Label>
                <Input
                  id="riskPercent"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...register('riskPercent', {
                    setValueAs: (v) => (v === '' ? undefined : v),
                  })}
                />
                {errors.riskPercent && (
                  <p className="text-sm text-destructive">{errors.riskPercent.message}</p>
                )}
              </div>
            </div>
          )}

          {accountPicker}
        </div>

        <div className="space-y-2">
          <Label>Fees</Label>
          <Tabs value={feeMode} onValueChange={handleFeeModeChange}>
            <TabsList>
              <TabsTrigger value="none" className="cursor-pointer">
                None
              </TabsTrigger>
              <TabsTrigger value="brokerage" className="cursor-pointer">
                Brokerage
              </TabsTrigger>
              <TabsTrigger value="manual" className="cursor-pointer">
                Manual
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {feeMode === 'brokerage' && (
            <div className="pt-2">
              {brokeragesQuery.isLoading ? (
                <Select disabled>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Loading brokerages…" />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              ) : brokeragesQuery.isError ? (
                <>
                  <Select disabled>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Failed to load brokerages" />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                  <p className="mt-1 text-sm text-destructive">Failed to load brokerages</p>
                </>
              ) : brokerages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No brokerages configured —{' '}
                  <Link to="/brokerages" className="underline hover:text-foreground">
                    set one up
                  </Link>
                </p>
              ) : (
                <Select value={selectedBrokerageId} onValueChange={handleBrokerageSelect}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a brokerage" />
                  </SelectTrigger>
                  <SelectContent>
                    {brokerages.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {feeMode === 'manual' && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="manualFees">Manual fees</Label>
              <Input
                id="manualFees"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                {...register('manualFees', {
                  setValueAs: (v) => (v === '' ? undefined : v),
                })}
              />
              {errors.manualFees && (
                <p className="text-sm text-destructive">{errors.manualFees.message}</p>
              )}
            </div>
          )}
        </div>
      </form>

      <CalculatorResults
        result={result}
        error={error}
        brokerageHint={brokerageHint}
        currency={currency}
        balance={values.balance}
        riskPercent={values.riskPercent}
      />
    </div>
  );
}
