import Decimal from 'decimal.js';

import { parseOccSymbol } from '../options';

export const MAX_GROUP_LEGS = 8;

export type MaxLossReason = 'multiple_expiries' | 'unbounded' | 'nothing_open';

export type StrategyLabel =
  | 'BCS'
  | 'BeCS'
  | 'BPS'
  | 'BePS'
  | 'Calendar'
  | 'Straddle'
  | 'Strangle'
  | 'Iron condor'
  | 'Multi-leg';

export interface StrategyLeg {
  symbol: string;
  side: 'long' | 'short';
  assetType: 'stock' | 'option';
  entryQty: string;
  exitQty: string;
  entryCost: string;
  entryFees: string;
}

/**
 * The option contract multiplier: one contract covers 100 underlying shares.
 * A stock leg's multiplier is 1.
 */
const OPTION_MULTIPLIER = 100;

/**
 * A leg's underlying: the OCC `underlying` field for an option, or the
 * symbol itself for a stock. Null when an option leg's symbol does not
 * parse as OCC, so callers can treat it as a fault.
 */
export function legUnderlying(leg: Pick<StrategyLeg, 'symbol' | 'assetType'>): string | null {
  if (leg.assetType === 'stock') {
    return leg.symbol;
  }
  const parsed = parseOccSymbol(leg.symbol);
  return parsed.ok ? parsed.value.underlying : null;
}

interface ParsedLeg {
  side: 'long' | 'short';
  type: 'call' | 'put';
  expiration: string;
  strike: Decimal;
}

/** Parses every leg's OCC contract. Returns null if any leg fails to parse. */
function parseLegs(legs: StrategyLeg[]): ParsedLeg[] | null {
  const parsed: ParsedLeg[] = [];
  for (const leg of legs) {
    const result = parseOccSymbol(leg.symbol);
    if (!result.ok) return null;
    parsed.push({
      side: leg.side,
      type: result.value.type,
      expiration: result.value.expiration,
      strike: new Decimal(result.value.strike),
    });
  }
  return parsed;
}

/**
 * Two-leg vertical, calendar or straddle/strangle detection (requirements.md
 * Requirement 2, AC 2.1 table rows BCS/BeCS/BPS/BePS/Calendar/Straddle/Strangle).
 */
function detectTwoLegLabel(legs: ParsedLeg[]): StrategyLabel {
  const [a, b] = legs;

  if (a.type === b.type) {
    if (a.expiration === b.expiration) {
      if (a.strike.eq(b.strike)) return 'Multi-leg';
      const lower = a.strike.lt(b.strike) ? a : b;
      const higher = a.strike.lt(b.strike) ? b : a;
      if (a.type === 'call') {
        if (lower.side === 'long' && higher.side === 'short') return 'BCS';
        if (lower.side === 'short' && higher.side === 'long') return 'BeCS';
        return 'Multi-leg';
      }
      if (higher.side === 'short' && lower.side === 'long') return 'BPS';
      if (higher.side === 'long' && lower.side === 'short') return 'BePS';
      return 'Multi-leg';
    }
    // Same right, different expiries: a calendar needs the same strike and opposite sides.
    if (a.strike.eq(b.strike) && a.side !== b.side) return 'Calendar';
    return 'Multi-leg';
  }

  // One call, one put.
  if (a.expiration !== b.expiration || a.side !== b.side) return 'Multi-leg';
  if (a.strike.eq(b.strike)) return 'Straddle';
  const put = a.type === 'put' ? a : b;
  const call = a.type === 'call' ? a : b;
  return put.strike.lt(call.strike) ? 'Strangle' : 'Multi-leg';
}

/**
 * Iron condor: one long put, one short put, one short call and one long call,
 * one expiry, strikes strictly ascending in that order (requirements.md AC 2.1).
 */
