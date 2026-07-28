import { Decimal } from 'decimal.js';

import type { FeeRollupRow } from './expenses.query';

// ---------------------------------------------------------------------------
// Per-account aggregation
// ---------------------------------------------------------------------------

export type AccountFeeAggregate = {
  accountId: string;
  accountName: string;
  currency: string;
  stockFees: Decimal;
  optionsFees: Decimal;
  totalFees: Decimal;
};

/**
 * Group `FeeRollupRow`s by `accountId`, split each group's totals into
 * `stockFees` / `optionsFees` by `assetType`, and emit `totalFees =
 * stockFees + optionsFees`. An account with only one asset type still emits
 * `new Decimal(0)` for the missing side so the response shape stays uniform
 * (Req 3.6).
 *
 * Sorted by `accountName ASC` for stable display order.
 *
 * Assumes upstream query already groups by `(account, assetType, currency)`
 * (Task 7.3 — `aggregateFeesByAccountForYear`). Currency is taken from the
 * first row encountered for the account — all rows under a single account
 * share the account's currency by construction.
 */
export function aggregateFeesByAccountAndAssetType(rows: FeeRollupRow[]): AccountFeeAggregate[] {
  const byAccount = new Map<
    string,
    {
      accountId: string;
      accountName: string;
      currency: string;
      stockFees: Decimal;
      optionsFees: Decimal;
    }
  >();

  for (const row of rows) {
    let entry = byAccount.get(row.accountId);
    if (!entry) {
      entry = {
        accountId: row.accountId,
        accountName: row.accountName,
        currency: row.currency,
        stockFees: new Decimal(0),
        optionsFees: new Decimal(0),
      };
      byAccount.set(row.accountId, entry);
    }

    const fee = new Decimal(row.totalFees);
    if (row.assetType === 'stock') {
      entry.stockFees = entry.stockFees.plus(fee);
    } else {
      entry.optionsFees = entry.optionsFees.plus(fee);
    }
  }

  const result: AccountFeeAggregate[] = [];
  for (const entry of byAccount.values()) {
    result.push({
      accountId: entry.accountId,
      accountName: entry.accountName,
      currency: entry.currency,
      stockFees: entry.stockFees,
      optionsFees: entry.optionsFees,
      totalFees: entry.stockFees.plus(entry.optionsFees),
    });
  }

  result.sort((a, b) => a.accountName.localeCompare(b.accountName));
  return result;
}

// ---------------------------------------------------------------------------
// Per-currency aggregation
// ---------------------------------------------------------------------------

/**
 * Sum `totalFees` across the per-account aggregates, grouped by `currency`.
 * The service composes the result with `applyYearEndSpotConversion` (from
 * `expenses.tax.ts`) to produce the grand total — that conversion is NOT
 * re-implemented here.
 */
export function aggregatePerCurrencyFees(
  perAccount: Array<{ currency: string; totalFees: Decimal }>,
): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const entry of perAccount) {
    const existing = totals.get(entry.currency) ?? new Decimal(0);
    totals.set(entry.currency, existing.plus(entry.totalFees));
  }
  return totals;
}
