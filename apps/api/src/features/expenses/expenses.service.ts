import Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '@tradr/shared/constants/currencies';
import { parseOccUnderlying } from '@tradr/shared/lib/occ';
import type {
  CreateExpenseInput,
  ExpenseListResponse,
  FeeRollupResponse,
  TaxSummaryResponse,
  UpdateExpenseInput,
} from '@tradr/shared/schemas/expense';

import { db } from '@/db';
import { findSpotRate, findUserDisplayCurrency } from '@/features/accounting/accounting.query';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { withTransaction } from '@/lib/transaction';

import {
  aggregateFeesByAccountAndAssetType,
  aggregatePerCurrencyFees,
} from './expenses.fee-rollup';
import {
  aggregateExpensesByCategory,
  aggregateExpenseTotalsByFilter,
  aggregateFeesByAccountForYear,
  deleteExpense,
  findExpenseById,
  getUserTaxJurisdiction,
  insertExpense,
  listCandidatePositionsByYear,
  listExpenses,
  listRealisedPositionsForYear,
  updateExpense as updateExpenseRow,
  updateUserTaxJurisdiction,
  type ExpenseRow,
  type TaxJurisdiction,
} from './expenses.query';
import {
  aggregatePerCurrencyRealisedPnl,
  applyYearEndSpotConversion,
  classifyUSHoldPeriod,
  findSuperficialLossFlags,
  findWashSaleFlags,
} from './expenses.tax';

// ---------------------------------------------------------------------------
// Write-side validation helpers (design.md §Component 6)
// ---------------------------------------------------------------------------

/**
 * Minor-unit alignment (Req 1.5): the fractional precision of `amount` must
 * not exceed the currency's minor units. JPY/KRW reject any fractional digits;
 * USD/EUR/etc. permit up to 2.
 *
 * The Zod layer rejects unsupported currency codes first, so `getCurrencyMinorUnits`
 * cannot throw on this path — no defensive guard.
 */
function assertMinorUnitAlignment(amount: string, currency: string): void {
  const minorUnits = getCurrencyMinorUnits(currency);
  if (new Decimal(amount).decimalPlaces() > minorUnits) {
    throw new ValidationError(
      `Amount has more decimal places than ${currency} allows (${minorUnits})`,
      { amount: `must have at most ${minorUnits} fractional digits for ${currency}` },
    );
  }
}

/**
 * Future-dating (Req 1.7): `occurredAt` cannot exceed `today + 365 days` in
 * UTC. Past dates have no lower bound.
 */
function assertNotFarFuture(occurredAt: string): void {
  // `occurredAt` is YYYY-MM-DD (Zod-validated). Treat as midnight UTC.
  const occurred = new Date(`${occurredAt}T00:00:00Z`);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const maxUtc = todayUtc + 365 * 24 * 60 * 60 * 1000;
  if (occurred.getTime() > maxUtc) {
    throw new ValidationError('Cannot be more than 365 days in the future', {
      occurredAt: 'must be within 365 days of today',
    });
  }
}

// ---------------------------------------------------------------------------
// CRUD (design.md §Component 6 — CRUD half)
// ---------------------------------------------------------------------------

export async function createExpense(
  userId: string,
  input: CreateExpenseInput,
): Promise<ExpenseRow> {
  assertMinorUnitAlignment(input.amount, input.currency);
  assertNotFarFuture(input.occurredAt);

  return withTransaction(db, async (tx) => {
    return insertExpense(tx, {
      userId,
      category: input.category,
      description: input.description,
      amount: input.amount,
      currency: input.currency,
      occurredAt: input.occurredAt,
      notes: input.notes ?? null,
    });
  });
}