function isIronCondor(legs: ParsedLeg[]): boolean {
  if (legs.some((leg) => leg.expiration !== legs[0].expiration)) return false;

  const longPut = legs.find((leg) => leg.type === 'put' && leg.side === 'long');
  const shortPut = legs.find((leg) => leg.type === 'put' && leg.side === 'short');
  const shortCall = legs.find((leg) => leg.type === 'call' && leg.side === 'short');
  const longCall = legs.find((leg) => leg.type === 'call' && leg.side === 'long');
  if (!longPut || !shortPut || !shortCall || !longCall) return false;
  if (new Set([longPut, shortPut, shortCall, longCall]).size !== 4) return false;

  return (
    longPut.strike.lt(shortPut.strike) &&
    shortPut.strike.lt(shortCall.strike) &&
    shortCall.strike.lt(longCall.strike)
  );
}

/**
 * Detects a group's strategy label from each leg's side, OCC contract and
 * total entry quantity only (design.md C2), so an exit never changes it
 * (requirements.md AC 2.2).
 */
export function detectStrategyLabel(legs: StrategyLeg[]): StrategyLabel {
  if (legs.some((leg) => leg.assetType === 'stock')) return 'Multi-leg';

  const entryQtys = legs.map((leg) => new Decimal(leg.entryQty));
  if (!entryQtys.every((qty) => qty.eq(entryQtys[0]))) return 'Multi-leg';

  const parsed = parseLegs(legs);
  if (!parsed) return 'Multi-leg';

  const underlyings = legs.map((leg) => legUnderlying(leg));
  if (underlyings.some((u) => u !== underlyings[0])) return 'Multi-leg';

  if (legs.length === 2) return detectTwoLegLabel(parsed);
  if (legs.length === 4) return isIronCondor(parsed) ? 'Iron condor' : 'Multi-leg';
  return 'Multi-leg';
}

/**
 * Validates a leg set: the first fault, by leg index, among a bad OCC
 * symbol, a repeated symbol, or an underlying that differs from leg 0
 * (design.md C2). Null when the set is valid.
 */
export function validateLegSet(
  legs: Pick<StrategyLeg, 'symbol' | 'assetType'>[],
): { index: number; message: string } | null {
  const seenSymbols = new Set<string>();
  let groupUnderlying: string | null = null;

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];

    if (leg.assetType === 'option' && !parseOccSymbol(leg.symbol).ok) {
      return { index, message: `Leg ${index + 1}'s symbol is not a valid OCC contract.` };
    }

    if (seenSymbols.has(leg.symbol)) {
      return { index, message: `Leg ${index + 1} repeats a symbol already in this group.` };
    }
    seenSymbols.add(leg.symbol);

    const underlying = legUnderlying(leg);
    if (index === 0) {
      groupUnderlying = underlying;
    } else if (underlying !== groupUnderlying) {
      return { index, message: `Leg ${index + 1}'s underlying differs from the group's.` };
    }
  }

  return null;
}

/**
 * Net entry: the sum over legs of side sign times entry cost times the
 * option multiplier (requirements.md AC 3.2). `entryCost` is already price
 * times quantity with no multiplier, so only the multiplier is applied here.
 * Positive is a net debit, negative a net credit.
 */
export function computeNetEntry(legs: StrategyLeg[], minorUnits: number): number {
  const total = legs.reduce((sum, leg) => {
    const sideSign = leg.side === 'long' ? 1 : -1;
    const multiplier = leg.assetType === 'option' ? OPTION_MULTIPLIER : 1;
    return sum.plus(new Decimal(leg.entryCost).times(sideSign).times(multiplier));
  }, new Decimal(0));

  return total.toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP).toNumber();
}

interface OpenLegFigure {
  side: 'long' | 'short';
  assetType: 'stock' | 'option';
  openUnits: Decimal;
  avgEntryPrice: Decimal;
  openFeeShare: Decimal;
  type: 'call' | 'put' | null;
  strike: Decimal | null;
  expiration: string | null;
}

