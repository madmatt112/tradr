import { z } from 'zod';

import { CURRENCY_CODES } from '../constants/currencies';
import { EXPENSE_CATEGORIES } from '../constants/expense-categories';

// Positive decimal with up to 4 fractional digits. Mirrors the `ledgerAmount`
// validator at `schemas/accounting.ts:11–20` (same regex, same trim guard) BUT
// strictly disallows zero — expense amounts must be `> 0`. Kept INLINE to
// preserve the accounting/expense decoupling (design Open Q4). Task 15 ships
// a cross-check test asserting the regex stays intentionally aligned.
export const positiveDecimal4 = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    if (!/^\d+(\.\d{1,4})?$/.test(v)) return false;
    const n = Number(v);
    return !isNaN(n) && isFinite(n) && n > 0;
  },
  { message: 'Must be a positive decimal string with up to 4 fractional digits' },
);

const occurredAtDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'Must be a YYYY-MM-DD date',
});

const currencyCode = z
  .string()
  .length(3)
  .refine((v) => (CURRENCY_CODES as readonly string[]).includes(v), {
    message: 'Must be a supported currency code',
  });

export const ExpenseCategoryEnum = z.enum(EXPENSE_CATEGORIES);

export const CreateExpenseInputSchema = z
  .object({
    category: ExpenseCategoryEnum,
    description: z.string().min(1).max(200),
    amount: positiveDecimal4,
    currency: currencyCode,
    occurredAt: occurredAtDate,
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict();

export const UpdateExpenseInputSchema = z
  .object({
    category: ExpenseCategoryEnum.optional(),
    description: z.string().min(1).max(200).optional(),
    amount: positiveDecimal4.optional(),
    currency: currencyCode.optional(),
    occurredAt: occurredAtDate.optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict();

export const ExpenseSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    category: ExpenseCategoryEnum,
    description: z.string(),
    amount: positiveDecimal4,
    currency: currencyCode,
    occurredAt: occurredAtDate,
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

// All three numeric query params are `z.coerce.number()` so a query string
// `?year=2026&page=0&pageSize=100` decodes correctly through Hono's query parser.
export const ExpenseListQuerySchema = z
  .object({
    year: z.coerce.number().int().min(1900).max(9999).optional(),
    page: z.coerce.number().int().nonnegative().default(0),
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

// `filterTotals` is populated server-side and scoped to the ACTIVE FILTER
// (year or "all years"), NOT to the current page — post-v2-fix #4.
export const ExpenseListResponseSchema = z
  .object({
    expenses: z.array(ExpenseSchema),
    page: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    hasMore: z.boolean(),
    filterTotals: z.object({
      year: z.number().int().nullable(),
      perCurrency: z.array(
        z.object({
          currency: z.string().length(3),
          total: positiveDecimal4,
        }),
      ),
      totalRowCount: z.number().int().nonnegative(),
    }),
  })
  .strict();

export const TaxJurisdictionEnum = z.enum(['US', 'CA', 'other']);

export const UpdateTaxJurisdictionInputSchema = z
  .object({
    taxJurisdiction: TaxJurisdictionEnum.nullable(),
  })
  .strict();

// Fee-rollup response — encodes `requirements.md` §3.1 verbatim. Decimal
// fields are plain `z.string()` (NOT `positiveDecimal4`) because the server
// emits raw `Decimal.toFixed(...)` strings and future surfaces may carry
// negative or zero totals.
export const FeeRollupResponseSchema = z
  .object({
    year: z.number().int(),
    totalsByAccount: z.array(
      z.object({
        accountId: z.string().uuid(),
        accountName: z.string(),
        currency: z.string().length(3),
        stockFees: z.string(),
        optionsFees: z.string(),
        totalFees: z.string(),
      }),
    ),
    perCurrencyTotals: z.array(
      z.object({
        currency: z.string().length(3),
        totalFees: z.string(),
      }),
    ),
    grandTotal: z
      .object({
        displayCurrency: z.string().length(3),
        totalFees: z.string(),
        convertedCurrencies: z.array(z.string().length(3)),
        excludedCurrencies: z.array(z.string().length(3)),
      })
      .nullable(),
    missingRates: z.array(
      z.object({
        base: z.string().length(3),
        quote: z.string().length(3),
      }),
    ),
    ratesAsOf: z.string().nullable(),
    usedRates: z.array(
      z.object({
        base: z.string().length(3),
        quote: z.string().length(3),
        rate: z.string(),
        effectiveDate: z.string(),
      }),
    ),
    disclaimer: z.string(),
  })
  .strict();

// Wash-sale / superficial-loss flag rows. Carried in
// `TaxSummaryResponseSchema.flags`. Reason is a closed enum — the task block
// pins the two possible v1 values.
export const WashSaleFlag = z.object({
  positionId: z.string().uuid(),
  symbol: z.string(),
  underlying: z.string().nullable(),
  side: z.enum(['long', 'short']),
  openedAt: z.string(),
  closedAt: z.string(),
  realisedLoss: z.string(),
  reason: z.enum(['repurchase_within_30_days', 'held_open_in_30d_window']),
  counterpartyPositionIds: z.array(z.string().uuid()),
});

export const SuperficialLossFlag = WashSaleFlag;

// Tax-summary response — encodes `requirements.md` §4.1 verbatim.
// MUST NOT include `netTaxableIncome` or any recorded-fee field (Req 4.1
// hard rule — fees live only on the fee-rollup response and are already
// netted into realised P&L). Decimal fields are plain `z.string()`.
export const TaxSummaryResponseSchema = z
  .object({
    year: z.number().int(),
    jurisdiction: TaxJurisdictionEnum,
    displayCurrency: z.string().length(3).nullable(),
    realisedPnl: z.object({
      total: z.string().nullable(),
      perCurrency: z.array(
        z.object({
          currency: z.string().length(3),
          amount: z.string(),
        }),
      ),
      shortTerm: z.string().nullable(),
      longTerm: z.string().nullable(),
    }),
    trackedExpenses: z.object({
      total: z.string().nullable(),
      perCurrency: z.array(
        z.object({
          currency: z.string().length(3),
          total: z.string(),
        }),
      ),
      perCategory: z.array(
        z.object({
          category: ExpenseCategoryEnum,
          currency: z.string().length(3),
          total: z.string(),
        }),
      ),
    }),
    flags: z.object({
      washSales: z.array(WashSaleFlag),
      superficialLosses: z.array(SuperficialLossFlag),
    }),
    missingRates: z.array(
      z.object({
        base: z.string().length(3),
        quote: z.string().length(3),
      }),
    ),
    excludedCurrencies: z.array(z.string().length(3)),
    ratesAsOf: z.string().nullable(),
    usedRates: z.array(
      z.object({
        base: z.string().length(3),
        quote: z.string().length(3),
        rate: z.string(),
        effectiveDate: z.string(),
      }),
    ),
    disclaimer: z.string(),
  })
  .strict();

export type Expense = z.infer<typeof ExpenseSchema>;
export type CreateExpenseInput = z.infer<typeof CreateExpenseInputSchema>;
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseInputSchema>;
export type ExpenseListQuery = z.infer<typeof ExpenseListQuerySchema>;
export type ExpenseListResponse = z.infer<typeof ExpenseListResponseSchema>;
export type TaxJurisdiction = z.infer<typeof TaxJurisdictionEnum>;
export type FeeRollupResponse = z.infer<typeof FeeRollupResponseSchema>;
export type TaxSummaryResponse = z.infer<typeof TaxSummaryResponseSchema>;
export type WashSaleFlag = z.infer<typeof WashSaleFlag>;
export type SuperficialLossFlag = z.infer<typeof SuperficialLossFlag>;
