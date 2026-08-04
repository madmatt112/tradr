import { describe, it, expect } from 'vitest';

import { aggregateFills, computeOpenCostBasis, computePnlFromTotals } from './pnl';
import type { FillTotals } from './pnl';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeFill(
  type: 'entry' | 'exit',
  price: number | string,
  quantity: number | string,
  fees: number | string = '0',
) {
  return {
    type,
    price: String(price),
    quantity: String(quantity),
    fees: String(fees),
  };
}

// ---------------------------------------------------------------------------
// aggregateFills
// ---------------------------------------------------------------------------

describe('aggregateFills', () => {
  it('returns zeros for empty fills', () => {
    const totals = aggregateFills([]);
    expect(totals).toEqual({
      entryQty: '0',
      exitQty: '0',
      entryCost: '0',
      exitCost: '0',
      entryFees: '0',
      exitFees: '0',
    });
  });

  it('aggregates a single entry fill', () => {
    const totals = aggregateFills([makeFill('entry', 100, 10, 5)]);
    expect(totals.entryQty).toBe('10');
    expect(totals.entryCost).toBe('1000');
    expect(totals.entryFees).toBe('5');
    expect(totals.exitQty).toBe('0');
    expect(totals.exitCost).toBe('0');
    expect(totals.exitFees).toBe('0');
  });

  it('aggregates entry and exit fills', () => {
    const totals = aggregateFills([makeFill('entry', 100, 10, 5), makeFill('exit', 110, 10, 5)]);
    expect(totals.entryQty).toBe('10');
    expect(totals.entryCost).toBe('1000');
    expect(totals.entryFees).toBe('5');
    expect(totals.exitQty).toBe('10');
    expect(totals.exitCost).toBe('1100');
    expect(totals.exitFees).toBe('5');
  });

  it('aggregates multiple entry fills at different prices', () => {
    const totals = aggregateFills([
      makeFill('entry', 100, 10, 2),
      makeFill('entry', 105, 20, 3),
      makeFill('entry', 110, 10, 1),
    ]);
    // cost = 100*10 + 105*20 + 110*10 = 1000 + 2100 + 1100 = 4200
    expect(totals.entryQty).toBe('40');
    expect(totals.entryCost).toBe('4200');
    expect(totals.entryFees).toBe('6');
  });

  it('handles IEEE 754 edge-case values without floating point errors', () => {
    const totals = aggregateFills([
      makeFill('entry', '0.1', '3', '0'),
      makeFill('entry', '0.2', '3', '0'),
    ]);
    // 0.1*3 + 0.2*3 = 0.3 + 0.6 = 0.9 (exact via Decimal.js)
    expect(totals.entryCost).toBe('0.9');
    expect(totals.entryQty).toBe('6');
  });
});

// ---------------------------------------------------------------------------
// computePnlFromTotals
// ---------------------------------------------------------------------------

