import { z } from 'zod';

import { CURRENCY_CODES, getCurrencyMinorUnits } from '../constants/currencies';

// The trading-rule contract (design C1, Data Models). One place defines the rule
// types, weights, parameter shapes, wire shapes and their types, shared by the
// API, the web, the archive and every test (Requirement 1.1). This file is SHAPE
// ONLY: it carries no API, DB or web code, and edits no existing schema. The pure
// `describeRule`/`canonicalDefinition` helpers live in `../lib/trading-rules`.

// The thirteen rule types (Requirement 2.2), in the order the design lists them.
export const TRADING_RULE_TYPES = [
  'max_risk_percent',
  'max_risk_amount',
  'max_position_size',
  'min_risk_reward',
  'max_daily_loss',
  'max_weekly_loss',
  'max_total_exposure',
  'required_fields',
  'allowed_markets',
  'allowed_directions',
  'no_trading_days',
  'max_trades_per_day',
  'cooldown_after_loss',
] as const;

export const TradingRuleTypeSchema = z.enum(TRADING_RULE_TYPES);

// The three weight classes and their numeric values (Requirement 4.1).
export const RULE_WEIGHTS = ['critical', 'important', 'nice_to_have'] as const;

export const RULE_WEIGHT_VALUES = { critical: 3, important: 2, nice_to_have: 1 } as const;

export const RuleWeightSchema = z.enum(RULE_WEIGHTS);

// A user holds at most this many rules; each read scores every enabled rule, so
// an unbounded set is an unbounded read (Requirement 1.5, D13).
export const TRADING_RULE_LIMIT = 50;

// The allowed set members for the list-parameter types, in canonical order.
export const REQUIRED_FIELD_VALUES = ['stop_loss', 'target_price', 'notes', 'tag'] as const;
export const MARKET_VALUES = ['stock', 'option'] as const;
export const DIRECTION_VALUES = ['long', 'short'] as const;

// `PercentString`/`RatioString`: a decimal with at most two fraction digits,
// above 0 and at most 100 (Data Models, D17). The bound comparison is exact for
// two-decimal values in this range (0 and 100 are integers).
const PERCENT_RATIO_RE = /^\d{1,3}(\.\d{1,2})?$/;

function percentRatioSchema(label: string) {
  return z
    .string()
    .regex(PERCENT_RATIO_RE, {
      message: `${label} must be a decimal with at most two fraction digits`,
    })
    .refine((v) => Number(v) > 0 && Number(v) <= 100, {
      message: `${label} must be above 0 and at most 100`,
    });
}

const PercentString = percentRatioSchema('Percent');
const RatioString = percentRatioSchema('Ratio');

// `AmountString`: a positive decimal with at most 14 integer and 4 fraction
// digits. The currency's minor-unit cap on fraction digits is checked in the
// definition-level `.superRefine` (Requirement 2.3), where the currency is known.
const AMOUNT_RE = /^\d{1,14}(\.\d{1,4})?$/;

const AmountString = z
  .string()
  .regex(AMOUNT_RE, {
    message: 'Amount must be a decimal with at most 14 integer and 4 fraction digits',
  })
  .refine((v) => Number(v) > 0, { message: 'Amount must be above 0' });

const CurrencyCode = z.enum(CURRENCY_CODES as [string, ...string[]]);

// A non-empty, duplicate-free subset of `values`. Order is normalised by
// `canonicalDefinition`, not rejected here.
function nonEmptyUniqueSet<T extends readonly [string, ...string[]]>(values: T, label: string) {
  return z
    .array(z.enum(values))
    .min(1, { message: `Select at least one ${label}` })
    .refine((arr) => new Set(arr).size === arr.length, {
      message: `${label} values must be unique`,
    });
}

// A non-empty, duplicate-free subset of the seven weekdays (0 = Sunday, per
// `WEEKDAY_LABELS`), never all seven.
const WeekdaySet = z
  .array(z.number().int().min(0).max(6))
  .min(1, { message: 'Select at least one weekday' })
  .refine((arr) => new Set(arr).size === arr.length, { message: 'Weekdays must be unique' })
  .refine((arr) => new Set(arr).size < 7, { message: 'Cannot select all seven weekdays' });

