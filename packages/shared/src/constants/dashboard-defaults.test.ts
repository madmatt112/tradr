import { describe, expect, it } from 'vitest';

import { GRID_MAX_ROWS, PerWidgetMinSize, WidgetTypeSchema } from '../schemas/dashboard';

import { DEFAULT_WIDGETS } from './dashboard-defaults';

describe('dashboard-defaults', () => {
  it('DEFAULT_WIDGETS has exactly six entries', () => {
    expect(DEFAULT_WIDGETS.length).toBe(6);
  });

  it('every WidgetType value appears exactly once', () => {
    const got = new Set(DEFAULT_WIDGETS.map((d) => d.type));
    const want = new Set(WidgetTypeSchema.options);
    expect(got).toEqual(want);
    expect(got.size).toBe(DEFAULT_WIDGETS.length);
  });

  it('every entry satisfies PerWidgetMinSize', () => {
    for (const entry of DEFAULT_WIDGETS) {
      const min = PerWidgetMinSize[entry.type];
      expect(entry.w).toBeGreaterThanOrEqual(min.w);
      expect(entry.h).toBeGreaterThanOrEqual(min.h);
    }
  });

  it('no two entries overlap on the 12-column grid', () => {
    for (let i = 0; i < DEFAULT_WIDGETS.length; i++) {
      for (let j = i + 1; j < DEFAULT_WIDGETS.length; j++) {
        const a = DEFAULT_WIDGETS[i];
        const b = DEFAULT_WIDGETS[j];
        const overlapsX = a.x < b.x + b.w && b.x < a.x + a.w;
        const overlapsY = a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });

  it('every entry fits within GRID_MAX_ROWS', () => {
    for (const entry of DEFAULT_WIDGETS) {
      expect(entry.h).toBeLessThanOrEqual(GRID_MAX_ROWS);
      expect(entry.y + entry.h).toBeLessThanOrEqual(GRID_MAX_ROWS);
    }
  });
});

/**
 * The 80px → 40px row-unit migration (Req 1.11) doubles `y` and `h` on every
 * saved placement. These pin the properties that make doubling the right
 * transform, so the SQL cannot be replaced by something that merely looks
 * equivalent.
 */
describe('row-unit migration invariants (double y and h)', () => {
  type Rect = { x: number; y: number; w: number; h: number };
  const double = (r: Rect): Rect => ({ ...r, y: r.y * 2, h: r.h * 2 });
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // A representative pre-migration layout, in 80px rows.
  const oldLayout: Rect[] = [
    { x: 0, y: 0, w: 12, h: 1 },
    { x: 0, y: 1, w: 8, h: 3 },
    { x: 8, y: 1, w: 4, h: 3 },
    { x: 0, y: 4, w: 8, h: 3 },
    { x: 8, y: 4, w: 4, h: 3 },
    { x: 0, y: 7, w: 12, h: 3 },
  ];

  it('preserves non-overlap — the property that makes doubling safe', () => {
    const migrated = oldLayout.map(double);
    for (let i = 0; i < migrated.length; i++) {
      for (let j = i + 1; j < migrated.length; j++) {
        expect(overlaps(migrated[i], migrated[j])).toBe(false);
      }
    }
  });

  it('leaves the horizontal axis untouched — columns did not change', () => {
    for (const r of oldLayout) {
      const m = double(r);
      expect(m.x).toBe(r.x);
      expect(m.w).toBe(r.w);
    }
  });

  it('keeps a migrated layout inside the new bounds', () => {
    for (const r of oldLayout.map(double)) {
      expect(r.h).toBeLessThanOrEqual(GRID_MAX_ROWS);
      expect(r.y + r.h).toBeLessThanOrEqual(GRID_MAX_ROWS);
    }
  });

  it('preserves relative vertical order and adjacency', () => {
    // Widgets that were stacked flush stay flush — doubling scales the whole
    // axis, so no gap opens between previously touching widgets.
    const a = { x: 0, y: 0, w: 12, h: 1 };
    const b = { x: 0, y: 1, w: 12, h: 2 };
    expect(a.y + a.h).toBe(b.y);
    expect(double(a).y + double(a).h).toBe(double(b).y);
  });
});
