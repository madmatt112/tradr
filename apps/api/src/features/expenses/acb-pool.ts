import Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '@tradr/shared/constants/currencies';

import { orderFills } from '../positions/lots';

export type AcbFill = {
  id: string;
  positionId: string;
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  assetType: 'stock' | 'option';
  type: 'entry' | 'exit';
  price: string;
  quantity: string;
  fees: string;
  filledAt: Date;
  createdAt: Date;
  currency: string;
  timezone: string;
  positionOpenedAt: Date | null;
  positionClosedAt: Date | null;
};

export type MissingCadRate = { currency: string; tradeDate: string };

export type AcbUnpricedReason = 'missing_rate' | 'pool_unpriced' | 'insufficient_pool';

export type AcbDisposition = {
  exitFillId: string;
  positionId: string;
  accountId: string;
  symbol: string;
  side: 'long' | 'short';
  assetType: 'stock' | 'option';
  currency: string;
  tradeDate: string;
  realisedAt: Date;
  quantity: Decimal;
  cadRate: Decimal | null;
  proceeds: Decimal | null;
  outlays: Decimal | null;
  acb: Decimal | null;
  gain: Decimal | null;
  unpricedReason: AcbUnpricedReason | null;
  missingRates: MissingCadRate[];
  positionOpenedAt: Date | null;
  positionClosedAt: Date | null;
};

type AcbPool = {
  quantity: Decimal;
  // Cost for a `long` pool, net proceeds for a `short` pool — both in CAD.
  amount: Decimal;
  // Entry (currency, tradeDate) pairs whose rate was missing when they
  // joined the pool; non-empty means every later exit is `pool_unpriced`
  // until the pool drains (design C3 post-condition 6a, D3).
  unpriced: Map<string, MissingCadRate>;
};

const CAD_MINOR_UNITS = getCurrencyMinorUnits('CAD');

function missingKey(pair: MissingCadRate): string {
  return `${pair.currency}|${pair.tradeDate}`;
}

/**
 * Zone-local calendar date for a fill's trade date, same formula as
 * `zonedDateKey` (apps/api/src/features/positions/positions.service.ts:84-91).
 * UTC-only Date math would misclassify a trading session that straddles UTC
 * midnight in a non-UTC market timezone (design C3 post-condition 1, AC 4.2).
 */
export function tradeDateKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Computes every ACB disposition row over the whole fill history (design
 * C3). Pure: no I/O, Decimal throughout, never rounds the pool itself (AC
 * 3.8) — only the three money fields on a priced row are rounded, once.
 */
