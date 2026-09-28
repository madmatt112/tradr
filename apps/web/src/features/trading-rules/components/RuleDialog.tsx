import { useEffect, useState } from 'react';

import {
  RULE_WEIGHTS,
  SUPPORTED_CURRENCIES,
  TRADING_RULE_LIMIT,
  TradingRuleInputSchema,
  type RuleWeight,
  type TradingRule,
  type TradingRuleDefinition,
  type TradingRuleInput,
  type TradingRuleType,
} from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { useTags } from '@/features/tags/hooks/useTags';

import {
  getTradingRuleErrorCode,
  useCreateTradingRule,
  useUpdateTradingRule,
} from '../hooks/useTradingRules';

// The account and tag scope selects express "no scope" with a sentinel, never
// the empty string (the tags feature's `TagPicker`/`AccountDialog` precedent).
const NONE_SENTINEL = '__none__';

// The five types whose parameters carry an amount and a currency. Their currency
// locks to a scoped account's currency (REQ-1.4).
const AMOUNT_TYPES = new Set<TradingRuleType>([
  'max_risk_amount',
  'max_position_size',
  'max_daily_loss',
  'max_weekly_loss',
  'max_total_exposure',
]);

// The type select is grouped by the three families the requirements name (risk
// and sizing, entry discipline, behaviour). This grouping is a UI concern only;
// the API stores just the flat type.
const RULE_TYPE_LABELS: Record<TradingRuleType, string> = {
  max_risk_percent: 'Max risk % of balance',
  max_risk_amount: 'Max risk amount',
  max_position_size: 'Max position size',
  min_risk_reward: 'Min reward-to-risk',
  max_daily_loss: 'Max daily loss',
  max_weekly_loss: 'Max weekly loss',
  max_total_exposure: 'Max total open exposure',
  required_fields: 'Required fields',
  allowed_markets: 'Allowed markets',
  allowed_directions: 'Allowed directions',
  no_trading_days: 'No trading on days',
  max_trades_per_day: 'Max trades per day',
  cooldown_after_loss: 'Cooldown after a loss',
};

const RULE_TYPE_CATEGORIES: { label: string; types: TradingRuleType[] }[] = [
  {
    label: 'Risk & sizing',
    types: [
      'max_risk_percent',
      'max_risk_amount',
      'max_position_size',
      'min_risk_reward',
      'max_daily_loss',
      'max_weekly_loss',
      'max_total_exposure',
    ],
  },
  {
    label: 'Entry discipline',
    types: ['required_fields', 'allowed_markets', 'allowed_directions'],
  },
  { label: 'Behaviour', types: ['no_trading_days', 'max_trades_per_day', 'cooldown_after_loss'] },
];

const WEIGHT_LABELS: Record<RuleWeight, string> = {
  critical: 'Critical',
  important: 'Important',
  nice_to_have: 'Nice to have',
};

const REQUIRED_FIELD_OPTIONS = [
  { value: 'stop_loss', label: 'A stop loss' },
  { value: 'target_price', label: 'A target price' },
  { value: 'notes', label: 'Notes' },
  { value: 'tag', label: 'At least one tag' },
] as const;

const MARKET_OPTIONS = [
  { value: 'stock', label: 'Stocks' },
  { value: 'option', label: 'Options' },
] as const;

const DIRECTION_OPTIONS = [
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
] as const;

// 0 = Sunday, matching the schema's weekday numbering (WEEKDAY_LABELS).
const WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
] as const;

// Every possible parameter, one flat form shape. `buildDefinition` reads only
// the fields the chosen type needs, so stale values from another type never
// reach the wire.
interface RuleForm {
  type: TradingRuleType;
  weight: RuleWeight;
  accountId: string | null;
  tagId: string | null;
  percent: string;
  ratio: string;
  amount: string;
  currency: string;
  count: string;
  minutes: string;
  fields: string[];
  markets: string[];
  directions: string[];
  weekdays: number[];
}

const EMPTY_FORM: RuleForm = {
  type: 'max_risk_percent',
  weight: 'important',
  accountId: null,
  tagId: null,
  percent: '',
  ratio: '',
  amount: '',
  currency: 'USD',
  count: '',
  minutes: '',
  fields: [],
  markets: [],
  directions: [],
  weekdays: [],
};

