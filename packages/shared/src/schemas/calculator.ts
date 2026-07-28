import { z } from 'zod';

import { FeeScheduleSchema } from './brokerage';

// Bounds chosen to stay within JavaScript safe-integer range for cents-scale
// arithmetic and to match the widths used elsewhere in the codebase.
export const PRICE_MAX = 9_999_999.99;
export const DOLLAR_RISK_MAX = 99_999_999.99;
export const MANUAL_FEE_MAX = 9_999_999.99;

// Matches accounts.starting_balance numeric(18,4); deliberately larger than
// DOLLAR_RISK_MAX so any account-sourced balance validates.
export const ACCOUNT_BALANCE_MAX = 99_999_999_999_999.9999;

// Whitespace rejection (via trim comparison) is critical: Number("  50  ")
// passes bounds checks but new Decimal("  50  ") throws, which would surface
// an implementation-detail error to API clients. The simple trim comparison
// is the canonical form — do not replace with regex.
const positiveDecimal = (upperBound: number) =>
  z.string().refine(
    (v) => {
      if (v !== v.trim()) return false;
      const n = Number(v);
      return !isNaN(n) && isFinite(n) && n > 0 && n <= upperBound;
    },
    { message: `Must be a positive number up to ${upperBound}` },
  );

const nonNegativeDecimal = (upperBound: number) =>
  z.string().refine(
    (v) => {
      if (v.length === 0) return false;
      if (v !== v.trim()) return false;
      const n = Number(v);
      return !isNaN(n) && isFinite(n) && n >= 0 && n <= upperBound;
    },
    { message: `Must be a non-negative number up to ${upperBound}` },
  );

// Treats a blank/whitespace-only string as absent so an empty optional field
// (e.g. a dollar-risk input left blank in percent mode) doesn't fail the inner
// validator or count as "supplied" for basis detection.
const optionalEmptyToUndefined = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner.optional());

// Sign-agnostic bounded decimal for account balances (which can be negative).
// Message is a FIXED string — do NOT interpolate maxMagnitude (the float
// literal stringifies to a rounded, misleading value).
const signedBoundedDecimal = (maxMagnitude: number) =>
  z.string().refine(
    (v) => {
      if (v !== v.trim() || v.trim() === '') return false;
      const n = Number(v);
      return !isNaN(n) && isFinite(n) && Math.abs(n) <= maxMagnitude;
    },
    { message: 'Must be a number within the account-balance range' },
  );

// Direction/stop/target consistency is NOT validated here — it lives in
// calculateTrade so both API and client call sites get identical error messages.
export const CalculatorInputSchema = z
  .object({
    entryPrice: positiveDecimal(PRICE_MAX),
    stopLoss: positiveDecimal(PRICE_MAX),
    dollarRisk: optionalEmptyToUndefined(positiveDecimal(DOLLAR_RISK_MAX)),
    balance: optionalEmptyToUndefined(signedBoundedDecimal(ACCOUNT_BALANCE_MAX)),
    riskPercent: optionalEmptyToUndefined(positiveDecimal(100)),
    direction: z.enum(['long', 'short']),
    mode: z.enum(['stock', 'options']),
    targetPrice: positiveDecimal(PRICE_MAX).optional(),
    feeSchedule: FeeScheduleSchema.optional(),
    manualFees: nonNegativeDecimal(MANUAL_FEE_MAX).optional(),
  })
  .refine((data) => !(data.feeSchedule && data.manualFees), {
    message: 'Choose either brokerage fees or manual fees, not both',
  })
  .refine(
    (d) => {
      const dollar = d.dollarRisk !== undefined;
      const percent = d.balance !== undefined && d.riskPercent !== undefined;
      return dollar !== percent;
    },
    { message: 'Provide exactly one risk basis: a dollar risk, or a balance and risk percent.' },
  );

export const CalculatorOutputSchema = z.object({
  positionSize: z.number().int().nonnegative(),
  perUnitRisk: z.string(),
  actualDollarRisk: z.string(),
  totalPositionValue: z.string(),
  perUnitReward: z.string().optional(),
  riskRewardRatio: z.string().optional(),
  estimatedFees: z.string().optional(),
  feeToRiskPercent: z.string().optional(),
  adjustedDollarRisk: z.string().optional(),
  breakeven: z.string().optional(),
  adjustedRiskRewardRatio: z.string().optional(),
  derivedDollarRisk: z.string().optional(),
  sizingStatus: z
    .enum(['nothing-to-size-against', 'exceeds-maximum', 'buying-power-zero'])
    .optional(),
  buyingPowerLimited: z.boolean().optional(),
});

export type CalculatorInput = z.infer<typeof CalculatorInputSchema>;
export type CalculatorOutput = z.infer<typeof CalculatorOutputSchema>;
