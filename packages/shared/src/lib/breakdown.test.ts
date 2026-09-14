import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Tag } from '../schemas/tag';

import {
  UNTAGGED_KEY,
  WEEKDAY_LABELS,
  attributionParts,
  groupPositions,
  hourLabel,
  orderGroups,
  symbolKey,
  type BreakdownPosition,
} from './breakdown';
import { decimalSum } from './performance';

function bpos(overrides: Partial<BreakdownPosition> = {}): BreakdownPosition {
  const netPnl = overrides.netPnl ?? new Decimal(0);
  return {
    id: overrides.id ?? 'p',
    currency: overrides.currency ?? 'USD',
    netPnl,
    grossPnl: overrides.grossPnl ?? netPnl,
    fees: overrides.fees ?? new Decimal(0),
    closedAt: overrides.closedAt ?? new Date('2026-01-01T00:00:00Z'),
    classification: overrides.classification ?? 'breakeven',
    symbol: overrides.symbol ?? 'AAPL',
    assetType: overrides.assetType ?? 'stock',
    tags: overrides.tags ?? [],
  };
}

function tag(id: string, name: string): Tag {
  return { id, name, category: 'general', color: null };
}

// The DD1 probe instant: the demo NVDA exit, 2026-03-04T19:30Z.
const PROBE = new Date('2026-03-04T19:30:00.000Z');

describe('symbolKey', () => {
  it('keys a stock on the stored symbol', () => {
    expect(symbolKey({ symbol: 'AAPL', assetType: 'stock' })).toBe('AAPL');
  });

  it('keys an OCC option on the parsed underlying', () => {
    expect(symbolKey({ symbol: 'AAPL  240119C00150000', assetType: 'option' })).toBe('AAPL');
  });

  it('falls back to the stored symbol for an unparsable option symbol', () => {
    expect(symbolKey({ symbol: '123', assetType: 'option' })).toBe('123');
  });
});

describe('attributionParts', () => {
  it('reads UTC local fields', () => {
    expect(attributionParts(PROBE, 'UTC')).toEqual({ weekday: 3, hour: 19 });
  });

  it('reads Asia/Tokyo local fields', () => {
    expect(attributionParts(PROBE, 'Asia/Tokyo')).toEqual({ weekday: 4, hour: 4 });
  });

  it('reads America/New_York local fields', () => {
    expect(attributionParts(PROBE, 'America/New_York')).toEqual({ weekday: 3, hour: 14 });
  });
});

describe('hourLabel', () => {
  it('zero-pads the 24-hour start', () => {
    expect(hourLabel(0)).toBe('00:00');
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel(19)).toBe('19:00');
  });
});

