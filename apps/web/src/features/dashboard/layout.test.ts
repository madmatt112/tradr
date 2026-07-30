import { describe, expect, it } from 'vitest';

import { type WidgetPlacement } from '@tradr/shared';

import { findFirstSlot, sortByYThenX } from './layout';

const W = (over: Partial<WidgetPlacement>): WidgetPlacement =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'stats-summary',
    x: 0,
    y: 0,
    w: 4,
    h: 2,
    ...over,
  }) as WidgetPlacement;

describe('findFirstSlot', () => {
  it('returns the first gap in reading order rather than appending below', () => {
    const existing = [
      W({ id: 'a', x: 6, y: 0, w: 6, h: 2 }),
      W({ id: 'b', x: 0, y: 2, w: 12, h: 1 }),
    ];
    expect(findFirstSlot(existing, { w: 6, h: 2 })).toEqual({ x: 0, y: 0 });
  });
});

describe('sortByYThenX', () => {
  it('orders top-to-bottom then left-to-right without mutating the input', () => {
    const input = [
      W({ id: 'd', x: 6, y: 2 }),
      W({ id: 'b', x: 6, y: 0 }),
      W({ id: 'c', x: 0, y: 2 }),
      W({ id: 'a', x: 0, y: 0 }),
    ];
    expect(sortByYThenX(input).map((w) => w.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(input.map((w) => w.id)).toEqual(['d', 'b', 'c', 'a']);
  });
});
