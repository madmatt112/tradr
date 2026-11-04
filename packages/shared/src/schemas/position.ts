import { z } from 'zod';

import type { MaxLossReason } from '../lib/strategy';
import { parseOccSymbol } from '../options';

import { EffectiveLotMethodEnum, TaxJurisdictionEnum } from './expense';
import { ClassificationSchema } from './performance';
import { PositionImageSchema } from './position-image';
import { TagSchema } from './tag';
import { PositionComplianceSchema } from './trading-rule';

const sideEnum = z.enum(['long', 'short']);
const assetTypeEnum = z.enum(['stock', 'option']);
const statusEnum = z.enum(['draft', 'open', 'closed']);
const groupStatusEnum = z.enum(['open', 'closed']);
const maxLossReasonValues: [MaxLossReason, ...MaxLossReason[]] = [
  'multiple_expiries',
  'unbounded',
  'nothing_open',
];
const MaxLossReasonSchema = z.enum(maxLossReasonValues);

// A group's override is a short free-text label (design C3/Data Models),
// stored trimmed, 1 to 40 characters (AC 2.4). Exported so csv-import.ts's
// commit-time `labelOverrides` values are validated under the same rule.
export const labelOverrideSchema = z.string().trim().min(1).max(40);

// One leg of a group create (design C3). Price, quantity and fee rules match
// `CreateFillSchema` above, so a price of 0 is accepted (AC 4.5); unlike
// `CreatePositionSchema`, no OCC refine runs here — the service refuses a bad
// contract and names the leg index (AC 1.2, design D2, Error Handling 1).
const createGroupLegSchema = z
  .object({
    symbol: z.string().min(1).max(20).trim().toUpperCase(),
    side: sideEnum,
    assetType: assetTypeEnum,
    quantity: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
      message: 'Quantity must be a positive number',
    }),
    price: z.string().refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: 'Price must be a non-negative number',
    }),
    fees: z
      .string()
      .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
        message: 'Fees must be a non-negative number',
      })
      .default('0'),
  })
  .strict();

// One leg of a close-all (design C3). Price and fee rules match
// `CreateFillSchema`, so a price of 0 is accepted (AC 4.5/4.1).
const closeGroupExitSchema = z
  .object({
    positionId: z.string().uuid(),
    price: z.string().refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: 'Price must be a non-negative number',
    }),
    fees: z
      .string()
      .refine((v) => !isNaN(Number(v)) && Number(v) >= 0, {
        message: 'Fees must be a non-negative number',
      })
      .default('0'),
  })
  .strict();

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

// A specific-identification choice for one exit (design C3/C5). `quantity`
// reuses the fill schemas' positive-decimal-string rule.
export const LotSelectionItemSchema = z
  .object({
    entryFillId: z.string().uuid(),
    quantity: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
      message: 'Quantity must be a positive number',
    }),
  })
  .strict();

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
  // The stored specific-identification choice for a selected exit (design C6);
  // null for an entry or an unselected exit.
  lotSelection: z.array(LotSelectionItemSchema).nullable().optional(),
});

/**
 * The body of a successful `POST /positions/{id}/fills` — the created fill,
 * plus whether adding it closed the position.
 *
 * The flag is not decoration. An exit that balances the entered quantity closes
 * the position by itself, server-side, in the same transaction as the fill; a
 * client handed only the fill cannot tell that apart from a partial exit, and
 * would go on showing an open position whose balance has already moved. Saying
 * so in the response is what lets a caller react to the state change that
 * actually happened rather than infer one.
 */
export const CreatedFillSchema = FillSchema.extend({
  positionClosed: z.boolean(),
});

export const LotSelectionSchema = z.array(LotSelectionItemSchema).min(1);

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
  lotSelection: LotSelectionSchema.optional(),
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
  lotSelection: LotSelectionSchema.nullable().optional(),
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
  // Account IANA timezone — same role as on the detail: it defines the trading
  // day for R13's same-day reopen rule, so a list row can decide whether to
  // offer Reopen without refetching the detail.
  accountTimezone: z.string(),
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
  // Capital tied up in the unexited portion, at cost — the per-position term
  // the account-level `positionValue` sums. Includes the open portion's share
  // of entry fees, and is NEGATIVE for shorts (remaining proceeds are a
  // liability). Cost basis only; it never moves with the market.
  openCostBasis: z.number(),
  // Tags attached to this position. Optional so the shape is backward-compatible
  // and callers that do not join tags can omit it.
  tags: z.array(TagSchema).optional(),
  // Winning/losing/breakeven by rounded net P&L (R9/R10). Only closed positions
  // carry one; null for draft/open rows. Optional so callers that do not compute
  // it can omit the key.
  classification: ClassificationSchema.nullable().optional(),
});