describe('computePnlFromTotals', () => {
  // 1. Long stock — full exit
  it('computes long stock P&L for full exit', () => {
    const totals = aggregateFills([makeFill('entry', 100, 10, 5), makeFill('exit', 110, 10, 5)]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    expect(result.avgEntryPrice).toBe(100);
    expect(result.avgExitPrice).toBe(110);
    expect(result.totalEntryQuantity).toBe(10);
    expect(result.totalExitQuantity).toBe(10);
    // pnl = (110-100)*10*1*1 - 5(exit) - 5(allocated entry) = 90
    expect(result.realizedPnl).toBe(90);
    expect(result.returnPercentage).not.toBeNull();
  });

  // 2. Short stock
  it('computes short stock P&L (sideMultiplier = -1)', () => {
    const totals = aggregateFills([makeFill('entry', 100, 10, 5), makeFill('exit', 90, 10, 5)]);
    const result = computePnlFromTotals(totals, 'short', 'stock', 2);

    expect(result.avgEntryPrice).toBe(100);
    expect(result.avgExitPrice).toBe(90);
    // pnl = (90-100)*10*(-1)*1 - 5 - 5 = 100 - 10 = 90
    expect(result.realizedPnl).toBe(90);
  });

  // 3. Long option — contractMultiplier = 100
  it('computes long option P&L (contractMultiplier = 100)', () => {
    const totals = aggregateFills([makeFill('entry', 2, 5, 5), makeFill('exit', 3, 5, 5)]);
    const result = computePnlFromTotals(totals, 'long', 'option', 2);

    expect(result.avgEntryPrice).toBe(2);
    expect(result.avgExitPrice).toBe(3);
    // pnl = (3-2)*5*1*100 - 5 - 5 = 500 - 10 = 490
    expect(result.realizedPnl).toBe(490);
  });

  // 4. Short option — both multipliers active
  it('computes short option P&L (both multipliers)', () => {
    const totals = aggregateFills([makeFill('entry', 3, 5, 5), makeFill('exit', 2, 5, 5)]);
    const result = computePnlFromTotals(totals, 'short', 'option', 2);

    // pnl = (2-3)*5*(-1)*100 - 5 - 5 = 500 - 10 = 490
    expect(result.realizedPnl).toBe(490);
  });

  // 5. Partial exit — fee allocation proportional
  it('allocates entry fees proportionally on partial exit', () => {
    const totals = aggregateFills([makeFill('entry', 100, 100, 10), makeFill('exit', 110, 60, 5)]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    expect(result.avgEntryPrice).toBe(100);
    expect(result.avgExitPrice).toBe(110);
    expect(result.totalEntryQuantity).toBe(100);
    expect(result.totalExitQuantity).toBe(60);
    // allocatedEntryFees = 10 * (60/100) = 6
    // pnl = (110-100)*60*1*1 - 5 - 6 = 600 - 11 = 589
    expect(result.realizedPnl).toBe(589);
  });

  // 6. Empty fills → all null/zero
  it('returns nulls/zeros when entryQty is zero (empty fills)', () => {
    const totals = aggregateFills([]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    expect(result.avgEntryPrice).toBeNull();
    expect(result.avgExitPrice).toBeNull();
    expect(result.totalEntryQuantity).toBe(0);
    expect(result.totalExitQuantity).toBe(0);
    expect(result.realizedPnl).toBeNull();
    expect(result.returnPercentage).toBeNull();
  });

  // 7. Entries only, no exits
  it('returns null for pnl/return when no exits', () => {
    const totals = aggregateFills([makeFill('entry', 50, 20, 3)]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    expect(result.avgEntryPrice).toBe(50);
    expect(result.avgExitPrice).toBeNull();
    expect(result.totalEntryQuantity).toBe(20);
    expect(result.totalExitQuantity).toBe(0);
    expect(result.realizedPnl).toBeNull();
    expect(result.returnPercentage).toBeNull();
  });

  // 8. Multiple fills — weighted average
  it('computes weighted average entry price from multiple fills', () => {
    const totals = aggregateFills([
      makeFill('entry', 100, 10, 0),
      makeFill('entry', 110, 20, 0),
      makeFill('entry', 120, 10, 0),
      makeFill('exit', 115, 40, 0),
    ]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    // weighted avg entry = (100*10 + 110*20 + 120*10) / 40 = 4400/40 = 110
    expect(result.avgEntryPrice).toBe(110);
    expect(result.avgExitPrice).toBe(115);
    // pnl = (115-110)*40 = 200, fees=0
    expect(result.realizedPnl).toBe(200);
  });

  // 9. Fee allocation rounding
  it('rounds allocated entry fees to currencyMinorUnits', () => {
    const totals: FillTotals = {
      entryQty: '3',
      exitQty: '2',
      entryCost: '300',
      exitCost: '220',
      entryFees: '1', // 1 * (2/3) = 0.6667 → rounds to 0.67
      exitFees: '0.5',
    };
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    // avgEntry = 100, avgExit = 110
    // allocatedEntryFees = round(1 * 2/3, 2) = 0.67
    // pnl = (110-100)*2 - 0.5 - 0.67 = 20 - 1.17 = 18.83
    expect(result.realizedPnl).toBe(18.83);
  });

  // 10. Zero fees
  it('computes P&L correctly with zero fees', () => {
    const totals = aggregateFills([makeFill('entry', 50, 10, 0), makeFill('exit', 60, 10, 0)]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    // pnl = (60-50)*10 - 0 - 0 = 100
    expect(result.realizedPnl).toBe(100);
  });

  // 11. JPY currency (0 minor units)
  it('rounds to 0 decimal places for JPY (currencyMinorUnits=0)', () => {
    const totals: FillTotals = {
      entryQty: '3',
      exitQty: '2',
      entryCost: '300',
      exitCost: '220',
      entryFees: '1', // allocated = round(1 * 2/3, 0) = round(0.6667, 0) = 1
      exitFees: '1',
    };
    const result = computePnlFromTotals(totals, 'long', 'stock', 0);

    // avgEntry = 100, avgExit = 110
    // allocatedEntryFees = round(0.6667, 0) = 1
    // pnl = round((110-100)*2 - 1 - 1, 0) = round(18, 0) = 18
    expect(result.realizedPnl).toBe(18);
  });

  // 12. IEEE 754 edge case
  it('handles IEEE 754 problematic values without floating point errors', () => {
    const totals = aggregateFills([
      makeFill('entry', '0.1', '10', '0'),
      makeFill('exit', '0.2', '10', '0'),
    ]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    expect(result.avgEntryPrice).toBe(0.1);
    expect(result.avgExitPrice).toBe(0.2);
    // pnl = (0.2-0.1)*10 = 1.00 exactly (not 0.9999999... or 1.0000001)
    expect(result.realizedPnl).toBe(1);
  });

  // Return percentage sanity checks
  it('computes return percentage for a long stock trade', () => {
    const totals = aggregateFills([makeFill('entry', 100, 10, 5), makeFill('exit', 110, 10, 5)]);
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    // denominator = 100*10*1 + 5 = 1005
    // returnPct = round(90/1005*100, 2) = round(8.9552..., 2) = 8.96
    expect(result.returnPercentage).toBe(8.96);
  });

  it('computes return percentage for a short stock trade', () => {
    const totals = aggregateFills([makeFill('entry', 100, 10, 5), makeFill('exit', 90, 10, 5)]);
    const result = computePnlFromTotals(totals, 'short', 'stock', 2);

    // denominator = 100*10*1 + 5 = 1005
    // returnPct = round(90/1005*100, 2) = 8.96
    expect(result.returnPercentage).toBe(8.96);
  });

  it('returns null returnPercentage when denominator is zero', () => {
    const totals: FillTotals = {
      entryQty: '10',
      exitQty: '10',
      entryCost: '0',
      exitCost: '0',
      entryFees: '0',
      exitFees: '0',
    };
    const result = computePnlFromTotals(totals, 'long', 'stock', 2);

    // avgEntryPrice=0, denominator = 0*10*1 + 0 = 0
    expect(result.returnPercentage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rounding regression: realizedPnl must round ONCE, at the end
// ---------------------------------------------------------------------------
//
// A refactor that computed `round(gross) − round(fees)` instead shifted the
// result by a minor unit. It survived the whole suite because every other case
// here uses figures with no sub-cent residue, and it reached CI green before
// being caught by hand. This is the counter-example.

describe('computePnlFromTotals — rounding', () => {
  // entry 1000 @ 100 (no fees); exit 1000 @ 100.100006 with 0.004 recorded fees.
  // gross unrounded = 100.006, fees = 0.004.
  //   round(100.006 − 0.004) = 100.00   ← correct, one rounding
  //   round(100.006) − round(0.004) = 100.01   ← the bug
  const totals = {
    entryQty: '1000',
    exitQty: '1000',
    entryCost: '100000',
    exitCost: '100100.006',
    entryFees: '0',
    exitFees: '0.004',
  };

  it('rounds once at the end, not per component', () => {
    const pnl = computePnlFromTotals(totals, 'long', 'stock', 2);
    expect(pnl.realizedPnl).toBe(100);
  });

  it('keeps grossPnl − fees === realizedPnl exactly', () => {
    const pnl = computePnlFromTotals(totals, 'long', 'stock', 2);
    // The breakdown absorbs the rounding residue so the invariant still holds:
    // gross rounds to 100.01, so fees must report 0.01 rather than 0.00.
    expect(pnl.grossPnl).toBe(100.01);
    expect(pnl.fees).toBe(0.01);
    expect(pnl.grossPnl! - pnl.fees!).toBeCloseTo(pnl.realizedPnl!, 10);
  });
});

// ---------------------------------------------------------------------------
// computeOpenCostBasis — the "position value" half of the cash/position split
// ---------------------------------------------------------------------------

describe('computeOpenCostBasis', () => {
  function totals(o: Partial<FillTotals>): FillTotals {
    return {
      entryQty: '0',
      exitQty: '0',
      entryCost: '0',
      exitCost: '0',
      entryFees: '0',
      exitFees: '0',
      ...o,
    };
  }

  it('is the full cost basis before any exit', () => {
    const t = totals({ entryQty: '10', entryCost: '1000' });
    expect(computeOpenCostBasis(t, 'long', 'stock', 2)).toBe(1000);
  });

  it('shrinks to the unexited portion after a partial exit', () => {
    const t = totals({ entryQty: '10', exitQty: '5', entryCost: '1000', exitCost: '550' });
    expect(computeOpenCostBasis(t, 'long', 'stock', 2)).toBe(500);
  });

  it('is zero once fully exited', () => {
    const t = totals({ entryQty: '10', exitQty: '10', entryCost: '1000', exitCost: '1100' });
    expect(computeOpenCostBasis(t, 'long', 'stock', 2)).toBe(0);
  });

  it('is zero for an entry-less position rather than dividing by zero', () => {
    expect(computeOpenCostBasis(totals({}), 'long', 'stock', 2)).toBe(0);
  });

  it('allocates entry fees by openQty / entryQty', () => {
    // $10 commission on 10 shares, half still open → $5 rides with the open half.
    const t = totals({
      entryQty: '10',
      exitQty: '5',
      entryCost: '1000',
      exitCost: '550',
      entryFees: '10',
    });
    expect(computeOpenCostBasis(t, 'long', 'stock', 2)).toBe(505);
  });

  it('complements the realized fee proration exactly — together they spend the fee once', () => {
    const t = totals({
      entryQty: '10',
      exitQty: '5',
      entryCost: '1000',
      exitCost: '550',
      entryFees: '10',
    });
    // computePnlFromTotals charged 10 × 5/10 = $5 against the realized half;
    // computeOpenCostBasis carries the other $5 on the open half.
    const realizedFeeShare = computeOpenCostBasis(t, 'long', 'stock', 2) - 500;
    const pnl = computePnlFromTotals(t, 'long', 'stock', 2);
    expect(realizedFeeShare).toBe(5);
    expect(pnl.grossPnl! - pnl.realizedPnl!).toBe(5);
    expect(realizedFeeShare + (pnl.grossPnl! - pnl.realizedPnl!)).toBe(10);
  });

  it('is NEGATIVE for a short — remaining proceeds are a liability', () => {
    // Short 10 @ $100, covered 5 @ $90. Five shares still owed.
    const t = totals({ entryQty: '10', exitQty: '5', entryCost: '1000', exitCost: '450' });
    expect(computeOpenCostBasis(t, 'short', 'stock', 2)).toBe(-500);
  });

  it('moves a short toward zero with its entry fee, not away from it', () => {
    // The fee is a cash outflow either way, so it always reduces the magnitude
    // of a short's negative position value.
    const t = totals({
      entryQty: '10',
      exitQty: '5',
      entryCost: '1000',
      exitCost: '450',
      entryFees: '10',
    });
    expect(computeOpenCostBasis(t, 'short', 'stock', 2)).toBe(-495);
  });

  it('applies the 100x contract multiplier for options', () => {
    // 2 contracts @ $3.00 = $600 of capital.
    const t = totals({ entryQty: '2', entryCost: '6' });
    expect(computeOpenCostBasis(t, 'long', 'option', 2)).toBe(600);
  });

  it('does NOT multiply fees by the contract multiplier', () => {
    // Fees are already absolute currency; only the price leg is per-contract.
    const t = totals({ entryQty: '2', entryCost: '6', entryFees: '1.30' });
    expect(computeOpenCostBasis(t, 'long', 'option', 2)).toBe(601.3);
  });

  it('rounds once at the end, not per component', () => {
    // Deployed capital 33.335 unrounded; fee share 0.005 unrounded.
    //   round(33.335 + 0.005) = 33.34   ← this expression
    //   round(33.335) + round(0.005) = 33.34 + 0.01 = 33.35   ← the bug
    const t = totals({ entryQty: '3', exitQty: '0', entryCost: '33.335', entryFees: '0.005' });
    expect(computeOpenCostBasis(t, 'long', 'stock', 2)).toBe(33.34);
  });

  it('honours zero-decimal currencies', () => {
    const t = totals({ entryQty: '10', entryCost: '1000.4' });
    expect(computeOpenCostBasis(t, 'long', 'stock', 0)).toBe(1000);
  });
});
