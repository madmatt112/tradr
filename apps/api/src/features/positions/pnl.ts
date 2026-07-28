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
    };
  }

  const sideMultiplier = side === 'long' ? 1 : -1;
  const contractMultiplier = assetType === 'option' ? 100 : 1;

  const allocatedEntryFees = entryFees
    .times(exitQty.div(entryQty))
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

  const realizedPnl = avgExitPrice!
    .minus(avgEntryPrice)
    .times(exitQty)
    .times(sideMultiplier)
    .times(contractMultiplier)
    .minus(exitFees)
    .minus(allocatedEntryFees)
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

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
  };
}