// One leg of a group, as read (design Data Models): a list item plus the
// group it belongs to.
export const PositionGroupLegSchema = PositionListItemSchema.extend({
  groupId: z.string().uuid(),
});

// A multi-leg position group, as read (design Data Models/C6). Figures are
// sums over the legs (Requirement 2); `label`/`detectedLabel`/`labelOverride`
// and `maxLoss`/`maxLossReason` follow Requirement 3.
export const PositionGroupEntrySchema = z.object({
  kind: z.literal('group'),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  accountCurrency: z.string(),
  accountTimezone: z.string(),
  underlying: z.string(),
  label: z.string(),
  detectedLabel: z.string(),
  labelOverride: z.string().nullable(),
  status: groupStatusEnum,
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: z.array(TagSchema),
  classification: ClassificationSchema.nullable(),
  netEntry: z.number(),
  grossPnl: z.number().nullable(),
  netPnl: z.number().nullable(),
  brokerageFees: z.number(),
  openCostBasis: z.number(),
  maxLoss: z.number().nullable(),
  maxLossReason: MaxLossReasonSchema.nullable(),
  legs: z.array(PositionGroupLegSchema),
});

// One row of `GET /api/positions` (design Data Models/C6): an ungrouped item
// keeps `PositionListItemSchema`'s shape unchanged (AC 6.1); a group reads as
// `PositionGroupEntrySchema`, checked first so its `kind: 'group'` literal
// decides the branch.
export const PositionListEntrySchema = z.union([PositionGroupEntrySchema, PositionListItemSchema]);

export type PositionGroupLeg = z.infer<typeof PositionGroupLegSchema>;
export type PositionGroupEntry = z.infer<typeof PositionGroupEntrySchema>;
export type PositionListEntry = z.infer<typeof PositionListEntrySchema>;

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
  // Capital tied up in the unexited portion, at cost — the per-position term
  // the account-level `positionValue` sums. Includes the open portion's share
  // of entry fees, and is NEGATIVE for shorts (remaining proceeds are a
  // liability). Cost basis only; it never moves with the market.
  openCostBasis: z.number(),
  // Tags attached to this position. Optional so the shape is backward-compatible
  // and callers that do not join tags can omit it.
  tags: z.array(TagSchema).optional(),
  // Screenshots attached to this position, in creation order. Optional so the
  // shape stays backward-compatible and callers that do not join images omit it.
  images: z.array(PositionImageSchema).optional(),
  // Winning/losing/breakeven by rounded net P&L (R9/R10). Only closed positions
  // carry one; null for draft/open rows. Optional so callers that do not compute
  // it can omit the key.
  classification: ClassificationSchema.nullable().optional(),
  // Live rule compliance for this position (design C6). Present only when the
  // user holds at least one rule, so the web tells "no rules" from "rules exist"
  // (Requirement 6.1); absent otherwise. Optional so the shape stays
  // backward-compatible and callers that do not score can omit the key.
  compliance: PositionComplianceSchema.optional(),
  // The group this position is a leg of, if any (design C6). Optional and
  // nullable so the shape stays backward-compatible for an ungrouped position.
  groupId: z.string().uuid().nullable().optional(),
  group: PositionGroupEntrySchema.optional(),
});

// Create a multi-leg group in one write (design C3/C4, Requirement 1). Legs
// share the account and fill date; `.min(2).max(8)` bounds the leg count
// (AC 1.1).
export const CreatePositionGroupSchema = z
  .object({
    accountId: z.string().uuid(),
    filledAt: z.string().datetime(),
    labelOverride: labelOverrideSchema.nullable().optional(),
    legs: z.array(createGroupLegSchema).min(2).max(8),
  })
  .strict();

