import type { WidgetPlacement } from '@tradr/shared';

import { GRID_COLUMNS, GRID_MAX_ROWS } from './grid.constants';

/**
 * Pure helper: left-to-right top-to-bottom packing.
 *
 * Scans cells row-by-row (y ascending) then column-by-column (x ascending)
 * and returns the first `(x, y)` where a rectangle of size `size` fits
 * without overlapping `existing`. Correct for n ≤ 6 widgets.
 */
export function findFirstSlot(
  existing: WidgetPlacement[],
  size: { w: number; h: number },
): { x: number; y: number } {
  function overlaps(x: number, y: number): boolean {
    for (const p of existing) {
      const a = { x, y, w: size.w, h: size.h };
      const overlapsX = a.x < p.x + p.w && p.x < a.x + a.w;
      const overlapsY = a.y < p.y + p.h && p.y < a.y + a.h;
      if (overlapsX && overlapsY) return true;
    }
    return false;
  }
  for (let y = 0; y <= GRID_MAX_ROWS * 4; y++) {
    for (let x = 0; x + size.w <= GRID_COLUMNS; x++) {
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/** Reading order for the grid: top-to-bottom, then left-to-right. */
export function sortByYThenX(widgets: WidgetPlacement[]): WidgetPlacement[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}
