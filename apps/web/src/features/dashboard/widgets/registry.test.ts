import { describe, it, expect } from 'vitest';

import { PerWidgetMinSize, WidgetTypeSchema } from '@tradr/shared';

import { widgetRegistry } from './registry';

describe('widgetRegistry', () => {
  it('covers exactly the WidgetTypeSchema enum (sort-safe equality)', () => {
    const fromSchema = [...WidgetTypeSchema.options].sort();
    const fromRegistry = [...Object.keys(widgetRegistry)].sort();
    expect(fromRegistry).toEqual(fromSchema);
  });

  it('defaultSize fits within the 12x6 grid for every entry', () => {
    for (const def of Object.values(widgetRegistry)) {
      expect(def.defaultSize.w).toBeLessThanOrEqual(12);
      expect(def.defaultSize.h).toBeLessThanOrEqual(6);
    }
  });

  it('minSize is no larger than defaultSize for every entry', () => {
    for (const def of Object.values(widgetRegistry)) {
      expect(def.minSize.w).toBeLessThanOrEqual(def.defaultSize.w);
      expect(def.minSize.h).toBeLessThanOrEqual(def.defaultSize.h);
    }
  });

  it('uses the canonical PerWidgetMinSize reference for every entry (§F)', () => {
    for (const type of WidgetTypeSchema.options) {
      expect(widgetRegistry[type].minSize).toBe(PerWidgetMinSize[type]);
    }
  });
});
