import { z } from 'zod';

// Whitespace rejection (via trim comparison) mirrors `schemas/brokerage.ts` /
// `schemas/calculator.ts`: Number("  50  ") passes a bounds check but
// new Decimal("  50  ") throws, which would surface an implementation-detail
// error to API clients. Keep the trim comparison — do not replace with regex.

// Ledger amount: non-negative decimal with at most 4 fractional digits
// (matches the `numeric(18, 4)` column in `ledger_entries`). The ledger
// stores amounts as positive magnitudes — direction encodes sign.
const ledgerAmount = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    if (!/^\d+(\.\d{1,4})?$/.test(v)) return false;
    const n = Number(v);
    return !isNaN(n) && isFinite(n) && n >= 0;
  },
  { message: 'Must be a non-negative decimal string with up to 4 fractional digits' },
);

// Exchange rate: strictly positive decimal. The DB column is `numeric(24, 12)`
// so we allow up to 12 fractional digits.
const positiveRate = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    if (!/^\d+(\.\d{1,12})?$/.test(v)) return false;
    const n = Number(v);
    return !isNaN(n) && isFinite(n) && n > 0;
  },
  { message: 'Must be a positive decimal string with up to 12 fractional digits' },
);

const currencyCode = z.string().length(3);
const effectiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'Must be a YYYY-MM-DD date',
});

export const LedgerDirection = z.enum(['credit', 'debit']);
export const LedgerEntryType = z.enum(['position_pnl', 'position_pnl_reversal']);

// PUBLIC projection — `userId` and `reversesGroupId` are internal columns
// and MUST NOT appear on the wire. Use `.strict()` so a payload carrying
// `userId` is rejected (success criterion).
export const LedgerEntrySchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    positionId: z.string().uuid().nullable(),
    entryType: LedgerEntryType,
    direction: LedgerDirection,
    amount: ledgerAmount,
    currency: currencyCode,
    symbol: z.string().nullable(),
    occurredAt: z.string(),
    createdAt: z.string(),
    groupId: z.string().uuid(),
  })
  .strict();

export const LedgerEntryListResponseSchema = z.object({
  entries: z.array(LedgerEntrySchema),
  runningBalanceAtFirstRow: z.string(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
});

export const ExchangeRateSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  rate: positiveRate,
  effectiveDate,
  createdAt: z.string(),
});

export const CreateExchangeRateInputSchema = z.object({
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  rate: positiveRate,
  effectiveDate,
});

// Discriminated union on `intent` — the >5%-confirmation modal is symmetric
// across upsert/delete; the discriminator forces the delete-case through
// the contract.
export const PreviewRateChangeInputSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('upsert'),
    rate: CreateExchangeRateInputSchema,
  }),
  z.object({
    intent: z.literal('delete'),
    rateId: z.string().uuid(),
  }),
]);

export const PreviewRateChangeResponseSchema = z.object({
  displayCurrency: z.string().length(3).nullable(),
  beforeTotal: z.string().nullable(),
  afterTotal: z.string().nullable(),
  exceedsThreshold: z.boolean(),
});

export type LedgerDirection = z.infer<typeof LedgerDirection>;
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type LedgerEntryListResponse = z.infer<typeof LedgerEntryListResponseSchema>;
export type ExchangeRate = z.infer<typeof ExchangeRateSchema>;
export type CreateExchangeRateInput = z.infer<typeof CreateExchangeRateInputSchema>;
export type PreviewRateChangeInput = z.infer<typeof PreviewRateChangeInputSchema>;
export type PreviewRateChangeResponse = z.infer<typeof PreviewRateChangeResponseSchema>;

// Re-export the validators so callers can use them as bounded-decimal helpers
// (kept internal-by-convention; not added to the barrel).
export { ledgerAmount as ledgerAmountSchema, positiveRate as positiveRateSchema };
