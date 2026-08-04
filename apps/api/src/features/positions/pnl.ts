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

  // `realizedPnl` rounds ONCE, at the end, over the fully-unrounded expression.
  // Do not refactor this into `round(gross) − round(fees)`: rounding twice and
  // then subtracting is NOT equivalent and shifts the result by a minor unit.
  // Worked counter-example — gross 100.006, exit fees 0.004, USD:
  //   round(100.006 − 0.004) = 100.00      (this expression)
  //   round(100.006) − round(0.004) = 100.01
  // Pinned by "rounds once at the end" in pnl.test.ts.
  const realizedPnl = avgExitPrice!
    .minus(avgEntryPrice)
    .times(exitQty)
    .times(sideMultiplier)
    .times(contractMultiplier)
    .minus(exitFees)
    .minus(allocatedEntryFees)
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

  const grossPnl = avgExitPrice!
    .minus(avgEntryPrice)
    .times(exitQty)
    .times(sideMultiplier)
    .times(contractMultiplier)
    .toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

  // Derived as `gross − net`, NOT summed independently, so
  // `grossPnl − fees === realizedPnl` holds exactly without perturbing
  // `realizedPnl`. The breakdown absorbs the rounding residue; the money figure
  // does not. This is the same convention `performance.service` already used.
  const totalFees = grossPnl.minus(realizedPnl);

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

export interface RealizationEvent {
  occurredAt: Date;
  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
}

/**
 * Decompose a position's fills into the stream of REALIZATION EVENTS they
 * produce — one per fill that changes cumulative realized P&L, carrying the
 * delta and dated at that fill's `filledAt`.
 *
 * This is the same rule the ledger's fill hook applies (`postRealizedDelta`):
 * recompute the cumulative figure over all fills up to and including each fill,
 * and emit the difference from the previous cumulative. Deriving it the same way
 * means performance and the ledger cannot drift apart.
 *
 * Recomputing from scratch at each step — rather than accumulating per fill — is
 * what keeps entry-fee proration exact: entry fees are allocated by
 * `exitQty / entryQty`, so every new fill reprices the whole position.
 *
 * ANY fill can produce an event, not just exits: adding a late entry changes the
 * average cost and therefore retroactively changes P&L already realized, which
 * surfaces as a negative delta. Entry-only positions realize nothing and produce
 * no events.
 *
 * `grossPnl − fees === netPnl` holds per event, because each is the difference
 * of two figures for which the invariant already holds.
 */
export function computeRealizationEvents(
  fills: readonly { type: string; price: string; quantity: string; fees: string; filledAt: Date }[],
  side: 'long' | 'short',
  assetType: 'stock' | 'option',
  currencyMinorUnits: number,
): RealizationEvent[] {
  const ordered = [...fills].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
  const events: RealizationEvent[] = [];

  let prevGross = new Decimal(0);
  let prevFees = new Decimal(0);
  let prevNet = new Decimal(0);

  for (let i = 0; i < ordered.length; i++) {
    const pnl = computePnlFromTotals(
      aggregateFills(ordered.slice(0, i + 1)),
      side,
      assetType,
      currencyMinorUnits,
    );
    // null realizedPnl ⇒ no exits yet ⇒ nothing realized.
    const gross = new Decimal(pnl.grossPnl ?? 0);
    const fees = new Decimal(pnl.fees ?? 0);
    const net = new Decimal(pnl.realizedPnl ?? 0);

    const dGross = gross.minus(prevGross);
    const dFees = fees.minus(prevFees);
    const dNet = net.minus(prevNet);

    if (!dGross.isZero() || !dFees.isZero() || !dNet.isZero()) {
      events.push({
        occurredAt: ordered[i]!.filledAt,
        grossPnl: dGross,
        fees: dFees,
        netPnl: dNet,
      });
    }

    prevGross = gross;
    prevFees = fees;
    prevNet = net;
  }

  return events;
}
