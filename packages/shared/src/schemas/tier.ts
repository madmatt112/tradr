import { z } from 'zod';

// Wire-side validation contract for the plan-tiers feature.
//
// Per plan-tiers design.md D16 (REQ-11.4/11.6). This file holds only the
// cross-app Zod schemas and their inferred type aliases; tier derivation and
// the pinned limit values (REQ-5.1) live api-side in
// features/billing/tier-limits.constants.ts.

export const TierSchema = z.enum(['free', 'pro']);
export type Tier = z.infer<typeof TierSchema>;

// The six-lever cap catalog. `null` = unlimited (D4).
export const TierLimitsSchema = z.object({
  accounts: z.number().int().nonnegative().nullable(),
  positions: z.number().int().nonnegative().nullable(),
  lookbackMonths: z.number().int().nonnegative().nullable(),
  platformTurns: z.number().int().nonnegative().nullable(),
  images: z.number().int().nonnegative().nullable(),
  csvImports: z.number().int().nonnegative().nullable(),
});
export type TierLimits = z.infer<typeof TierLimitsSchema>;

// GET /api/billing/tier response (D16). `subscription` derives from the local
// Stripe mirror only; price fields are nullable (a mirrored Price may lack
// unit_amount/currency). `usage` is populated only when gating is on and the
// user is non-exempt.
export const TierStateSchema = z.object({
  gatingEnabled: z.boolean(),
  exempt: z.boolean(),
  tier: TierSchema,
  purchasable: z.boolean(),
  subscription: z
    .object({
      status: z.string(),
      currentPeriodEnd: z.string().datetime(),
      cancelAtPeriodEnd: z.boolean(),
      pastDue: z.boolean(),
      priceUnitAmount: z.number().nullable(),
      priceCurrency: z.string().nullable(),
      manageable: z.boolean(),
    })
    .nullable(),
  limits: z.object({
    free: TierLimitsSchema,
    pro: TierLimitsSchema,
  }),
  usage: z
    .object({
      accounts: z.object({
        used: z.number().int().nonnegative(),
        writableAccountId: z.string().uuid().nullable(),
      }),
      positions: z.object({
        used: z.number().int().nonnegative(),
      }),
      platformTurns: z.object({
        allowanceUsed: z.number().int().nonnegative(),
      }),
      images: z.object({
        used: z.number().int().nonnegative(),
      }),
      csvImports: z.object({
        used: z.number().int().nonnegative(),
      }),
    })
    .nullable(),
});
export type TierState = z.infer<typeof TierStateSchema>;

// PUT /api/accounts/writable request body (D18).
export const SetWritableAccountSchema = z.object({
  accountId: z.string().uuid(),
});
export type SetWritableAccountInput = z.infer<typeof SetWritableAccountSchema>;
