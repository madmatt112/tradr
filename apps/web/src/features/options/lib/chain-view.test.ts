// Unit tests for the chain ladder view-model. Pure — no rendering.
//
// The behaviour under test is what the previous flat list got wrong: it showed
// both sides interleaved, ordered from the lowest strike, capped at an
// arbitrary 400 rows, with no notion of where spot was. Every case below pins
// one half of that fix.

import { describe, expect, it } from 'vitest';

import type { OptionContract } from '../hooks/useOptionsChain';

import {
  buildChainWindow,
  DEFAULT_STRIKE_RADIUS,
  isInTheMoney,
  sideForDirection,
} from './chain-view';

/** A ladder of calls and puts at every strike, deliberately unordered. */
function ladder(from: number, to: number, step = 1): OptionContract[] {
  const rows: OptionContract[] = [];
  for (let strike = to; strike >= from; strike -= step) {
    rows.push({ option_type: 'put', strike, option_symbol: `X${strike}P` });
    rows.push({ option_type: 'call', strike, option_symbol: `X${strike}C` });
  }
  return rows;
}

describe('sideForDirection', () => {
  it('opens calls for a long and puts for a short', () => {
    expect(sideForDirection('long')).toBe('call');
    expect(sideForDirection('short')).toBe('put');
  });

  it('falls back to calls when the direction is unknown', () => {
    expect(sideForDirection(undefined)).toBe('call');
  });
});

describe('buildChainWindow', () => {
  it('keeps only the requested side, so a strike appears once', () => {
    const view = buildChainWindow(ladder(100, 110), 'call', 105, 50);
    expect(view.rows.every((r) => r.option_type === 'call')).toBe(true);
    expect(new Set(view.rows.map((r) => r.strike)).size).toBe(view.rows.length);
  });

  it('sorts ascending by strike regardless of upstream order', () => {
    const view = buildChainWindow(ladder(100, 105), 'call', 102, 50);
    const strikes = view.rows.map((r) => r.strike);
    expect(strikes).toEqual([...strikes].slice().sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  // The core fix: open where the money is, not at the bottom of the ladder.
  it('centres the window on the strike nearest spot', () => {
    const view = buildChainWindow(ladder(700, 800), 'call', 772, 2);
    expect(view.atmStrike).toBe(772);
    expect(view.rows.map((r) => r.strike)).toEqual([770, 771, 772, 773, 774]);
  });

  it('reports how many strikes it hid on each side', () => {
    const view = buildChainWindow(ladder(700, 800), 'call', 772, 2);
    // 101 strikes total; 5 shown, 70 below the window and 26 above.
    expect(view.hiddenBelow).toBe(70);
    expect(view.hiddenAbove).toBe(26);
    expect(view.hiddenBelow + view.rows.length + view.hiddenAbove).toBe(101);
  });

  it('widens symmetrically as the radius grows', () => {
    const narrow = buildChainWindow(ladder(700, 800), 'call', 772, 2);
    const wide = buildChainWindow(ladder(700, 800), 'call', 772, 10);
    expect(wide.rows.length).toBeGreaterThan(narrow.rows.length);
    expect(wide.atmStrike).toBe(narrow.atmStrike);
  });

  it('clamps the window at the ends of the ladder', () => {
    const view = buildChainWindow(ladder(100, 105), 'call', 100, 10);
    expect(view.hiddenBelow).toBe(0);
    expect(view.rows[0].strike).toBe(100);
  });

  // Guessing a midpoint would silently hide the strikes the user came for.
  it('returns the whole side unwindowed when spot is unknown', () => {
    const view = buildChainWindow(ladder(700, 800), 'call', undefined, 2);
    expect(view.rows).toHaveLength(101);
    expect(view.atmStrike).toBeUndefined();
    expect(view.hiddenBelow + view.hiddenAbove).toBe(0);
  });

  it('handles a side with no contracts', () => {
    const callsOnly = [{ option_type: 'call', strike: 100 }];
    const view = buildChainWindow(callsOnly, 'put', 100);
    expect(view.rows).toEqual([]);
  });

  it('defaults to a bounded radius rather than the whole ladder', () => {
    const view = buildChainWindow(ladder(600, 900), 'call', 772);
    expect(view.rows.length).toBe(DEFAULT_STRIKE_RADIUS * 2 + 1);
  });
});

describe('isInTheMoney', () => {
  it('is strike-below-spot for calls and strike-above-spot for puts', () => {
    expect(isInTheMoney({ strike: 770 }, 'call', 772)).toBe(true);
    expect(isInTheMoney({ strike: 775 }, 'call', 772)).toBe(false);
    expect(isInTheMoney({ strike: 775 }, 'put', 772)).toBe(true);
    expect(isInTheMoney({ strike: 770 }, 'put', 772)).toBe(false);
  });

  it('shades nothing when spot is unknown', () => {
    expect(isInTheMoney({ strike: 770 }, 'call', undefined)).toBe(false);
  });
});