describe('groupPositions', () => {
  it('symbol: one group per underlying, stock and option keys merge, label = key', () => {
    const positions = [
      bpos({ id: 'a', symbol: 'AAPL', assetType: 'stock', netPnl: new Decimal(10) }),
      bpos({ id: 'b', symbol: 'AAPL250320C150', assetType: 'option', netPnl: new Decimal(5) }),
      bpos({ id: 'c', symbol: 'MSFT', assetType: 'stock', netPnl: new Decimal(-3) }),
    ];
    const groups = groupPositions('symbol', positions, 'UTC', 0);
    expect(groups).toHaveLength(2);
    const aapl = groups.find((g) => g.key === 'AAPL')!;
    const msft = groups.find((g) => g.key === 'MSFT')!;
    expect(aapl.label).toBe('AAPL');
    expect(aapl.tag).toBeNull();
    expect(aapl.positions.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(msft.positions.map((p) => p.id)).toEqual(['c']);
  });

  it('weekday: seven rows in weekStartDay=0 (Sunday) order', () => {
    const groups = groupPositions('weekday', [bpos({ closedAt: PROBE })], 'UTC', 0);
    expect(groups.map((g) => g.key)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(groups.map((g) => g.label)).toEqual([...WEEKDAY_LABELS]);
    expect(groups.find((g) => g.key === '3')!.positions).toHaveLength(1);
    expect(groups.reduce((n, g) => n + g.positions.length, 0)).toBe(1);
  });

  it('weekday: seven rows rotated for weekStartDay=1 (Monday)', () => {
    const groups = groupPositions('weekday', [bpos({ closedAt: PROBE })], 'UTC', 1);
    expect(groups.map((g) => g.key)).toEqual(['1', '2', '3', '4', '5', '6', '0']);
    expect(groups.map((g) => g.label)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    expect(groups.find((g) => g.key === '3')!.positions).toHaveLength(1);
  });

  it('hour: twenty-four rows in order, position joins its zone-local hour', () => {
    const groups = groupPositions('hour', [bpos({ closedAt: PROBE })], 'UTC', 0);
    expect(groups).toHaveLength(24);
    expect(groups.map((g) => g.key)).toEqual(Array.from({ length: 24 }, (_, i) => String(i)));
    expect(groups[9]!.label).toBe('09:00');
    expect(groups[19]!.positions).toHaveLength(1);
    expect(groups.reduce((n, g) => n + g.positions.length, 0)).toBe(1);
  });

  it('tag: a two-tag position joins two groups, untagged holds the rest', () => {
    const t1 = tag('id-1', 'Breakout');
    const t2 = tag('id-2', 'FOMO');
    const groups = groupPositions(
      'tag',
      [
        bpos({ id: 'both', tags: [t1, t2] }),
        bpos({ id: 'one', tags: [t1] }),
        bpos({ id: 'none', tags: [] }),
      ],
      'UTC',
      0,
    );
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey['id-1']!.label).toBe('Breakout');
    expect(byKey['id-1']!.tag).toEqual(t1);
    expect(byKey['id-1']!.positions.map((p) => p.id).sort()).toEqual(['both', 'one']);
    expect(byKey['id-2']!.positions.map((p) => p.id)).toEqual(['both']);
    expect(byKey[UNTAGGED_KEY]!.label).toBe('Untagged');
    expect(byKey[UNTAGGED_KEY]!.tag).toBeNull();
    expect(byKey[UNTAGGED_KEY]!.positions.map((p) => p.id)).toEqual(['none']);
  });

  it('tag: the untagged group is always present, even empty', () => {
    const t1 = tag('id-1', 'Breakout');
    const groups = groupPositions('tag', [bpos({ id: 'one', tags: [t1] })], 'UTC', 0);
    const untagged = groups.find((g) => g.key === UNTAGGED_KEY)!;
    expect(untagged).toBeDefined();
    expect(untagged.positions).toHaveLength(0);
  });
});

describe('orderGroups', () => {
  it('symbol: net P&L descending, ties by key ascending', () => {
    const positions = [
      bpos({ id: 'z', symbol: 'ZZZ', netPnl: new Decimal(1) }),
      bpos({ id: 'a', symbol: 'AAA', netPnl: new Decimal(1) }),
      bpos({ id: 'm', symbol: 'MMM', netPnl: new Decimal(100) }),
      bpos({ id: 'l', symbol: 'LLL', netPnl: new Decimal(-50) }),
    ];
    const ordered = orderGroups('symbol', groupPositions('symbol', positions, 'UTC', 0));
    expect(ordered.map((g) => g.key)).toEqual(['MMM', 'AAA', 'ZZZ', 'LLL']);
  });

  it('tag: untagged is last even when its sum is the largest', () => {
    const t1 = tag('id-1', 'A');
    const ordered = orderGroups(
      'tag',
      groupPositions(
        'tag',
        [
          bpos({ id: 'x', tags: [t1], netPnl: new Decimal(-100) }),
          bpos({ id: 'u', tags: [], netPnl: new Decimal(500) }),
        ],
        'UTC',
        0,
      ),
    );
    expect(ordered[ordered.length - 1]!.key).toBe(UNTAGGED_KEY);
    expect(ordered[0]!.key).toBe('id-1');
  });

  it('weekday and hour keep the generated order', () => {
    const wd = groupPositions('weekday', [bpos({ closedAt: PROBE })], 'UTC', 1);
    expect(orderGroups('weekday', wd)).toBe(wd);
    const hr = groupPositions('hour', [bpos({ closedAt: PROBE })], 'UTC', 0);
    expect(orderGroups('hour', hr).map((g) => g.key)).toEqual(hr.map((g) => g.key));
  });
});

describe('groupPositions partition property', () => {
  const tagArb: fc.Arbitrary<Tag> = fc.record({
    id: fc.string({ minLength: 1, maxLength: 5 }),
    name: fc.string(),
    category: fc.constantFrom<Tag['category']>('setup', 'emotion', 'mistake', 'general'),
    color: fc.constantFrom<Tag['color']>(null, 'tag-1'),
  });

  const posArb = fc
    .record({
      id: fc.string(),
      symbol: fc.constantFrom('AAPL', 'MSFT', 'NVDA', 'AAPL250320C150', '123'),
      assetType: fc.constantFrom<BreakdownPosition['assetType']>('stock', 'option'),
      netPnl: fc.integer({ min: -1_000_000, max: 1_000_000 }).map((n) => new Decimal(n).div(100)),
      closedAt: fc.date({
        min: new Date('2000-01-01T00:00:00Z'),
        max: new Date('2035-01-01T00:00:00Z'),
        noInvalidDate: true,
      }),
      classification: fc.constantFrom<BreakdownPosition['classification']>(
        'winning',
        'losing',
        'breakeven',
      ),
      tags: fc.array(tagArb, { maxLength: 3 }),
    })
    .map(
      (r): BreakdownPosition => ({
        ...r,
        currency: 'USD',
        grossPnl: r.netPnl,
        fees: new Decimal(0),
      }),
    );

  it('single-valued dimensions partition any generated set by count and Decimal sum', () => {
    fc.assert(
      fc.property(
        fc.array(posArb, { maxLength: 40 }),
        fc.constantFrom('UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Apia'),
        fc.constantFrom(0 as const, 1 as const),
        (positions, tz, weekStartDay) => {
          const totalSum = decimalSum(positions.map((p) => p.netPnl));
          for (const by of ['symbol', 'weekday', 'hour'] as const) {
            const groups = groupPositions(by, positions, tz, weekStartDay);
            const count = groups.reduce((n, g) => n + g.positions.length, 0);
            expect(count).toBe(positions.length);
            const groupSum = decimalSum(
              groups.map((g) => decimalSum(g.positions.map((p) => p.netPnl))),
            );
            expect(groupSum.equals(totalSum)).toBe(true);
          }
          expect(groupPositions('weekday', positions, tz, weekStartDay)).toHaveLength(7);
          expect(groupPositions('hour', positions, tz, weekStartDay)).toHaveLength(24);
        },
      ),
    );
  });
});