// The discriminated union over the thirteen types. Each arm is `.strict()` on the
// arm and its params, so an unknown key is refused. The definition nests as a
// `definition` field in every wire shape and is never intersected with sibling
// fields: a strict discriminated union cannot sit beside sibling fields in this
// zod version (D2, probed on zod 3.25.76).
export const TradingRuleDefinitionSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('max_risk_percent'),
        params: z.object({ percent: PercentString }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('max_risk_amount'),
        params: z.object({ amount: AmountString, currency: CurrencyCode }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('max_position_size'),
        params: z.object({ amount: AmountString, currency: CurrencyCode }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('min_risk_reward'),
        params: z.object({ ratio: RatioString }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('max_daily_loss'),
        params: z.object({ amount: AmountString, currency: CurrencyCode }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('max_weekly_loss'),
        params: z.object({ amount: AmountString, currency: CurrencyCode }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('max_total_exposure'),
        params: z.object({ amount: AmountString, currency: CurrencyCode }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('required_fields'),
        params: z.object({ fields: nonEmptyUniqueSet(REQUIRED_FIELD_VALUES, 'field') }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('allowed_markets'),
        params: z.object({ markets: nonEmptyUniqueSet(MARKET_VALUES, 'market') }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('allowed_directions'),
        params: z.object({ directions: nonEmptyUniqueSet(DIRECTION_VALUES, 'direction') }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('no_trading_days'),
        params: z.object({ weekdays: WeekdaySet }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('max_trades_per_day'),
        params: z.object({ count: z.number().int().min(1).max(1000) }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal('cooldown_after_loss'),
        params: z.object({ minutes: z.number().int().min(1).max(10080) }).strict(),
      })
      .strict(),
  ])
  .superRefine((definition, ctx) => {
    if ('amount' in definition.params && 'currency' in definition.params) {
      const minorUnits = getCurrencyMinorUnits(definition.params.currency);
      const fractionDigits = definition.params.amount.split('.')[1]?.length ?? 0;
      if (fractionDigits > minorUnits) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'amount'],
          message: `Amount for ${definition.params.currency} allows at most ${minorUnits} fraction digit${minorUnits === 1 ? '' : 's'}`,
        });
      }
    }
  });

// The create/edit body (design Wire shapes). Edits are full replacements (D2).
export const TradingRuleInputSchema = z.object({
  definition: TradingRuleDefinitionSchema,
  weight: RuleWeightSchema,
  enabled: z.boolean(),
  accountId: z.string().uuid().nullable(),
  tagId: z.string().uuid().nullable(),
});

// The rule shape on list and detail responses: the input plus server-owned
// fields and the generated description (D6: type and parameters only).
export const TradingRuleSchema = TradingRuleInputSchema.extend({
  id: z.string().uuid(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// One rule's outcome against one position (design Wire shapes). Entries only
// carry outcomes other than `not_applicable`.
export const COMPLIANCE_OUTCOMES = ['pass', 'breach', 'not_evaluable'] as const;
export const COMPLIANCE_UNITS = [
  'percent',
  'currency',
  'ratio',
  'count',
  'minutes',
  'list',
] as const;
export const COMPLIANCE_REASONS = [
  'no_stop_loss',
  'no_target_price',
  'no_planned_rr',
  'non_positive_balance',
] as const;
export const COMPLIANCE_STATUSES = ['compliant', 'non_compliant', 'unscored'] as const;
export const COMPLIANCE_FINALITIES = ['provisional', 'final'] as const;

export const ComplianceEntrySchema = z.object({
  ruleId: z.string().uuid(),
  type: TradingRuleTypeSchema,
  description: z.string(),
  weight: RuleWeightSchema,
  outcome: z.enum(COMPLIANCE_OUTCOMES),
  unit: z.enum(COMPLIANCE_UNITS),
  // Set when `unit` is `currency`, otherwise null.
  currency: z.string().nullable(),
  // A decimal string, or comma-joined list tokens (empty string for none); null
  // when `not_evaluable`, or on a cooldown pass with no prior loss.
  measured: z.string().nullable(),
  limit: z.string(),
  reason: z.enum(COMPLIANCE_REASONS).nullable(),
});

// A position's compliance (design Wire shapes). `finality` is null for a draft;
// `score` is null when no enabled rule passed or breached (Requirement 4.2).
export const PositionComplianceSchema = z.object({
  finality: z.enum(COMPLIANCE_FINALITIES).nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  status: z.enum(COMPLIANCE_STATUSES),
  entries: z.array(ComplianceEntrySchema),
});

export type TradingRuleType = z.infer<typeof TradingRuleTypeSchema>;
export type RuleWeight = z.infer<typeof RuleWeightSchema>;
export type TradingRuleDefinition = z.infer<typeof TradingRuleDefinitionSchema>;
export type TradingRuleInput = z.infer<typeof TradingRuleInputSchema>;
export type TradingRule = z.infer<typeof TradingRuleSchema>;
export type ComplianceEntry = z.infer<typeof ComplianceEntrySchema>;
export type PositionCompliance = z.infer<typeof PositionComplianceSchema>;