export function computeAcbDispositions(
  fills: readonly AcbFill[],
  cadRateFor: (currency: string, tradeDate: string) => Decimal | null,
  ignoredFillIds: ReadonlySet<string>,
): AcbDisposition[] {
  const pools = new Map<string, AcbPool>();
  const rows: AcbDisposition[] = [];

  const ordered = orderFills(fills.filter((f) => !ignoredFillIds.has(f.id)));

  for (const f of ordered) {
    const poolKey = `${f.symbol}|${f.side}`;
    let pool = pools.get(poolKey);
    if (!pool) {
      pool = { quantity: new Decimal(0), amount: new Decimal(0), unpriced: new Map() };
      pools.set(poolKey, pool);
    }

    // An option contract represents 100 underlying shares (AC 3.4, same
    // convention as computeLotRealisations, apps/api/src/features/positions/lots.ts:262-342).
    const multiplier = f.assetType === 'option' ? 100 : 1;
    const price = new Decimal(f.price);
    const q = new Decimal(f.quantity);
    const fees = new Decimal(f.fees);
    const tradeDate = tradeDateKey(f.filledAt, f.timezone);
    const isCad = f.currency === 'CAD';
    // CAD needs no rate lookup — the pool is CAD-denominated already (AC 4.1).
    const rate = isCad ? new Decimal(1) : cadRateFor(f.currency, tradeDate);

    if (f.type === 'entry') {
      pool.quantity = pool.quantity.plus(q);
      if (rate !== null) {
        // Cost (long) or net proceeds (short) added to the pool, converted
        // to CAD at the entry's own trade-date rate (AC 3.4, AC 3.6).
        const delta =
          f.side === 'long'
            ? price.times(q).times(multiplier).plus(fees).times(rate)
            : price.times(q).times(multiplier).minus(fees).times(rate);
        pool.amount = pool.amount.plus(delta);
      } else {
        // No rate: the entry still joins the pool by quantity so later
        // exits stay within it, but contributes no amount and unprices
        // every later exit of this pool until it drains (AC 4.4, D3).
        pool.unpriced.set(missingKey({ currency: f.currency, tradeDate }), {
          currency: f.currency,
          tradeDate,
        });
      }
      continue;
    }

    // Exit. Precedence: pool_unpriced, then insufficient_pool, then
    // missing_rate, then priced (design C3 post-condition 6).
    const quantityBeforeShrink = pool.quantity;
    let reason: AcbUnpricedReason | null = null;
    let missingRates: MissingCadRate[] = [];
    let proceeds: Decimal | null = null;
    let outlays: Decimal | null = null;
    let acb: Decimal | null = null;
    let gain: Decimal | null = null;
    let cadRate: Decimal | null = null;

    if (pool.unpriced.size > 0) {
      reason = 'pool_unpriced';
      missingRates = [...pool.unpriced.values()];
      if (rate === null) {
        const key = missingKey({ currency: f.currency, tradeDate });
        if (!pool.unpriced.has(key)) missingRates.push({ currency: f.currency, tradeDate });
      }
      if (q.lte(quantityBeforeShrink)) {
        const share = pool.amount.times(q).div(quantityBeforeShrink);
        pool.quantity = quantityBeforeShrink.minus(q);
        pool.amount = pool.amount.minus(share);
      }
      // else: the exit exceeds the pool too, but pool_unpriced still wins
      // over insufficient_pool (AC 4.4); the pool is left unchanged.
    } else if (q.gt(quantityBeforeShrink)) {
      reason = 'insufficient_pool';
      // Pool unchanged (AC 3.7).
    } else if (rate === null) {
      reason = 'missing_rate';
      missingRates = [{ currency: f.currency, tradeDate }];
      const share = pool.amount.times(q).div(quantityBeforeShrink);
      pool.quantity = quantityBeforeShrink.minus(q);
      pool.amount = pool.amount.minus(share);
    } else {
      const share = pool.amount.times(q).div(quantityBeforeShrink);
      pool.quantity = quantityBeforeShrink.minus(q);
      pool.amount = pool.amount.minus(share);

      // Long: proceeds from the sale, ACB is the pooled cost share (AC 3.5).
      // Short: proceeds are the pooled proceeds share, ACB is the buyback
      // cost (AC 3.6). Both convert to CAD at the exit's own rate; `share`
      // is already in CAD from entry-time conversion.
      const proceedsRaw = f.side === 'long' ? price.times(q).times(multiplier).times(rate) : share;
      const acbRaw = f.side === 'long' ? share : price.times(q).times(multiplier).times(rate);
      const outlaysRaw = fees.times(rate);

      // Round once to CAD minor units; gain is derived from the rounded
      // figures, so it is exact even when `share` carries a repeating
      // decimal (AC 3.8).
      proceeds = proceedsRaw.toDecimalPlaces(CAD_MINOR_UNITS, Decimal.ROUND_HALF_UP);
      acb = acbRaw.toDecimalPlaces(CAD_MINOR_UNITS, Decimal.ROUND_HALF_UP);
      outlays = outlaysRaw.toDecimalPlaces(CAD_MINOR_UNITS, Decimal.ROUND_HALF_UP);
      gain = proceeds.minus(outlays).minus(acb);
      cadRate = isCad ? null : rate;
    }

    // A pool drained to exactly zero resets: a nil holding has nil ACB, and
    // a stale unpriced flag must not survive to taint an unrelated future
    // holding of the same symbol/side (design D3).
    if (pool.quantity.isZero()) {
      pool.amount = new Decimal(0);
      pool.unpriced.clear();
    }

    rows.push({
      exitFillId: f.id,
      positionId: f.positionId,
      accountId: f.accountId,
      symbol: f.symbol,
      side: f.side,
      assetType: f.assetType,
      currency: f.currency,
      tradeDate,
      realisedAt: f.filledAt,
      quantity: q,
      cadRate,
      proceeds,
      outlays,
      acb,
      gain,
      unpricedReason: reason,
      missingRates,
      positionOpenedAt: f.positionOpenedAt,
      positionClosedAt: f.positionClosedAt,
    });
  }

  return rows;
}