function toOpenLegFigures(legs: StrategyLeg[]): OpenLegFigure[] {
  const figures: OpenLegFigure[] = [];

  for (const leg of legs) {
    const entryQty = new Decimal(leg.entryQty);
    const openUnits = entryQty.minus(leg.exitQty);
    if (!openUnits.gt(0)) continue;

    let type: 'call' | 'put' | null = null;
    let strike: Decimal | null = null;
    let expiration: string | null = null;
    if (leg.assetType === 'option') {
      const parsed = parseOccSymbol(leg.symbol);
      if (parsed.ok) {
        type = parsed.value.type;
        strike = new Decimal(parsed.value.strike);
        expiration = parsed.value.expiration;
      }
    }

    figures.push({
      side: leg.side,
      assetType: leg.assetType,
      openUnits,
      avgEntryPrice: new Decimal(leg.entryCost).div(entryQty),
      // The open portion's share of entry fees, the exact complement of the
      // exit-side proration `computePnlFromTotals` applies (pnl.ts:208-232).
      openFeeShare: new Decimal(leg.entryFees).times(openUnits).div(entryQty),
      type,
      strike,
      expiration,
    });
  }

  return figures;
}

/**
 * Total P&L of the open legs at a terminal underlying price `price`, over
 * open units at average entry price: for each leg, side sign times
 * (intrinsic value minus average entry price) times open units times the
 * multiplier, less the open share of entry fees.
 */
function pnlAtPrice(legs: OpenLegFigure[], price: Decimal): Decimal {
  return legs.reduce((sum, leg) => {
    const value =
      leg.type === 'call'
        ? Decimal.max(0, price.minus(leg.strike as Decimal))
        : leg.type === 'put'
          ? Decimal.max(0, (leg.strike as Decimal).minus(price))
          : price;
    const sideSign = leg.side === 'long' ? 1 : -1;
    const multiplier = leg.assetType === 'option' ? OPTION_MULTIPLIER : 1;
    return sum
      .plus(value.minus(leg.avgEntryPrice).times(sideSign).times(leg.openUnits).times(multiplier))
      .minus(leg.openFeeShare);
  }, new Decimal(0));
}

/**
 * Max loss for a group's open legs sharing one option expiry
 * (requirements.md AC 3.4, 3.5; design.md C2, D8). Evaluates total P&L at
 * price 0 and each open strike and returns `max(0, -lowest)`, rounded once.
 */
export function computeMaxLoss(
  legs: StrategyLeg[],
  minorUnits: number,
): { maxLoss: number | null; maxLossReason: MaxLossReason | null } {
  const openLegs = toOpenLegFigures(legs);
  if (openLegs.length === 0) {
    return { maxLoss: null, maxLossReason: 'nothing_open' };
  }

  const expirations = new Set(
    openLegs
      .map((leg) => leg.expiration)
      .filter((expiration): expiration is string => expiration !== null),
  );
  if (expirations.size > 1) {
    return { maxLoss: null, maxLossReason: 'multiple_expiries' };
  }

  // Unbounded on the upside when the group is net short deltas on stock and
  // calls: a short call or short stock position has no ceiling on the loss
  // as the underlying price rises without limit.
  const directionalUnits = openLegs.reduce((sum, leg) => {
    const sideSign = leg.side === 'long' ? 1 : -1;
    if (leg.assetType === 'stock') return sum.plus(leg.openUnits.times(sideSign));
    if (leg.type === 'call')
      return sum.plus(leg.openUnits.times(sideSign).times(OPTION_MULTIPLIER));
    return sum;
  }, new Decimal(0));
  if (directionalUnits.isNegative()) {
    return { maxLoss: null, maxLossReason: 'unbounded' };
  }

  const strikes = openLegs
    .map((leg) => leg.strike)
    .filter((strike): strike is Decimal => strike !== null);
  const prices = [new Decimal(0), ...strikes];

  let lowest = pnlAtPrice(openLegs, prices[0]);
  for (let i = 1; i < prices.length; i += 1) {
    const candidate = pnlAtPrice(openLegs, prices[i]);
    if (candidate.lt(lowest)) lowest = candidate;
  }

  const maxLoss = Decimal.max(0, lowest.negated())
    .toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP)
    .toNumber();

  return { maxLoss, maxLossReason: null };
}