export async function updateExpense(
  userId: string,
  id: string,
  patch: UpdateExpenseInput,
): Promise<ExpenseRow> {
  return withTransaction(db, async (tx) => {
    // PATCH currency mutation: if `currency` is in the patch, the minor-unit
    // check runs against the new currency. If `amount` isn't in the patch we
    // fetch the existing row to read its amount.
    const currencyInPatch = patch.currency !== undefined;
    const amountInPatch = patch.amount !== undefined;

    if (currencyInPatch || amountInPatch) {
      let effectiveAmount = patch.amount;
      let effectiveCurrency = patch.currency;

      if (!amountInPatch || !currencyInPatch) {
        const existing = await findExpenseById(tx, userId, id);
        if (existing === null) throw new NotFoundError('Expense', id);
        if (!amountInPatch) effectiveAmount = existing.amount;
        if (!currencyInPatch) effectiveCurrency = existing.currency;
      }

      assertMinorUnitAlignment(effectiveAmount!, effectiveCurrency!);
    }

    if (patch.occurredAt !== undefined) {
      assertNotFarFuture(patch.occurredAt);
    }

    const updated = await updateExpenseRow(tx, userId, id, {
      ...(patch.category !== undefined && { category: patch.category }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.amount !== undefined && { amount: patch.amount }),
      ...(patch.currency !== undefined && { currency: patch.currency }),
      ...(patch.occurredAt !== undefined && { occurredAt: patch.occurredAt }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    });
    if (updated === null) throw new NotFoundError('Expense', id);
    return updated;
  });
}

export async function removeExpense(userId: string, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const result = await deleteExpense(tx, userId, id);
    if (!result.deleted) throw new NotFoundError('Expense', id);
  });
}

export async function getExpense(userId: string, id: string): Promise<ExpenseRow> {
  const row = await findExpenseById(db, userId, id);
  if (row === null) throw new NotFoundError('Expense', id);
  return row;
}