function formFromRule(rule: TradingRule): RuleForm {
  const base: RuleForm = {
    ...EMPTY_FORM,
    type: rule.definition.type,
    weight: rule.weight,
    accountId: rule.accountId,
    tagId: rule.tagId,
  };
  switch (rule.definition.type) {
    case 'max_risk_percent':
      return { ...base, percent: rule.definition.params.percent };
    case 'min_risk_reward':
      return { ...base, ratio: rule.definition.params.ratio };
    case 'max_risk_amount':
    case 'max_position_size':
    case 'max_daily_loss':
    case 'max_weekly_loss':
    case 'max_total_exposure':
      return {
        ...base,
        amount: rule.definition.params.amount,
        currency: rule.definition.params.currency,
      };
    case 'required_fields':
      return { ...base, fields: [...rule.definition.params.fields] };
    case 'allowed_markets':
      return { ...base, markets: [...rule.definition.params.markets] };
    case 'allowed_directions':
      return { ...base, directions: [...rule.definition.params.directions] };
    case 'no_trading_days':
      return { ...base, weekdays: [...rule.definition.params.weekdays] };
    case 'max_trades_per_day':
      return { ...base, count: String(rule.definition.params.count) };
    case 'cooldown_after_loss':
      return { ...base, minutes: String(rule.definition.params.minutes) };
  }
}

// The web builds the shape only; the API scores it (REQ-6.4). A count or minutes
// left blank becomes 0, which the schema rejects as a field error.
function buildDefinition(form: RuleForm): TradingRuleDefinition {
  switch (form.type) {
    case 'max_risk_percent':
      return { type: form.type, params: { percent: form.percent } };
    case 'min_risk_reward':
      return { type: form.type, params: { ratio: form.ratio } };
    case 'max_risk_amount':
    case 'max_position_size':
    case 'max_daily_loss':
    case 'max_weekly_loss':
    case 'max_total_exposure':
      return { type: form.type, params: { amount: form.amount, currency: form.currency } };
    case 'required_fields':
      return {
        type: form.type,
        params: { fields: form.fields as ('stop_loss' | 'target_price' | 'notes' | 'tag')[] },
      };
    case 'allowed_markets':
      return { type: form.type, params: { markets: form.markets as ('stock' | 'option')[] } };
    case 'allowed_directions':
      return { type: form.type, params: { directions: form.directions as ('long' | 'short')[] } };
    case 'no_trading_days':
      return { type: form.type, params: { weekdays: form.weekdays } };
    case 'max_trades_per_day':
      return { type: form.type, params: { count: Number(form.count) } };
    case 'cooldown_after_loss':
      return { type: form.type, params: { minutes: Number(form.minutes) } };
  }
}

