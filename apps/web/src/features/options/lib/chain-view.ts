// Pure view-model for the options chain ladder.
//
// Brokers converge on the same two rules for presenting a chain, and the flat
// list this replaces broke both: one row per STRIKE (not per contract), and the
// view anchored on at-the-money rather than starting at the lowest strike. A
// liquid ticker has hundreds of strikes per expiry, and the interesting ones
// are the handful either side of spot; opening on deep-ITM calls and worthless
// puts means scrolling past everything that matters.
//
// Kept pure and separate from the component so the windowing is unit-testable
// without rendering.

import type { OptionContract } from '../hooks/useOptionsChain';

/** Which side of the chain is shown. The picker shows one side at a time. */
export type ChainSide = 'call' | 'put';

/** Strikes shown either side of at-the-money before "show more". */
export const DEFAULT_STRIKE_RADIUS = 10;

export interface ChainWindow {
  /** Contracts to render, ascending by strike. */
  rows: OptionContract[];
  /** The strike nearest spot, or undefined when spot is unknown. */
  atmStrike?: number;
  /** How many rows the window hides below / above, for the "show more" copy. */
  hiddenBelow: number;
  hiddenAbove: number;
}

/**
 * A trade direction maps to the side of the chain a user is shopping: a bullish
 * trade buys calls, a bearish one buys puts. The picker opens on that side
 * because the direction is already chosen upstream in the sizing widget — the
 * broker-standard both-sides layout answers a question this surface has already
 * asked. The toggle still allows the other side.
 */
export function sideForDirection(direction: string | undefined): ChainSide {
  return direction === 'short' ? 'put' : 'call';
}

/** Index of the strike closest to `spot`; ties resolve to the lower strike. */
function nearestIndex(rows: OptionContract[], spot: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  rows.forEach((row, i) => {
    const strike = row.strike;
    if (strike === undefined) return;
    const distance = Math.abs(strike - spot);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Take one side of the chain and return the rows to render around at-the-money.
 *
 * With no spot price the ladder cannot be anchored, so the whole side is
 * returned rather than an arbitrary slice — a wrong guess at "the middle" would
 * silently hide the strikes the user came for.
 */
export function buildChainWindow(
  contracts: OptionContract[],
  side: ChainSide,
  spot: number | undefined,
  radius: number = DEFAULT_STRIKE_RADIUS,
): ChainWindow {
  const rows = contracts
    .filter((c) => c.option_type === side)
    .slice()
    .sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));

  if (spot === undefined || rows.length === 0) {
    return { rows, hiddenBelow: 0, hiddenAbove: 0 };
  }

  const atm = nearestIndex(rows, spot);
  const start = Math.max(0, atm - radius);
  const end = Math.min(rows.length, atm + radius + 1);

  return {
    rows: rows.slice(start, end),
    atmStrike: rows[atm]?.strike,
    hiddenBelow: start,
    hiddenAbove: rows.length - end,
  };
}

/**
 * Is this contract in the money? Drives the row shading brokers use to make
 * the ITM/OTM boundary visible at a glance.
 */
export function isInTheMoney(
  contract: OptionContract,
  side: ChainSide,
  spot: number | undefined,
): boolean {
  if (spot === undefined || contract.strike === undefined) return false;
  return side === 'call' ? contract.strike < spot : contract.strike > spot;
}
