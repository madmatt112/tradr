import { describe, expect, it } from 'vitest';

import { DEFAULT_WIDGETS, type WidgetPlacement } from '@tradr/shared';

import { findFirstSlot, repackLayout, sortByYThenX } from './layout';

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

/** Mirrors `checkNoOverlap` from the PUT schema the server validates with. */
function hasOverlap(widgets: WidgetPlacement[]): boolean {
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i];
      const b = widgets[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        return true;
      }
    }
  }
  return false;
}

describe('repackLayout', () => {
  it('reproduces DEFAULT_WIDGETS geometry when packing them in their declared order', () => {
    // The shipped default layout IS a left-to-right top-to-bottom packing.
    // Pinning that keeps the packer and the seeded defaults from drifting.
    const shuffledOrigins = DEFAULT_WIDGETS.map((d, i) =>
      W({ id: `id-${i}`, type: d.type, x: 99, y: 99, w: d.w, h: d.h }),
    );
    const packed = repackLayout(shuffledOrigins);
    expect(packed.map((p) => ({ type: p.type, x: p.x, y: p.y, w: p.w, h: p.h }))).toEqual(
      DEFAULT_WIDGETS.map((d) => ({ type: d.type, x: d.x, y: d.y, w: d.w, h: d.h })),
    );
  });

  it('produces an overlap-free layout from mixed-size widgets in any order', () => {
    const mixed: WidgetPlacement[] = [
      W({ id: 'a', type: 'position-sizing', w: 6, h: 3 }),
      W({ id: 'b', type: 'stats-summary', w: 12, h: 1 }),
      W({ id: 'c', type: 'equity-curve', w: 6, h: 2 }),
      W({ id: 'd', type: 'open-positions', w: 12, h: 2 }),
    ];
    const packed = repackLayout(mixed);
    expect(hasOverlap(packed)).toBe(false);
    // Sizes are preserved — packing moves origins only.
    expect(packed.map((p) => ({ w: p.w, h: p.h }))).toEqual(mixed.map((p) => ({ w: p.w, h: p.h })));
    // Every placement stays inside the 12-column grid.
    for (const p of packed) {
      expect(p.x + p.w).toBeLessThanOrEqual(12);
    }
  });
});

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
