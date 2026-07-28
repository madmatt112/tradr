import { z } from 'zod';

import { ProviderIdSchema } from './advisor';

// Wire-side validation contract for the wallet-billing feature.
//
// Per design.md §Component 11 (REQ-11.2). This file holds only the cross-app
// Zod schemas and their inferred type aliases; pure pricing/business logic
// (RATE_TABLE, priceTurnUsage, CREDIT_PACKS) lives api-side.
//
// Credit amounts are an abstract integer unit (1 credit = 1 micro-USD), modeled
// as a bigint-bearing numeric string — never a float, never displayCurrency.

// Non-negative integer credit amount as a decimal string (bigint micro-USD).
// String-typed so JSON cannot silently coerce to a lossy IEEE-754 float.
const creditUnits = z.string().regex(/^\d+$/, { message: 'Must be a non-negative integer string' });

// Signed integer credit amount as a decimal string (debits/reversals are negative).
const signedCreditUnits = z.string().regex(/^-?\d+$/, { message: 'Must be an integer string' });

export const WalletBalanceSchema = z.object({
  balance: creditUnits,
  available: creditUnits,
});
export type WalletBalance = z.infer<typeof WalletBalanceSchema>;

export const CreditPackSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().min(1),
  credits: creditUnits,
});
export type CreditPack = z.infer<typeof CreditPackSchema>;

export const UsageRecordSchema = z.object({
  providerId: ProviderIdSchema,
  model: z.string().min(1),
  inputTokens: creditUnits,
  outputTokens: creditUnits,
  creditCost: creditUnits,
  createdAt: z.string(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const WalletHistoryItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['credit', 'debit', 'reversal']),
  amount: signedCreditUnits,
  balanceAfter: signedCreditUnits,
  createdAt: z.string(),
  usage: UsageRecordSchema.nullable().optional(),
});
export type WalletHistoryItem = z.infer<typeof WalletHistoryItemSchema>;

// A platform-priced provider/model entry driving the web model picker.
// `allowance` marks the provider's free-tier allowance model (REQ-8.9a);
// emitted only when feature gating is enabled — absent means not the
// allowance model.
export const BillingModelSchema = z.object({
  providerId: ProviderIdSchema,
  model: z.string().min(1),
  allowance: z.boolean().optional(),
});
export type BillingModel = z.infer<typeof BillingModelSchema>;

// `subscription` is optional so pre-plan-tiers responses still parse;
// consumers treat absent as not purchasable (REQ-2.7).
export const BillingConfigSchema = z.object({
  enabled: z.boolean(),
  packs: z.array(CreditPackSchema),
  models: z.array(BillingModelSchema),
  subscription: z.object({ purchasable: z.boolean() }).optional(),
});
export type BillingConfig = z.infer<typeof BillingConfigSchema>;

export const CheckoutRequestSchema = z.object({
  packId: z.string().min(1),
});
export type CheckoutRequestInput = z.infer<typeof CheckoutRequestSchema>;
