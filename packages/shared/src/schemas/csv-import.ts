import { z } from 'zod';

export const RowShapeSchema = z.enum(['execution', 'round-trip']);

export const DateFormatSchema = z.enum(['iso', 'us', 'eu', 'iso-datetime']);

export const NumberFormatSchema = z.enum(['us', 'eu']);

export const MappingSchema = z.object({
  rowShape: RowShapeSchema,
  // Tradr field -> CSV column name. Fields vary by row shape (Component 2),
  // so this is a free record validated structurally; the mapping/transform
  // layer enforces the per-shape required-field set.
  columns: z.record(z.string(), z.string()),
  // Per-field synonym overrides merged onto the canonical transform maps.
  transforms: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  delimiter: z.enum([',', ';', '\t']).optional(),
  hasHeader: z.boolean().optional(),
});

export const CsvPreviewRequestSchema = z.object({
  accountId: z.string().uuid(),
  rowShape: RowShapeSchema,
  mapping: MappingSchema,
  presetId: z.string().optional(),
  timezone: z.string(),
  dateFormat: DateFormatSchema,
  numberFormat: NumberFormatSchema,
});

export const LocatedErrorSchema = z.object({
  rowNumber: z.number().int(),
  csvColumn: z.string().optional(),
  tradrField: z.string().optional(),
  code: z.string(),
  message: z.string(),
});

export const LocatedWarningSchema = z.object({
  rowNumber: z.number().int().optional(),
  csvColumn: z.string().optional(),
  kind: z.enum([
    'partial_duplicate',
    'within_file_duplicate',
    'no_fees_column',
    'direction_inferred',
    'currency_hint_mismatch',
    'rounded',
  ]),
  message: z.string(),
});

export const ProposedFillSchema = z.object({
  type: z.enum(['entry', 'exit']),
  price: z.string(),
  quantity: z.string(),
  fees: z.string(),
  filledAt: z.string(),
  sourceRow: z.number().int(),
});

export const ProposedPositionSchema = z.object({
  scope: z.object({
    symbol: z.string(),
    assetType: z.enum(['stock', 'option']),
  }),
  side: z.enum(['long', 'short']),
  closes: z.boolean(),
  fills: z.array(ProposedFillSchema),
  proposedPnl: z.number().optional(),
});

export const CsvPreviewResponseSchema = z.object({
  token: z.string().uuid(),
  summary: z.object({
    rowsParsed: z.number().int(),
    rowsValid: z.number().int(),
    rowsWithErrors: z.number().int(),
    positions: z.number().int(),
    fills: z.number().int(),
  }),
  positions: z.array(ProposedPositionSchema),
  errors: z.array(LocatedErrorSchema),
  warnings: z.array(LocatedWarningSchema),
  timezone: z.string(),
  committable: z.boolean(),
  requiresDuplicateAffirmation: z.boolean(),
});

export const CsvCommitRequestSchema = z.object({
  token: z.string().uuid(),
  confirmDuplicates: z.boolean().default(false),
});

export const CsvCommitResponseSchema = z.object({
  positionsCreated: z.number().int(),
  fillsCreated: z.number().int(),
  positionIds: z.array(z.string().uuid()),
  accountId: z.string().uuid(),
});

export const CsvPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  rowShape: RowShapeSchema,
  delimiter: z.enum([',', ';', '\t']).optional(),
  dateFormat: DateFormatSchema,
  numberFormat: NumberFormatSchema,
  mapping: MappingSchema,
  transforms: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

export type RowShape = z.infer<typeof RowShapeSchema>;
export type DateFormat = z.infer<typeof DateFormatSchema>;
export type NumberFormat = z.infer<typeof NumberFormatSchema>;
export type Mapping = z.infer<typeof MappingSchema>;
export type CsvPreviewRequest = z.infer<typeof CsvPreviewRequestSchema>;
export type LocatedError = z.infer<typeof LocatedErrorSchema>;
export type LocatedWarning = z.infer<typeof LocatedWarningSchema>;
export type ProposedFill = z.infer<typeof ProposedFillSchema>;
export type ProposedPosition = z.infer<typeof ProposedPositionSchema>;
export type CsvPreviewResponse = z.infer<typeof CsvPreviewResponseSchema>;
export type CsvCommitRequest = z.infer<typeof CsvCommitRequestSchema>;
export type CsvCommitResponse = z.infer<typeof CsvCommitResponseSchema>;
export type CsvPreset = z.infer<typeof CsvPresetSchema>;
