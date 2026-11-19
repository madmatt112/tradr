import Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '../constants/currencies';

export interface UnrealisedInput {
  side: 'long' | 'short';
  openQty: number;
  openCostBasis: number;
  lastPrice: string;
  currency: string;
}

export interface UnrealisedResult {
  marketValue: number;
  unrealisedPnl: number;
  unrealisedPercent: number;
}

// marketValue = sideSign * lastPrice * openQty (no contract multiplier: stock rows only).
// unrealisedPnl = (marketValue - openCostBasis), rounded once half-up to the currency's
// minor units. unrealisedPercent divides that rounded pnl by |openCostBasis| * 100,
// rounded half-up to two places (design C5 / D9).
export function computeUnrealised(input: UnrealisedInput): UnrealisedResult | null {
  const { side, openQty, openCostBasis, lastPrice, currency } = input;
  if (openQty === 0 || openCostBasis === 0) return null;

  const sideSign = side === 'long' ? 1 : -1;
  const marketValue = new Decimal(lastPrice).times(openQty).times(sideSign);
  const minorUnits = getCurrencyMinorUnits(currency);
  const unrealisedPnl = marketValue
    .minus(new Decimal(String(openCostBasis)))
    .toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP);
  const unrealisedPercent = unrealisedPnl
    .div(new Decimal(String(openCostBasis)).abs())
    .times(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    marketValue: marketValue.toNumber(),
    unrealisedPnl: unrealisedPnl.toNumber(),
    unrealisedPercent: unrealisedPercent.toNumber(),
  };
}