// Map a rule's failed field parses onto the input that owns them: the last path
// segment (`percent`, `amount`, `fields`, …) is the field key.
function mapFieldErrors(issues: { path: (string | number)[]; message: string }[]): {
  [key: string]: string;
} {
  const out: { [key: string]: string } = {};
  for (const issue of issues) {
    const key = String(issue.path[issue.path.length - 1] ?? 'form');
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

function inlineRefusalText(code: string): string | undefined {
  switch (code) {
    case 'TRADING_RULE_LIMIT_REACHED':
      return `You have reached the limit of ${TRADING_RULE_LIMIT} rules`;
    case 'TRADING_RULE_DUPLICATE':
      return 'You already have a rule with this type, scope, currency and values';
    default:
      return undefined;
  }
}

/**
 * Create or edit a trading rule (design C9; REQ-1.2, 1.3). A type select grouped
 * by family drives the per-type parameter inputs; an amount type's currency
 * locks to a scoped account's currency, and `max_risk_percent` prefills the
 * scoped account's default risk percent while the field is untouched. The two
 * 409 codes render inline by code; every other error toasts via the hook.
 */
export function RuleDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: TradingRule | null;
}) {
  const isEdit = !!rule;
  const { data: accounts } = useAccounts();
  const { data: tags } = useTags();
  const createRule = useCreateTradingRule();
  const updateRule = useUpdateTradingRule();

  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  // Whether the user has typed into the percent field, gating the account-default
  // prefill. A seeded edit counts as touched so the stored value is never lost.
  const [percentTouched, setPercentTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ [key: string]: string }>({});
  const [refusalCode, setRefusalCode] = useState<string | undefined>(undefined);

  // Re-seed each time the dialog (re)opens — the list keeps one dialog mounted
  // and swaps `rule` between create and edit, so an unseeded field would leak
  // the previous occupant's values. Deps are the account/rule id, never the
  // objects (a background refetch hands back new identities).
  const ruleId = rule?.id;
  useEffect(() => {
    if (!open) return;
    if (rule) {
      setForm(formFromRule(rule));
      setPercentTouched(true);
    } else {
      setForm(EMPTY_FORM);
      setPercentTouched(false);
    }
    setFieldErrors({});
    setRefusalCode(undefined);
  }, [open, ruleId]);

  const scopedAccount = accounts?.find((a) => a.id === form.accountId) ?? null;
  const isAmountType = AMOUNT_TYPES.has(form.type);
  const currencyLocked = !!scopedAccount && isAmountType;

  // Lock the currency to the scoped account for an amount type (REQ-1.4): the
  // API refuses a mismatch, so the field cannot offer one.
  useEffect(() => {
    if (!open || !isAmountType || !scopedAccount) return;
    setForm((f) =>
      f.currency === scopedAccount.currency ? f : { ...f, currency: scopedAccount.currency },
    );
  }, [open, form.accountId, form.type, scopedAccount?.currency]);

  // Prefill the percent from the scoped account's default risk percent while the
  // user has not touched the field.
  useEffect(() => {
    if (!open || form.type !== 'max_risk_percent' || percentTouched) return;
    const next = scopedAccount?.defaultRiskPercent ?? '';
    setForm((f) => (f.percent === next ? f : { ...f, percent: next }));
  }, [open, form.accountId, form.type, percentTouched, scopedAccount?.defaultRiskPercent]);

  const isPending = createRule.isPending || updateRule.isPending;

  // Capture the input value synchronously: a functional `setForm` updater runs
  // after React has cleared the synthetic event, so reading `e.currentTarget`
  // inside the updater would throw on null.
  const setParam = (field: keyof RuleForm, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
  };

  const toggleSet = (field: 'fields' | 'markets' | 'directions', value: string) => {
    setForm((f) => {
      const set = f[field];
      return {
        ...f,
        [field]: set.includes(value) ? set.filter((v) => v !== value) : [...set, value],
      };
    });
  };

  const toggleWeekday = (value: number) => {
    setForm((f) => ({
      ...f,
      weekdays: f.weekdays.includes(value)
        ? f.weekdays.filter((v) => v !== value)
        : [...f.weekdays, value],
    }));
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    setRefusalCode(undefined);

    const input: TradingRuleInput = {
      definition: buildDefinition(form),
      weight: form.weight,
      enabled: rule?.enabled ?? true,
      accountId: form.accountId,
      tagId: form.tagId,
    };
    const parsed = TradingRuleInputSchema.safeParse(input);
    if (!parsed.success) {
      setFieldErrors(mapFieldErrors(parsed.error.issues));
      return;
    }

    try {
      if (isEdit) {
        await updateRule.mutateAsync({ id: rule.id, data: parsed.data });
      } else {
        await createRule.mutateAsync(parsed.data);
      }
      onOpenChange(false);
    } catch (err) {
      setRefusalCode(getTradingRuleErrorCode(err) ?? 'UNKNOWN');
    }
  };

  const refusalText = refusalCode ? inlineRefusalText(refusalCode) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit rule' : 'New rule'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rule-type">Type</Label>
            <Select
              value={form.type}
              onValueChange={(val) => setForm((f) => ({ ...f, type: val as TradingRuleType }))}
            >
              <SelectTrigger id="rule-type" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_TYPE_CATEGORIES.map((category) => (
                  <SelectGroup key={category.label}>
                    <SelectLabel>{category.label}</SelectLabel>
                    {category.types.map((type) => (
                      <SelectItem key={type} value={type} className="cursor-pointer">
                        {RULE_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          {renderParams()}

          <div className="space-y-2">
            <Label htmlFor="rule-weight">Weight</Label>
            <Select
              value={form.weight}
              onValueChange={(val) => setForm((f) => ({ ...f, weight: val as RuleWeight }))}
            >
              <SelectTrigger id="rule-weight" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_WEIGHTS.map((weight) => (
                  <SelectItem key={weight} value={weight} className="cursor-pointer">
                    {WEIGHT_LABELS[weight]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-account">Account scope</Label>
            <Select
              value={form.accountId ?? NONE_SENTINEL}
              onValueChange={(val) =>
                setForm((f) => ({ ...f, accountId: val === NONE_SENTINEL ? null : val }))
              }
            >
              <SelectTrigger id="rule-account" className="cursor-pointer">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SENTINEL} className="cursor-pointer">
                  All accounts
                </SelectItem>
                {(accounts ?? []).map((account) => (
                  <SelectItem key={account.id} value={account.id} className="cursor-pointer">
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-tag">Tag scope</Label>
            <Select
              value={form.tagId ?? NONE_SENTINEL}
              onValueChange={(val) =>
                setForm((f) => ({ ...f, tagId: val === NONE_SENTINEL ? null : val }))
              }
            >
              <SelectTrigger id="rule-tag" className="cursor-pointer">
                <SelectValue placeholder="All tags" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SENTINEL} className="cursor-pointer">
                  All tags
                </SelectItem>
                {(tags ?? []).map((tag) => (
                  <SelectItem key={tag.id} value={tag.id} className="cursor-pointer">
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {refusalText && (
            <p className="text-sm text-destructive" data-testid="rule-refusal">
              {refusalText}
            </p>
          )}

          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  function fieldError(key: string) {
    return fieldErrors[key] ? <p className="text-sm text-destructive">{fieldErrors[key]}</p> : null;
  }

  function currencyField() {
    return (
      <div className="space-y-2">
        <Label htmlFor="rule-currency">Currency</Label>
        <Select
          value={form.currency}
          onValueChange={(val) => setForm((f) => ({ ...f, currency: val }))}
          disabled={currencyLocked}
        >
          <SelectTrigger id="rule-currency" className="cursor-pointer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_CURRENCIES.map((c) => (
              <SelectItem key={c.code} value={c.code} className="cursor-pointer">
                {c.code} — {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {currencyLocked && (
          <p className="text-sm text-muted-foreground">
            Locked to the scoped account&apos;s currency.
          </p>
        )}
        {fieldError('currency')}
      </div>
    );
  }

  function amountField() {
    return (
      <>
        <div className="space-y-2">
          <Label htmlFor="rule-amount">Amount</Label>
          <Input
            id="rule-amount"
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => setParam('amount', e.currentTarget.value)}
          />
          {fieldError('amount')}
        </div>
        {currencyField()}
      </>
    );
  }

  function setField(
    legend: string,
    options: readonly { value: string; label: string }[],
    field: 'fields' | 'markets' | 'directions',
  ) {
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium">{legend}</legend>
        <div className="flex flex-col gap-2">
          {options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={form[field].includes(option.value)}
                onCheckedChange={() => toggleSet(field, option.value)}
              />
              <span className="text-sm">{option.label}</span>
            </label>
          ))}
        </div>
        {fieldError(field)}
      </fieldset>
    );
  }

  function renderParams() {
    switch (form.type) {
      case 'max_risk_percent':
        return (
          <div className="space-y-2">
            <Label htmlFor="rule-percent">Percent of balance</Label>
            <Input
              id="rule-percent"
              inputMode="decimal"
              value={form.percent}
              onChange={(e) => {
                setPercentTouched(true);
                setParam('percent', e.currentTarget.value);
              }}
            />
            {fieldError('percent')}
          </div>
        );
      case 'min_risk_reward':
        return (
          <div className="space-y-2">
            <Label htmlFor="rule-ratio">Reward-to-risk ratio</Label>
            <Input
              id="rule-ratio"
              inputMode="decimal"
              value={form.ratio}
              onChange={(e) => setParam('ratio', e.currentTarget.value)}
            />
            {fieldError('ratio')}
          </div>
        );
      case 'max_risk_amount':
      case 'max_position_size':
      case 'max_daily_loss':
      case 'max_weekly_loss':
      case 'max_total_exposure':
        return amountField();
      case 'required_fields':
        return setField('Required fields', REQUIRED_FIELD_OPTIONS, 'fields');
      case 'allowed_markets':
        return setField('Allowed markets', MARKET_OPTIONS, 'markets');
      case 'allowed_directions':
        return setField('Allowed directions', DIRECTION_OPTIONS, 'directions');
      case 'no_trading_days':
        return (
          <fieldset className="space-y-2">
            <legend className="text-sm leading-none font-medium">No trading on</legend>
            <div className="flex flex-col gap-2">
              {WEEKDAY_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={form.weekdays.includes(option.value)}
                    onCheckedChange={() => toggleWeekday(option.value)}
                  />
                  <span className="text-sm">{option.label}</span>
                </label>
              ))}
            </div>
            {fieldError('weekdays')}
          </fieldset>
        );
      case 'max_trades_per_day':
        return (
          <div className="space-y-2">
            <Label htmlFor="rule-count">Trades per day</Label>
            <Input
              id="rule-count"
              inputMode="numeric"
              value={form.count}
              onChange={(e) => setParam('count', e.currentTarget.value)}
            />
            {fieldError('count')}
          </div>
        );
      case 'cooldown_after_loss':
        return (
          <div className="space-y-2">
            <Label htmlFor="rule-minutes">Minutes after a loss</Label>
            <Input
              id="rule-minutes"
              inputMode="numeric"
              value={form.minutes}
              onChange={(e) => setParam('minutes', e.currentTarget.value)}
            />
            {fieldError('minutes')}
          </div>
        );
    }
  }
}
