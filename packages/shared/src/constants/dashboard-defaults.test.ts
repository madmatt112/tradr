import { describe, expect, it } from 'vitest';

import { PerWidgetMinSize, WidgetTypeSchema } from '../schemas/dashboard';

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
});