// Link existing ungrouped positions into a group, or add one to an existing
// group (design C3/C4, Requirement 1.4). `.min(2).max(8)` matches the create
// bound (AC 1.1/1.4).
export const LinkPositionsSchema = z
  .object({
    positionIds: z.array(z.string().uuid()).min(2).max(8),
    labelOverride: labelOverrideSchema.nullable().optional(),
  })
  .strict();

// Add one more leg to an existing group (design C3/C4).
export const AddGroupLegSchema = z
  .object({
    positionId: z.string().uuid(),
  })
  .strict();

// Set or clear a group's label override (design C3/C4, Requirement 3.4).
// `null` clears it, so detection takes over again.
export const SetGroupLabelSchema = z
  .object({
    labelOverride: labelOverrideSchema.nullable(),
  })
  .strict();

// Close every open leg of a group in one transaction, one exit fill per leg
// (design C3/C4, Requirement 4). `.min(1).max(8)` bounds the exit count to
// the group's leg cap.
export const CloseGroupSchema = z
  .object({
    exits: z.array(closeGroupExitSchema).min(1).max(8),
    closedAt: z.string().datetime().optional(),
  })
  .strict();

export type CreatePositionGroupInput = z.infer<typeof CreatePositionGroupSchema>;
export type LinkPositionsInput = z.infer<typeof LinkPositionsSchema>;
export type AddGroupLegInput = z.infer<typeof AddGroupLegSchema>;
export type SetGroupLabelInput = z.infer<typeof SetGroupLabelSchema>;
export type CloseGroupInput = z.infer<typeof CloseGroupSchema>;

export type CreatePositionInput = z.infer<typeof CreatePositionSchema>;
export type UpdatePositionInput = z.infer<typeof UpdatePositionSchema>;
export type ReopenPositionInput = z.infer<typeof ReopenPositionSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Fill = z.infer<typeof FillSchema>;
export type CreatedFill = z.infer<typeof CreatedFillSchema>;
export type CreateFillInput = z.infer<typeof CreateFillSchema>;
export type UpdateFillInput = z.infer<typeof UpdateFillSchema>;
// One entry lot's picker row (design C7). `available` is the lot quantity
// less every other exit's current match (D11).
export const PositionLotSchema = z
  .object({
    entryFillId: z.string().uuid(),
    filledAt: z.string(),
    price: z.string(),
    quantity: z.string(),
    available: z.string(),
  })
  .strict();

export const PositionLotsResponseSchema = z
  .object({
    method: EffectiveLotMethodEnum,
    jurisdiction: TaxJurisdictionEnum,
    lots: z.array(PositionLotSchema),
  })
  .strict();

export type PositionListItem = z.infer<typeof PositionListItemSchema>;
export type PositionDetail = z.infer<typeof PositionDetailSchema>;
export type PositionLot = z.infer<typeof PositionLotSchema>;
export type PositionLotsResponse = z.infer<typeof PositionLotsResponseSchema>;

// In-kind transfer link (design C7). Pairs an exit fill with an entry fill in
// another account so the transfer realises nothing in the CA pooled-ACB
// summary.
export const SetTransferLinkSchema = z
  .object({
    entryFillId: z.string().uuid(),
  })
  .strict();

export const TransferLinkViewSchema = z
  .object({
    id: z.string().uuid(),
    exitFillId: z.string().uuid(),
    entryFillId: z.string().uuid(),
    entryPositionId: z.string().uuid(),
    entryAccountId: z.string().uuid(),
    entryAccountName: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const TransferCandidateSchema = z
  .object({
    entryFillId: z.string().uuid(),
    positionId: z.string().uuid(),
    accountId: z.string().uuid(),
    accountName: z.string(),
    filledAt: z.string(),
    price: z.string(),
    quantity: z.string(),
  })
  .strict();

export const TransferLinkResponseSchema = z
  .object({
    link: TransferLinkViewSchema.nullable(),
    candidates: z.array(TransferCandidateSchema),
  })
  .strict();

export type SetTransferLinkInput = z.infer<typeof SetTransferLinkSchema>;
export type TransferLinkView = z.infer<typeof TransferLinkViewSchema>;
export type TransferCandidate = z.infer<typeof TransferCandidateSchema>;
export type TransferLinkResponse = z.infer<typeof TransferLinkResponseSchema>;