export async function listExpensesForUser(
  userId: string,
  opts: { year?: number; page: number; pageSize: number },
): Promise<ExpenseListResponse> {
  const [listResult, filterTotals] = await Promise.all([
    listExpenses(db, userId, opts),
    aggregateExpenseTotalsByFilter(db, userId, { year: opts.year }),
  ]);

  return {
    expenses: listResult.expenses.map(serializeExpense),
    page: opts.page,
    pageSize: opts.pageSize,
    hasMore: listResult.hasMore,
    filterTotals: {
      year: opts.year ?? null,
      perCurrency: filterTotals.perCurrency,
      totalRowCount: filterTotals.totalRowCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Fee-rollup orchestration (design.md §Component 6 — `getFeeRollup`)
// ---------------------------------------------------------------------------

/**
 * Fee-rollup disclaimer per requirements.md §3.10 — verbatim. The fee rollup
 * is a visibility surface; the body explicitly tells users the fees here are
 * already netted into realised P&L on the tax summary so they do not subtract
 * a second time, and explains the divergent year-bucketing between the two
 * pages.
 */
const FEE_ROLLUP_DISCLAIMER = [
  'These fees are already netted into your realised P&L on the tax summary. Shown here for visibility — do not subtract them a second time.',
  'This page is bucketed by `fills.filledAt` (when the fee was paid). The tax summary is bucketed by `closedAt` (when the P&L was realised). A position opened in one calendar year and closed in another will appear on the two pages in different years — this is by design.',
].join('\n\n');

/**
 * Compute the per-year fee rollup for a user.
 *
 * Seven-step orchestration per design §Component 6:
 *   1. Raw `(account, assetType, currency)` fee rows for the year.
 *   2. Per-account aggregation with stock/options bucketing.
 *   3. Per-currency totals across accounts.
 *   4. Resolve user `displayCurrency` (NULL → grand total absent per Req 3.5).
 *   5. Resolve year-end spot rates for each non-display currency
 *      (`upperBound = ${year}-12-31T23:59:59.999Z`).
 *   6. Apply year-end spot conversion → grand total + degradation metadata.
 *   7. Compose the `FeeRollupResponse` (round display-currency totals to the
 *      display currency's minor units before emitting strings).
 *
 * Empty-year (zero fills) collapses to the empty-shape per Req 3.3.
 */
export async function getFeeRollup(userId: string, year: number): Promise<FeeRollupResponse> {
  const rawRows = await aggregateFeesByAccountForYear(db, userId, year);

  // Empty-year short-circuit (Req 3.3).
  if (rawRows.length === 0) {
    return {
      year,
      totalsByAccount: [],
      perCurrencyTotals: [],
      grandTotal: null,
      missingRates: [],
      ratesAsOf: null,
      usedRates: [],
      disclaimer: FEE_ROLLUP_DISCLAIMER,
    };
  }

  const perAccount = aggregateFeesByAccountAndAssetType(rawRows);
  const perCurrencyTotals = aggregatePerCurrencyFees(perAccount);

  // Serialise per-account totals at each row's own currency minor units.
  const totalsByAccount: FeeRollupResponse['totalsByAccount'] = perAccount.map((row) => {
    const minorUnits = getCurrencyMinorUnits(row.currency);
    return {
      accountId: row.accountId,
      accountName: row.accountName,
      currency: row.currency,
      stockFees: row.stockFees.toFixed(minorUnits),
      optionsFees: row.optionsFees.toFixed(minorUnits),
      totalFees: row.totalFees.toFixed(minorUnits),
    };
  });

  const perCurrencyTotalsResponse: FeeRollupResponse['perCurrencyTotals'] = [];
  for (const [currency, amount] of perCurrencyTotals) {
    perCurrencyTotalsResponse.push({
      currency,
      totalFees: amount.toFixed(getCurrencyMinorUnits(currency)),
    });
  }

  const displayCurrency = await findUserDisplayCurrency(db, userId);

  // Null displayCurrency (Req 3.5): per-currency totals still populated, but
  // grandTotal / missingRates / ratesAsOf / usedRates are null / empty.
  if (displayCurrency === null) {
    return {
      year,
      totalsByAccount,
      perCurrencyTotals: perCurrencyTotalsResponse,
      grandTotal: null,
      missingRates: [],
      ratesAsOf: null,
      usedRates: [],
      disclaimer: FEE_ROLLUP_DISCLAIMER,
    };
  }

  // Resolve year-end spot rates for each non-display currency. `upperBound`
  // pins past years to year-end; for the current year `min(today, year-end)`
  // resolves to today.
  const upperBound = new Date(`${year}-12-31T23:59:59.999Z`);
  const now = new Date();
  const effectiveAsOfMs = Math.min(now.getTime(), upperBound.getTime());
  const ratesAsOf = new Date(effectiveAsOfMs).toISOString().slice(0, 10);

  const rateMap = new Map<string, Decimal>();
  const usedRates: FeeRollupResponse['usedRates'] = [];

  for (const currency of perCurrencyTotals.keys()) {
    if (currency === displayCurrency) continue;
    const result = await findSpotRate(db, userId, currency, displayCurrency, now, { upperBound });
    if (result.source !== null) {
      rateMap.set(`${currency}->${displayCurrency}`, result.rate);
      usedRates.push({
        base: currency,
        quote: displayCurrency,
        rate: result.rate.toString(),
        // Per-rate source-row date (Req 4.5.6: reproducible from the response
        // alone). `effectiveDate` is non-null here because `source !== null`.
        effectiveDate: result.effectiveDate!,
      });
    }
  }

  const conversion = applyYearEndSpotConversion(perCurrencyTotals, displayCurrency, rateMap);

  const displayMinorUnits = getCurrencyMinorUnits(displayCurrency);
  const grandTotal: FeeRollupResponse['grandTotal'] =
    conversion.aggregate === null
      ? null
      : {
          displayCurrency,
          totalFees: conversion.aggregate.toFixed(displayMinorUnits),
          convertedCurrencies: conversion.convertedCurrencies,
          excludedCurrencies: conversion.excludedCurrencies,
        };

  return {
    year,
    totalsByAccount,
    perCurrencyTotals: perCurrencyTotalsResponse,
    grandTotal,
    missingRates: conversion.missingPairs,
    ratesAsOf,
    usedRates,
    disclaimer: FEE_ROLLUP_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Convert a `ExpenseRow` (Drizzle's selected shape — `Date` createdAt /
 * updatedAt, plain `string` amount) into the response shape expected by
 * `ExpenseSchema` (ISO strings for timestamps).
 */
function serializeExpense(row: ExpenseRow): ExpenseListResponse['expenses'][number] {
  return {
    id: row.id,
    userId: row.userId,
    // DB CHECK constraint enforces enum membership; the Drizzle row type is
    // `string` because the column is a plain `varchar`.
    category: row.category as ExpenseListResponse['expenses'][number]['category'],
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    occurredAt: row.occurredAt,
    notes: row.notes,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Tax-jurisdiction (design.md §Component 6 — jurisdiction half)
// ---------------------------------------------------------------------------

/**
 * Read the user's stored jurisdiction. Materializes NULL → `'other'` per
 * Req 4.2 — the API response is always one of the closed-enum values.
 */
export async function getTaxJurisdiction(userId: string): Promise<TaxJurisdiction> {
  const stored = await getUserTaxJurisdiction(db, userId);
  return stored ?? 'other';
}

/**
 * Persist the user's jurisdiction selection. `null` clears the column.
 * Wrapped in a transaction for consistency with other write paths.
 */
export async function setTaxJurisdiction(
  userId: string,
  value: TaxJurisdiction | null,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await updateUserTaxJurisdiction(tx, userId, value);
  });
}

// ---------------------------------------------------------------------------
// Tax-summary orchestration (design.md §Component 6 — `getTaxSummary`)
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Adapter from the project logger (string + object surface) to the
 * `{ warn: (obj) => void }` contract the pure tax helpers expect. The pure
 * helpers pass an object payload (e.g. `{ positionId, reason }`) which we
 * forward as `extra` under a fixed message.
 */
const taxLog: { warn: (obj: object) => void } = {
  warn: (obj) => logger.warn('tax_summary_helper', obj as Record<string, unknown>),
};

/**
 * Jurisdiction-specific clause for the disclaimer. Verbatim from
 * requirements §4.4 (see design §Component 6 "Disclaimer composition").
 */
const JURISDICTION_CLAUSE: Record<TaxJurisdiction, string> = {
  US: 'Brokerage fees on closed positions are already deducted from the realised P&L figures here. Recorded fill fees for visibility live on the separate Fee Rollup page (filledAt-bucketed). Wash-sale flags below are heuristic; they do not adjust the P&L figures.',
  CA: "Commission fees paid through fills are already incorporated into the realised gain/loss above (consistent with the CRA's adjusted cost base treatment). The 50% capital-gains inclusion rate is NOT applied by Tradr — the realised P&L shown is the pre-inclusion-rate figure.",
  other:
    'Tradr does not support jurisdiction-specific tax rules for your jurisdiction. The figures below are computational aggregates only; consult a local tax professional.',
};

const DISCLAIMER_PREAMBLE =
  'Tradr is not a tax advisor. The figures shown are computational aggregates of your trading data, not tax advice.';

const DISCLAIMER_RECONCILIATION =
  'Recorded fill fees and tracked expenses are surfaced in separate places — recorded fees on the [Fee Rollup page](/accounting/fee-rollup) (bucketed by `filledAt`), tracked expenses in the section below. Tradr does not compute a net taxable income — that subtraction depends on filer status and jurisdiction-specific deduction rules.';

const DISCLAIMER_HEURISTIC =
  'Wash-sale (US) and superficial-loss (CA) flags use a symbol-and-date heuristic, not lot-level matching. For options, matching uses the underlying — different strikes and expirations of the same underlying are flagged together. Wash-sale and superficial-loss flags aggregate across all of your accounts.';

const DISCLAIMER_YEAR_BUCKETING =
  "All year-bucketing uses UTC calendar boundaries. A position closed after 19:00 ET on December 31 will appear in the following year's tax summary.";

const DISCLAIMER_FILING = 'Consult a qualified tax professional for filing.';

function composeDisclaimer(
  jurisdiction: TaxJurisdiction,
  year: number,
  ratesAsOf: string | null,
): string {
  // Currency-conversion stability paragraph: branch by past-vs-current year.
  // `ratesAsOf` is null only when displayCurrency is null (no conversion
  // possible) — emit a neutral fallback so the disclaimer still reads well.
  const isPastYear = year < new Date().getUTCFullYear();
  const stability =
    ratesAsOf === null
      ? 'Currency conversion uses rates as of (none available — set a display currency to convert).'
      : isPastYear
        ? `Currency conversion uses rates as of ${ratesAsOf} (year-end). Reloading does not change the numbers unless you enter new rates dated on or before that date.`
        : `Currency conversion uses rates as of ${ratesAsOf} (the most recent rates available). Reloading after new rates are entered or after time passes may change these numbers.`;

  return [
    DISCLAIMER_PREAMBLE,
    JURISDICTION_CLAUSE[jurisdiction],
    DISCLAIMER_RECONCILIATION,
    DISCLAIMER_HEURISTIC,
    stability,
    DISCLAIMER_YEAR_BUCKETING,
    DISCLAIMER_FILING,
  ].join('\n\n');
}

/**
 * Compute the per-year tax summary for a user.
 *
 * Seven-step orchestration per design §Component 6:
 *   1. Resolve jurisdiction (NULL → 'other').
 *   2. Per-position realised P&L rows for the year (signed; reversal-cancelled).
 *   3. Per-(category, currency) expense aggregates for the year.
 *   4. Per-currency realised P&L aggregation.
 *   5. US short/long-term hold-period classification (CA/other → null).
 *   6. Wash-sale / superficial-loss heuristic — short-circuit when no losses;
 *      candidate window bounded to `[min(loss.closedAt) - 30d, max + 30d]`.
 *   7. Display-currency conversion via `applyYearEndSpotConversion` (twice —
 *      for realised P&L total and for tracked-expenses total). Compose response.
 */
export async function getTaxSummary(userId: string, year: number): Promise<TaxSummaryResponse> {
  // Step 1: jurisdiction.
  const jurisdiction = await getTaxJurisdiction(userId);

  // Step 2 + 3: data fetch (independent — issue in parallel).
  const [realisedRows, expensesByCategory] = await Promise.all([
    listRealisedPositionsForYear(db, userId, year),
    aggregateExpensesByCategory(db, userId, year),
  ]);

  // Step 4: per-currency realised P&L aggregation.
  const realisedPerCurrency = aggregatePerCurrencyRealisedPnl(realisedRows);

  // Step 5: US short/long-term classification (CA/other → null totals).
  const { shortTerm: shortTermPerCurrency, longTerm: longTermPerCurrency } =
    jurisdiction === 'US'
      ? classifyUSHoldPeriod(realisedRows)
      : {
          shortTerm: new Map<string, Decimal>(),
          longTerm: new Map<string, Decimal>(),
        };

  // Step 6: wash-sale / superficial-loss heuristic.
  // SHORT-CIRCUIT: skip the candidate query entirely when there are no losses
  // or when jurisdiction === 'other' (no flags emitted at all).
  const losingRows = realisedRows.filter((r) => new Decimal(r.realisedPnl).isNegative());

  let washSales: TaxSummaryResponse['flags']['washSales'] = [];
  let superficialLosses: TaxSummaryResponse['flags']['superficialLosses'] = [];

  if (jurisdiction !== 'other' && losingRows.length > 0) {
    // Window: [min(losing.closedAt) - 30d, max(losing.closedAt) + 30d].
    // `closedAt` is non-null on realised rows (Task 9 helpers also assume this
    // and skip nulls defensively; the same defence applies here).
    const closedTimes = losingRows
      .map((r) => (r.closedAt ? new Date(r.closedAt).getTime() : null))
      .filter((t): t is number => t !== null);

    if (closedTimes.length > 0) {
      const windowStart = new Date(Math.min(...closedTimes) - THIRTY_DAYS_MS);
      const windowEnd = new Date(Math.max(...closedTimes) + THIRTY_DAYS_MS);
      const candidates = await listCandidatePositionsByYear(db, userId, {
        start: windowStart,
        end: windowEnd,
      });

      if (jurisdiction === 'US') {
        const flags = findWashSaleFlags(losingRows, candidates, parseOccUnderlying, taxLog);
        washSales = flags.map((f) => ({
          positionId: f.positionId,
          symbol: f.symbol,
          underlying: f.underlying,
          side: f.side,
          openedAt: f.openedAt instanceof Date ? f.openedAt.toISOString() : String(f.openedAt),
          closedAt: f.closedAt instanceof Date ? f.closedAt.toISOString() : String(f.closedAt),
          realisedLoss: f.realisedLoss,
          reason: f.reason,
          counterpartyPositionIds: f.counterpartyPositionIds,
        }));
      } else {
        // jurisdiction === 'CA'
        const flags = findSuperficialLossFlags(losingRows, candidates, parseOccUnderlying, taxLog);
        superficialLosses = flags.map((f) => ({
          positionId: f.positionId,
          symbol: f.symbol,
          underlying: f.underlying,
          side: f.side,
          openedAt: f.openedAt instanceof Date ? f.openedAt.toISOString() : String(f.openedAt),
          closedAt: f.closedAt instanceof Date ? f.closedAt.toISOString() : String(f.closedAt),
          realisedLoss: f.realisedLoss,
          reason: f.reason,
          counterpartyPositionIds: f.counterpartyPositionIds,
        }));
      }
    }
  }

  // Step 7: display-currency lookup + year-end spot conversion.
  const displayCurrency = await findUserDisplayCurrency(db, userId);

  // Per-currency expense totals (from category aggregates).
  const expensesPerCurrency = new Map<string, Decimal>();
  for (const row of expensesByCategory) {
    const current = expensesPerCurrency.get(row.currency) ?? new Decimal(0);
    expensesPerCurrency.set(row.currency, current.plus(new Decimal(row.total)));
  }

  // Per-currency realised P&L response shape (emit at each currency's minor
  // units — matches the fee-rollup convention).
  const realisedPerCurrencyResponse: TaxSummaryResponse['realisedPnl']['perCurrency'] = [];
  for (const [currency, amount] of realisedPerCurrency) {
    realisedPerCurrencyResponse.push({
      currency,
      amount: amount.toFixed(getCurrencyMinorUnits(currency)),
    });
  }

  const expensesPerCurrencyResponse: TaxSummaryResponse['trackedExpenses']['perCurrency'] = [];
  for (const [currency, amount] of expensesPerCurrency) {
    expensesPerCurrencyResponse.push({
      currency,
      total: amount.toFixed(getCurrencyMinorUnits(currency)),
    });
  }

  const perCategoryResponse: TaxSummaryResponse['trackedExpenses']['perCategory'] =
    expensesByCategory.map((row) => ({
      category:
        row.category as TaxSummaryResponse['trackedExpenses']['perCategory'][number]['category'],
      currency: row.currency,
      total: new Decimal(row.total).toFixed(getCurrencyMinorUnits(row.currency)),
    }));

  // Null displayCurrency: aggregates collapse to null; per-currency rows still
  // populated. No rate lookups; no usedRates / missingRates / excludedCurrencies.
  if (displayCurrency === null) {
    return {
      year,
      jurisdiction,
      displayCurrency: null,
      realisedPnl: {
        total: null,
        perCurrency: realisedPerCurrencyResponse,
        shortTerm: null,
        longTerm: null,
      },
      trackedExpenses: {
        total: null,
        perCurrency: expensesPerCurrencyResponse,
        perCategory: perCategoryResponse,
      },
      flags: { washSales, superficialLosses },
      missingRates: [],
      excludedCurrencies: [],
      ratesAsOf: null,
      usedRates: [],
      disclaimer: composeDisclaimer(jurisdiction, year, null),
    };
  }

  // Resolve year-end spot rates for each non-display currency that appears in
  // EITHER the realised-P&L totals OR the per-currency expense totals.
  const upperBound = new Date(`${year}-12-31T23:59:59.999Z`);
  const now = new Date();
  const effectiveAsOfMs = Math.min(now.getTime(), upperBound.getTime());
  const ratesAsOf = new Date(effectiveAsOfMs).toISOString().slice(0, 10);

  const allCurrencies = new Set<string>([
    ...realisedPerCurrency.keys(),
    ...expensesPerCurrency.keys(),
    // shortTerm/longTerm currencies are a subset of realisedPerCurrency's keys.
  ]);

  const rateMap = new Map<string, Decimal>();
  const usedRates: TaxSummaryResponse['usedRates'] = [];

  for (const currency of allCurrencies) {
    if (currency === displayCurrency) continue;
    const result = await findSpotRate(db, userId, currency, displayCurrency, now, { upperBound });
    if (result.source !== null) {
      rateMap.set(`${currency}->${displayCurrency}`, result.rate);
      usedRates.push({
        base: currency,
        quote: displayCurrency,
        rate: result.rate.toString(),
        effectiveDate: result.effectiveDate!,
      });
    }
  }

  // Apply conversion for realised-P&L total, tracked-expenses total, and (US
  // only) short/long-term totals. Each call returns its own
  // `missingPairs` / `excludedCurrencies` — we union them for the response.
  const realisedConv = applyYearEndSpotConversion(realisedPerCurrency, displayCurrency, rateMap);
  const expensesConv = applyYearEndSpotConversion(expensesPerCurrency, displayCurrency, rateMap);

  const displayMinorUnits = getCurrencyMinorUnits(displayCurrency);

  // US-only: convert per-currency short/long totals into single display-currency
  // strings. For CA/other these stay null.
  let shortTermStr: string | null = null;
  let longTermStr: string | null = null;
  if (jurisdiction === 'US') {
    const shortConv = applyYearEndSpotConversion(shortTermPerCurrency, displayCurrency, rateMap);
    const longConv = applyYearEndSpotConversion(longTermPerCurrency, displayCurrency, rateMap);
    shortTermStr =
      shortConv.aggregate === null ? null : shortConv.aggregate.toFixed(displayMinorUnits);
    longTermStr =
      longConv.aggregate === null ? null : longConv.aggregate.toFixed(displayMinorUnits);
  }

  // Union the two conversion calls' missing-pair / excluded-currency lists.
  const missingRatesMap = new Map<string, { base: string; quote: string }>();
  for (const m of [...realisedConv.missingPairs, ...expensesConv.missingPairs]) {
    missingRatesMap.set(`${m.base}->${m.quote}`, m);
  }
  const excludedSet = new Set<string>([
    ...realisedConv.excludedCurrencies,
    ...expensesConv.excludedCurrencies,
  ]);

  return {
    year,
    jurisdiction,
    displayCurrency,
    realisedPnl: {
      total:
        realisedConv.aggregate === null ? null : realisedConv.aggregate.toFixed(displayMinorUnits),
      perCurrency: realisedPerCurrencyResponse,
      shortTerm: shortTermStr,
      longTerm: longTermStr,
    },
    trackedExpenses: {
      total:
        expensesConv.aggregate === null ? null : expensesConv.aggregate.toFixed(displayMinorUnits),
      perCurrency: expensesPerCurrencyResponse,
      perCategory: perCategoryResponse,
    },
    flags: { washSales, superficialLosses },
    missingRates: Array.from(missingRatesMap.values()),
    excludedCurrencies: Array.from(excludedSet),
    ratesAsOf,
    usedRates,
    disclaimer: composeDisclaimer(jurisdiction, year, ratesAsOf),
  };
}
