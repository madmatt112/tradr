import { z } from 'zod';

import { parseOccSymbol } from '../options';

const sideEnum = z.enum(['long', 'short']);
const assetTypeEnum = z.enum(['stock', 'option']);
const statusEnum = z.enum(['draft', 'open', 'closed']);

// Option-gated OCC validation. Fires only when both `assetType` and `symbol`
// are present and the asset type is option — stock symbols keep only
// min(1).max(20), and the Update path is skipped when either field is absent
// (the service backstop is authoritative there). `symbol` is already
// trimmed/upper-cased by the field-level transforms before this runs.
function refineOptionSymbol(
  data: { symbol?: string; assetType?: 'stock' | 'option' },
  ctx: z.RefinementCtx,
) {
  if (data.assetType === 'option' && data.symbol !== undefined) {
    if (!parseOccSymbol(data.symbol).ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['symbol'],
        message: 'Option symbol must be a valid OCC contract (e.g. NVDA260321C120)',
      });
    }
  }
}

// Trade-plan price (R14): positive decimal string bounded to the
// positions.target_price / positions.stop_loss numeric(18,8) columns
// (≤10 integer digits, ≤8 fractional). Whitespace rejection via trim
// comparison mirrors `startingBalance` in schemas/account.ts — Number("  5  ")
// passes a bounds check but new Decimal("  5  ") throws server-side.
const tradePlanPrice = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    if (!/^\d{1,10}(\.\d{1,8})?$/.test(v)) return false;
    return Number(v) > 0;
  },
  { message: 'Must be a positive amount with up to 8 decimal places' },
);

export const CreatePositionSchema = z
  .object({
    accountId: z.string().uuid(),
    symbol: z.string().min(1).max(20).trim().toUpperCase(),
    side: sideEnum,
    assetType: assetTypeEnum,
    notes: z.string().max(10000).nullable().optional(),
    targetPrice: tradePlanPrice.nullable().optional(),
    stopLoss: tradePlanPrice.nullable().optional(),
  })
  .superRefine(refineOptionSymbol);

// targetPrice/stopLoss are plan annotations, not quantity-affecting, so they
// are accepted on any status alongside `notes` (R2 amendment 2026-07-17).
export const UpdatePositionSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    symbol: z.string().min(1).max(20).trim().toUpperCase().optional(),
    side: sideEnum.optional(),
    assetType: assetTypeEnum.optional(),
    notes: z.string().max(10000).nullable().optional(),
    targetPrice: tradePlanPrice.nullable().optional(),
    stopLoss: tradePlanPrice.nullable().optional(),
  })
  .superRefine(refineOptionSymbol);

export const ReopenPositionSchema = z.object({
  reopenedAt: z.string().datetime().optional(),
});

export const PositionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  symbol: z.string(),
  side: sideEnum,
  assetType: assetTypeEnum,
  status: statusEnum,
  notes: z.string().nullable(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const FillSchema = z.object({
  id: z.string().uuid(),
  positionId: z.string().uuid(),
  type: z.enum(['entry', 'exit']),
  price: z.string(),
  quantity: z.string(),
  fees: z.string(),
  notes: z.string().nullable(),
  filledAt: z.string(),
  createdAt: z.string(),
});

export const CreateFillSchema = z.object({
  type: z.enum(['entry', 'exit']),
  price: z.string().refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
    message: 'Price must be a non-negative number',
  }),
  quantity: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
    message: 'Quantity must be a positive number',
  }),
  fees: z
    .string()
    .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: 'Fees must be a non-negative number',
    })
    .default('0'),
  notes: z.string().max(10000).nullable().optional(),
  filledAt: z.string().datetime(),
});

// type is immutable — excluded from update schema
export const UpdateFillSchema = z.object({
  price: z
    .string()
    .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: 'Price must be a non-negative number',
    })
    .optional(),
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
  notes: z.string().max(10000).nullable().optional(),
  filledAt: z.string().datetime().optional(),
});

export const PositionListItemSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  symbol: z.string(),
  side: sideEnum,
  assetType: assetTypeEnum,
  status: statusEnum,
  notes: z.string().nullable(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  accountName: z.string(),
  accountCurrency: z.string(),
  realizedPnl: z.number().nullable(),
  returnPercentage: z.number().nullable(),
  avgEntryPrice: z.number().nullable(),
  avgExitPrice: z.number().nullable(),
  totalEntryQuantity: z.number(),
  totalExitQuantity: z.number(),
  brokerageName: z.string().nullable(),
  grossPnl: z.number().nullable(),
  brokerageFees: z.number(),
  netPnl: z.number().nullable(),
  targetPrice: z.number().nullable(),
  stopLoss: z.number().nullable(),
  targetRR: z.number().nullable(),
  actualRR: z.number().nullable(),
  openUnits: z.number(),
  closedUnits: z.number(),
});

export const PositionDetailSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  symbol: z.string(),
  side: sideEnum,
  assetType: assetTypeEnum,
  status: statusEnum,
  notes: z.string().nullable(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Account IANA timezone — defines the trading day for R13's same-day reopen
  // rule so the client can decide Reopen-button visibility without guessing.
  accountTimezone: z.string(),
  fills: z.array(FillSchema),
  avgEntryPrice: z.number().nullable(),
  avgExitPrice: z.number().nullable(),
  totalEntryQuantity: z.number(),
  totalExitQuantity: z.number(),
  realizedPnl: z.number().nullable(),
  returnPercentage: z.number().nullable(),
  brokerageName: z.string().nullable(),
  grossPnl: z.number().nullable(),
  brokerageFees: z.number(),
  netPnl: z.number().nullable(),
  targetPrice: z.number().nullable(),
  stopLoss: z.number().nullable(),
  targetRR: z.number().nullable(),
  actualRR: z.number().nullable(),
  openUnits: z.number(),
  closedUnits: z.number(),
});

export type CreatePositionInput = z.infer<typeof CreatePositionSchema>;
export type UpdatePositionInput = z.infer<typeof UpdatePositionSchema>;
export type ReopenPositionInput = z.infer<typeof ReopenPositionSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Fill = z.infer<typeof FillSchema>;
export type CreateFillInput = z.infer<typeof CreateFillSchema>;
export type UpdateFillInput = z.infer<typeof UpdateFillSchema>;
export type PositionListItem = z.infer<typeof PositionListItemSchema>;
export type PositionDetail = z.infer<typeof PositionDetailSchema>;
