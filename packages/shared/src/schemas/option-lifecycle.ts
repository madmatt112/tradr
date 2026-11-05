import { z } from 'zod';

// The settlement outcome enum (design C3/Data Models): a short option expires
// worthless, or a long/short option settles by assignment or exercise.
export const OptionOutcomeSchema = z.enum(['worthless', 'assigned', 'exercised']);

// POST /:id/settle (design C3). Price and quantity rules match `CreateFillSchema`
// (schemas/position.ts) — no `.default()` on `fees`, so an omitted key stays
// absent rather than substituting '0', which the service tells apart from an
// explicit zero fee.
export const SettleLegInputSchema = z
  .object({
    outcome: OptionOutcomeSchema,
    settledAt: z.string().datetime().optional(),
    quantity: z
      .string()
      .refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
        message: 'Quantity must be a positive number',
      })
      .optional(),
    fees: z
      .string()
      .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
        message: 'Fees must be a non-negative number',
      })
      .optional(),
    stockRowOrder: z.array(z.string().uuid()).optional(),
  })
  .strict();

// POST /:id/roll (design C6). Price, quantity and fee rules match
// `CreateFillSchema`; `closeFees`/`openFees` are optional per the design
// interface, `rolledAt` is required.
export const RollLegInputSchema = z
  .object({
    newSymbol: z.string().min(1).max(20).trim().toUpperCase(),
    quantity: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
      message: 'Quantity must be a positive number',
    }),
    closePrice: z.string().refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: 'Price must be a non-negative number',
    }),
    openPrice: z.string().refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: 'Price must be a non-negative number',
    }),
    closeFees: z
      .string()
      .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
        message: 'Fees must be a non-negative number',
      })
      .optional(),
    openFees: z
      .string()
      .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
        message: 'Fees must be a non-negative number',
      })
      .optional(),
    rolledAt: z.string().datetime(),
  })
  .strict();

// PUT /:id/entry-greeks (design C7). A union on `source`: the Black-Scholes
// branch's numeric rules match `BlackScholesInputSchema` (schemas/options.ts)
// field-for-field (`volatility`/sigma, `spot`/S, `rate`/r, `dividendYield`/q);
// the chain branch carries no further input, since the service fetches the
// market quote itself.
const CaptureEntryGreeksBlackScholesSchema = z
  .object({
    source: z.literal('black_scholes'),
    volatility: z.number().finite().positive().max(5),
    spot: z.number().finite().positive().max(1_000_000),
    rate: z.number().finite().gte(-1).lte(1),
    dividendYield: z.number().finite().gte(0).lte(1).optional(),
  })
  .strict();

const CaptureEntryGreeksChainSchema = z
  .object({
    source: z.literal('chain'),
  })
  .strict();

export const CaptureEntryGreeksInputSchema = z.union([
  CaptureEntryGreeksBlackScholesSchema,
  CaptureEntryGreeksChainSchema,
]);

// Result and response shapes (design Data Models, "Result and response
// shapes"). `outcome` is `OptionOutcomeSchema` throughout.

export const SettlementResultSchema = z.object({
  settlementId: z.string().uuid(),
  legId: z.string().uuid(),
  outcome: OptionOutcomeSchema,
  premium: z.number(),
  quantity: z.number(),
  settledAt: z.string(),
  openedPositionIds: z.array(z.string().uuid()),
  exitedPositionIds: z.array(z.string().uuid()),
});

export const RollResultSchema = z.object({
  rollId: z.string().uuid(),
  chainId: z.string().uuid(),
  fromPositionId: z.string().uuid(),
  toPositionId: z.string().uuid(),
  newSymbol: z.string(),
});

const SettlementContextHeldRowSchema = z.object({
  positionId: z.string().uuid(),
  symbol: z.string(),
  openUnits: z.number(),
  openedAt: z.string().nullable(),
});

// GET /:id/settlement-context (design C8).
export const SettlementContextSchema = z.object({
  legalOutcomes: z.array(OptionOutcomeSchema),
  expiryInstant: z.string(),
  premium: z.number(),
  heldRows: z.array(SettlementContextHeldRowSchema),
  suggestedOutcome: OptionOutcomeSchema.nullable(),
});

const RollChainLegSchema = z.object({
  positionId: z.string().uuid(),
  symbol: z.string(),
  rolledAt: z.string(),
});

// `detail.rollChain` (design Data Models), in edge order.
export const RollChainSchema = z.object({
  legs: z.array(RollChainLegSchema),
  netCredit: z.number(),
});

// `detail.settlements[]` (design Data Models): one row per settlement record
// touching this position.
export const PositionSettlementDetailSchema = z.object({
  settlementId: z.string().uuid(),
  outcome: OptionOutcomeSchema,
  premium: z.number(),
  quantity: z.number(),
  settledAt: z.string(),
  createdAt: z.string(),
  role: z.enum(['leg', 'stock_exit', 'stock_opened']),
  legPositionId: z.string().uuid(),
  stockPositionIds: z.array(z.string().uuid()),
});

// `detail.entryGreeks` (design Data Models): camelCase of the
// `position_entry_greeks` columns; `rhoPerPct` is nullable, as is every
// Black-Scholes input field on a chain-sourced row.
export const EntryGreeksDetailSchema = z.object({
  delta: z.number(),
  gamma: z.number(),
  thetaPerDay: z.number(),
  vegaPerPct: z.number(),
  rhoPerPct: z.number().nullable(),
  source: z.enum(['black_scholes', 'chain']),
  volatility: z.number().nullable(),
  spot: z.number().nullable(),
  rate: z.number().nullable(),
  dividendYield: z.number().nullable(),
  capturedAt: z.string(),
});

export type OptionOutcome = z.infer<typeof OptionOutcomeSchema>;
export type SettleLegInput = z.infer<typeof SettleLegInputSchema>;
export type RollLegInput = z.infer<typeof RollLegInputSchema>;
export type CaptureEntryGreeksInput = z.infer<typeof CaptureEntryGreeksInputSchema>;
export type SettlementResult = z.infer<typeof SettlementResultSchema>;
export type RollResult = z.infer<typeof RollResultSchema>;
export type SettlementContext = z.infer<typeof SettlementContextSchema>;
export type RollChain = z.infer<typeof RollChainSchema>;
export type PositionSettlementDetail = z.infer<typeof PositionSettlementDetailSchema>;
export type EntryGreeksDetail = z.infer<typeof EntryGreeksDetailSchema>;
