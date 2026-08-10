import { describe, it, expect } from 'vitest';

import { PerWidgetMinSize, WidgetTypeSchema } from '@tradr/shared';

import { GRID_COLUMNS, GRID_MAX_ROWS } from '../grid.constants';

import { widgetRegistry } from './registry';

describe('widgetRegistry', () => {
  it('covers exactly the WidgetTypeSchema enum (sort-safe equality)', () => {
    const fromSchema = [...WidgetTypeSchema.options].sort();
    const fromRegistry = [...Object.keys(widgetRegistry)].sort();
    expect(fromRegistry).toEqual(fromSchema);
  });

  it('defaultSize stays inside the bounds WidgetPlacementSchema enforces', () => {
    // `h <= 6` was the bound when a grid row was 80px tall. The row unit went to
    // 40px (Req 1.10) and GRID_MAX_ROWS doubled with it; this assertion was left
    // behind and only kept passing because no default had grown yet. It is the
    // schema's `h: 1..GRID_MAX_ROWS` that a default has to satisfy — a default
    // outside it would 400 on the first save.
    for (const def of Object.values(widgetRegistry)) {
      expect(def.defaultSize.w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(def.defaultSize.h).toBeLessThanOrEqual(GRID_MAX_ROWS);
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
