import Decimal from 'decimal.js';

export interface FillTotals {
  entryQty: string;
  exitQty: string;
  entryCost: string;
  exitCost: string;
  entryFees: string;
  exitFees: string;
}

export interface PnlResult {
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  totalEntryQuantity: number;
  totalExitQuantity: number;
  realizedPnl: number | null;
  returnPercentage: number | null;
  /**
   * Pre-fee realized P&L. `realizedPnl` minus nothing — the price move alone.
   * Surfaced so callers can show a fee breakdown without recomputing it (three
   * sites previously did, inconsistently).
   */
  grossPnl: number | null;
  /**
   * Fees actually recorded on the fills and subtracted from `grossPnl` to reach
   * `realizedPnl`: all exit fees plus entry fees pro-rated by
   * `exitQty / entryQty`. NOT a brokerage-schedule estimate — a fee schedule is
   * an entry-time convenience that populates `fills.fees`, and must never be
   * re-applied at read time.
   *
   * Invariant: `grossPnl − fees === realizedPnl`.
   */
  fees: number | null;
}

export function aggregateFills(
  fills: { type: string; price: string; quantity: string; fees: string }[],
): FillTotals {
  let entryQty = new Decimal(0);
  let exitQty = new Decimal(0);
  let entryCost = new Decimal(0);
  let exitCost = new Decimal(0);
  let entryFees = new Decimal(0);
  let exitFees = new Decimal(0);

  for (const fill of fills) {
    const price = new Decimal(fill.price);
    const qty = new Decimal(fill.quantity);
    const fees = new Decimal(fill.fees);

    if (fill.type === 'entry') {
      entryQty = entryQty.plus(qty);
      entryCost = entryCost.plus(price.times(qty));
      entryFees = entryFees.plus(fees);
    } else {
      exitQty = exitQty.plus(qty);
      exitCost = exitCost.plus(price.times(qty));
      exitFees = exitFees.plus(fees);
    }
  }

  return {
    entryQty: entryQty.toString(),
    exitQty: exitQty.toString(),
    entryCost: entryCost.toString(),
    exitCost: exitCost.toString(),
    entryFees: entryFees.toString(),
    exitFees: exitFees.toString(),
  };
}

export function computePnlFromTotals(
  totals: FillTotals,
  side: 'long' | 'short',
  assetType: 'stock' | 'option',
  currencyMinorUnits: number,
): PnlResult {
  const entryQty = new Decimal(totals.entryQty);
  const exitQty = new Decimal(totals.exitQty);

  if (entryQty.isZero()) {
    return {
      avgEntryPrice: null,
      avgExitPrice: null,
      totalEntryQuantity: 0,
      totalExitQuantity: 0,
      realizedPnl: null,
      returnPercentage: null,
      grossPnl: null,
      fees: null,
    };
  }

  const entryCost = new Decimal(totals.entryCost);
  const exitCost = new Decimal(totals.exitCost);
  const entryFees = new Decimal(totals.entryFees);
  const exitFees = new Decimal(totals.exitFees);

  const avgEntryPrice = entryCost.div(entryQty);
  const avgExitPrice = exitQty.isZero() ? null : exitCost.div(exitQty);

  if (exitQty.isZero()) {
    return {
      avgEntryPrice: avgEntryPrice.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toNumber(),
      avgExitPrice: null,
      totalEntryQuantity: entryQty.toNumber(),
      totalExitQuantity: 0,
      realizedPnl: null,
      returnPercentage: null,
      grossPnl: null,
      fees: null,
    };
  }

  const sideMultiplier = side === 'long' ? 1 : -1;
  const contractMultiplier = assetType === 'option' ? 100 : 1;

  const allocatedEntryFees = entryFees
    .times(exitQty.div(entryQty))
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

  const grossPnl = avgExitPrice!
    .minus(avgEntryPrice)
    .times(exitQty)
    .times(sideMultiplier)
    .times(contractMultiplier)
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

  // Total fees recorded on the fills that this realization bears.
  const totalFees = exitFees
    .plus(allocatedEntryFees)
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

  // Derived from the rounded components so `grossPnl − fees === realizedPnl`
  // holds exactly, rather than rounding the unrounded expression separately.
  const realizedPnl = grossPnl.minus(totalFees);

  // Return percentage denominator: avgEntryPrice × exitQty × contractMultiplier + allocatedEntryFees.
  // For short positions, this represents gross sale proceeds (notional sold), not margin requirement.
  // This matches the convention used by retail trading journals (TradeZella, TraderSync).
  const denominator = avgEntryPrice
    .times(exitQty)
    .times(contractMultiplier)
    .plus(allocatedEntryFees);

  const returnPercentage = denominator.isZero()
    ? null
    : realizedPnl.div(denominator).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    avgEntryPrice: avgEntryPrice.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toNumber(),
    avgExitPrice: avgExitPrice!.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toNumber(),
    totalEntryQuantity: entryQty.toNumber(),
    totalExitQuantity: exitQty.toNumber(),
    realizedPnl: realizedPnl.toNumber(),
    returnPercentage: returnPercentage?.toNumber() ?? null,
    grossPnl: grossPnl.toNumber(),
    fees: totalFees.toNumber(),
  };
}
