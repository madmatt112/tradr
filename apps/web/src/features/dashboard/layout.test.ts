import { describe, expect, it } from 'vitest';

import { DEFAULT_WIDGETS, PerWidgetMinSize, type WidgetPlacement } from '@tradr/shared';

import { findFirstSlot, keepStoredGeometry, reserveTopRightSlot, sortByYThenX } from './layout';

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

// ---------------------------------------------------------------------------
// The transient top-right slot (the activation checklist's grid item).
// ---------------------------------------------------------------------------

const STATS_MIN_W = PerWidgetMinSize['stats-summary'].w;

describe('reserveTopRightSlot', () => {
  const slot = { w: 4, h: 6 };

  it('narrows a widget that straddles the slot when the part left of it is a legal width', () => {
    // The default Stats Summary: full width on the top row.
    const shown = reserveTopRightSlot([W({ id: 'a', x: 0, y: 0, w: 12, h: 6 })], slot);
    expect(shown).toEqual([W({ id: 'a', x: 0, y: 0, w: 8, h: 6 })]);
  });

  it('moves a widget below the slot when narrowing would take it under its minimum', () => {
    // Anchored at x=6, only two columns would survive — fewer than the type's minimum.
    expect(STATS_MIN_W).toBeGreaterThan(2);
    const shown = reserveTopRightSlot([W({ id: 'a', x: 6, y: 0, w: 6, h: 6 })], slot);
    expect(shown).toEqual([W({ id: 'a', x: 6, y: 6, w: 6, h: 6 })]);
  });

  it('moves a widget wholly inside the slot below it', () => {
    const shown = reserveTopRightSlot(
      [W({ id: 'a', type: 'account-balances', x: 8, y: 2, w: 4, h: 4 })],
      slot,
    );
    expect(shown[0]).toMatchObject({ x: 8, y: 6, w: 4, h: 4 });
  });

  it('pushes whatever a moved widget lands on further down, so nothing overlaps', () => {
    const shown = reserveTopRightSlot(
      [
        W({ id: 'a', type: 'account-balances', x: 8, y: 0, w: 4, h: 4 }),
        W({ id: 'b', type: 'position-sizing', x: 8, y: 6, w: 4, h: 6 }),
      ],
      slot,
    );
    expect(shown.find((w) => w.id === 'a')).toMatchObject({ x: 8, y: 6 });
    expect(shown.find((w) => w.id === 'b')).toMatchObject({ x: 8, y: 10 });
  });

  it('leaves widgets clear of the slot exactly as stored, by reference', () => {
    const left = W({ id: 'a', x: 0, y: 0, w: 8, h: 6 });
    const below = W({ id: 'b', type: 'account-balances', x: 8, y: 6, w: 4, h: 12 });
    const shown = reserveTopRightSlot([left, below], slot);
    expect(shown[0]).toBe(left);
    expect(shown[1]).toBe(below);
  });

  it('reflows the default layout to Stats Summary at eight columns and nothing else moved', () => {
    const stored = DEFAULT_WIDGETS.map((d, i) => W({ ...d, id: `w${i}` }));
    const shown = reserveTopRightSlot(stored, slot);
    expect(shown[0]).toMatchObject({ type: 'stats-summary', x: 0, y: 0, w: 8, h: 6 });
    expect(shown.slice(1)).toEqual(stored.slice(1));
  });
});

describe('keepStoredGeometry', () => {
  const stored = [
    W({ id: 'a', x: 0, y: 0, w: 12, h: 6 }),
    W({ id: 'b', type: 'performance-chart', x: 0, y: 6, w: 8, h: 12 }),
  ];
  const shown = reserveTopRightSlot(stored, { w: 4, h: 6 });

  it('restores the stored geometry of a widget the gesture left where it was shown', () => {
    // The user dragged `b` down; `a` still sits narrowed where the slot put it.
    const next = [{ ...shown[0] }, { ...shown[1], y: 20 }];
    const kept = keepStoredGeometry(next, shown, stored);
    expect(kept.find((w) => w.id === 'a')).toMatchObject({ x: 0, y: 0, w: 12, h: 6 });
    expect(kept.find((w) => w.id === 'b')).toMatchObject({ x: 0, y: 20, w: 8, h: 12 });
  });

  it('keeps the new geometry of a widget the gesture moved, narrowed or not', () => {
    const next = [{ ...shown[0], y: 1 }, { ...shown[1] }];
    const kept = keepStoredGeometry(next, shown, stored);
    // Moved one row: it stays eight columns wide, where the user put it…
    expect(kept.find((w) => w.id === 'a')).toMatchObject({ x: 0, y: 1, w: 8, h: 6 });
    // …and `b`, restored to its stored row, is pushed clear of it rather than
    // left overlapping.
    expect(kept.find((w) => w.id === 'b')).toMatchObject({ x: 0, y: 7, w: 8, h: 12 });
  });

  it('is the identity when nothing was shown differently', () => {
    expect(keepStoredGeometry(stored, stored, stored)).toEqual(stored);
  });
});
