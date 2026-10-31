import Decimal from 'decimal.js';

import type { Database, Transaction } from '@/db';
import { logger } from '@/lib/logger';

import type { AcbDisposition, MissingCadRate } from './acb-pool';
import { computeAcbDispositions } from './acb-pool';
import {
  listCadRatesForUser,
  listTaxableFillsForAcb,
  listTransferLinksForUser,
} from './expenses.query';

/**
 * Batches the reads, validates the stored transfer links, runs the pure
 * engine (`acb-pool.ts`), and keeps only the year's rows (design C4,
 * Requirement 3, NFR Performance). Three queries whatever the fill count —
 * never one per fill.
 */
export async function getAcbDispositionsForYear(
  db: Database | Transaction,
  userId: string,
  year: number,
): Promise<{
  rows: AcbDisposition[];
  missingRates: MissingCadRate[];
  ignoredEntryFillIds: Set<string>;
}> {
  // A trade date sits at most one day past the fill's UTC date (max IANA
  // offset +14), so the rates upper bound is one day past the fills' one
  // (design C4 post-condition 1).
  const fillsBefore = new Date(`${year + 1}-01-01T00:00:00Z`);
  const ratesBefore = `${year + 1}-01-02`;

  const [fillRows, rateRows, linkRows] = await Promise.all([
    listTaxableFillsForAcb(db, userId, fillsBefore),
    listCadRatesForUser(db, userId, ratesBefore),
    listTransferLinksForUser(db, userId),
  ]);

  // (currency, date) -> rate for the direct pair (currency, CAD) and for the
  // inverse pair (CAD, currency); cadRateFor prefers the direct row and never
  // falls back to another date (design C4 post-condition 2, AC 4.3).
  const directRates = new Map<string, Decimal>();
  const inverseRates = new Map<string, Decimal>();
  for (const r of rateRows) {
    if (r.quoteCurrency === 'CAD') {
      directRates.set(`${r.baseCurrency}|${r.effectiveDate}`, new Decimal(r.rate));
    } else if (r.baseCurrency === 'CAD') {
      inverseRates.set(`${r.quoteCurrency}|${r.effectiveDate}`, new Decimal(r.rate));
    }
  }

  function cadRateFor(currency: string, tradeDate: string): Decimal | null {
    const key = `${currency}|${tradeDate}`;
    const direct = directRates.get(key);
    if (direct) return direct;
    const inverse = inverseRates.get(key);
    if (inverse) return new Decimal(1).dividedBy(inverse);
    return null;
  }

  // A link is valid when the exit side is an exit, the entry side an entry,
  // the accounts differ, symbol and side match, and the quantities are
  // equal. An invalid link is ignored and logged (NFR Reliability). A valid
  // link whose two accounts are both taxable removes both fills from the
  // pool (AC 6.2); a link with a registered side adds nothing — the
  // registered fill never entered `fillRows`, so the taxable side is left an
  // ordinary disposition (AC 6.3, design C4 post-condition 3).
  const ignoredFillIds = new Set<string>();
  const ignoredEntryFillIds = new Set<string>();

  for (const link of linkRows) {
    const valid =
      link.exitFillType === 'exit' &&
      link.entryFillType === 'entry' &&
      link.exitAccountId !== link.entryAccountId &&
      link.exitSymbol === link.entrySymbol &&
      link.exitSide === link.entrySide &&
      new Decimal(link.exitQuantity).eq(new Decimal(link.entryQuantity));

    if (!valid) {
      logger.warn('acb_transfer_link_invalid', {
        event: 'acb_transfer_link_invalid',
        linkId: link.linkId,
      });
      continue;
    }

    if (link.exitTaxTreatment === 'taxable' && link.entryTaxTreatment === 'taxable') {
      ignoredFillIds.add(link.exitFillId);
      ignoredFillIds.add(link.entryFillId);
      ignoredEntryFillIds.add(link.entryFillId);
    }
  }

  const allRows = computeAcbDispositions(fillRows, cadRateFor, ignoredFillIds);

  // Rows keep only the year's realisations (AC 3.9); missingRates is the
  // distinct union of those rows' pairs, sorted by currency then date (AC
  // 4.7, design C4 post-condition 4).
  const windowStart = new Date(`${year}-01-01T00:00:00Z`).getTime();
  const windowEnd = new Date(`${year + 1}-01-01T00:00:00Z`).getTime();

  const rows = allRows.filter((row) => {
    const realisedAtMs = row.realisedAt.getTime();
    return realisedAtMs >= windowStart && realisedAtMs < windowEnd;
  });

  const missingByKey = new Map<string, MissingCadRate>();
  for (const row of rows) {
    for (const pair of row.missingRates) {
      missingByKey.set(`${pair.currency}|${pair.tradeDate}`, pair);
    }
  }
  const missingRates = [...missingByKey.values()].sort((a, b) =>
    a.currency === b.currency
      ? a.tradeDate.localeCompare(b.tradeDate)
      : a.currency.localeCompare(b.currency),
  );

  return { rows, missingRates, ignoredEntryFillIds };
}
