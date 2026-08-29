import { PerWidgetMinSize, reconcileStoredLayout, type WidgetPlacement } from '@tradr/shared';

import { GRID_COLUMNS, GRID_MAX_ROWS } from './grid.constants';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function sameGeometry(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

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
  for (let y = 0; y <= GRID_MAX_ROWS * 4; y++) {
    for (let x = 0; x + size.w <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w: size.w, h: size.h };
      if (!existing.some((p) => overlaps(candidate, p))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/** Reading order for the grid: top-to-bottom, then left-to-right. */
export function sortByYThenX(widgets: WidgetPlacement[]): WidgetPlacement[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The layout to SHOW while a transient item occupies the top-right `size`
 * block of the grid — the activation checklist's slot.
 *
 * The stored layout is left alone; this is a view of it. A widget that
 * overlaps the block gives way in one of two ways: if the part of it left of
 * the block is still a legal width for its type, it is narrowed to that part
 * (the default Stats Summary at `(0,0,12,6)` becomes `(0,0,8,6)`); otherwise
 * it moves down to the row under the block. Anything that then collides is
 * pushed down in reading order by the same reflow a stored layout gets on read,
 * so the result never overlaps. Widgets clear of the block keep their geometry.
 */
export function reserveTopRightSlot(
  widgets: WidgetPlacement[],
  size: { w: number; h: number },
): WidgetPlacement[] {
  const slot: Rect = { x: GRID_COLUMNS - size.w, y: 0, w: size.w, h: size.h };
  const moved = widgets.map((widget) => {
    if (!overlaps(widget, slot)) return widget;
    const keep = slot.x - widget.x;
    if (keep >= PerWidgetMinSize[widget.type].w) return { ...widget, w: keep };
    return { ...widget, y: slot.y + slot.h };
  });
  return reconcileStoredLayout(moved);
}

/**
 * The inverse, for the write path: a gesture on the grid reports EVERY item's
 * geometry, in the terms of the shown layout. A widget the gesture did not
 * move — one still exactly where `reserveTopRightSlot` put it — goes back to
 * its stored geometry, so the Stats Summary that was narrowed to make room is
 * not persisted narrow because the user dragged something else. A widget the
 * gesture did move (or push) keeps the geometry it was given. The reflow runs
 * once more because restored and moved geometry can, in principle, meet.
 */
export function keepStoredGeometry(
  next: WidgetPlacement[],
  shown: WidgetPlacement[],
  stored: WidgetPlacement[],
): WidgetPlacement[] {
  const shownById = new Map(shown.map((widget) => [widget.id, widget]));
  const storedById = new Map(stored.map((widget) => [widget.id, widget]));
  const merged = next.map((widget) => {
    const wasShown = shownById.get(widget.id);
    const wasStored = storedById.get(widget.id);
    if (!wasShown || !wasStored || !sameGeometry(widget, wasShown)) return widget;
    return { ...widget, x: wasStored.x, y: wasStored.y, w: wasStored.w, h: wasStored.h };
  });
  return reconcileStoredLayout(merged);
}
