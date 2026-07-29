import { GRID_COLUMNS, GRID_MAX_ROWS } from './grid.constants';

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which edges of the widget the gesture moves. An edge handle sets one; a
 * corner handle sets two, which anchors the opposite corner because the edges
 * that aren't listed simply never move.
 */
export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/** Pixel distance from one cell origin to the next, gap included. */
export interface CellPitch {
  colSpanPx: number;
  rowSpanPx: number;
}

/**
 * Snaps a pixel delta to a whole number of cells, keeping the design's
 * **½-cell snap with a `hysteresisPx` deadband**: the gesture must cross the
 * half-cell line by at least `hysteresisPx` before the count changes,
 * otherwise it sticks at `currentCells`. That is what stops a widget flickering
 * between two spans when the pointer hovers exactly on a boundary.
 */
export function snapDeltaToCells(
  deltaPx: number,
  spanPx: number,
  currentCells: number,
  hysteresisPx: number,
): number {
  if (spanPx <= 0) return currentCells;
  const exact = deltaPx / spanPx;
  const candidate = Math.round(exact);
  if (candidate === currentCells) return currentCells;
  const hysteresisCells = hysteresisPx / spanPx;
  if (candidate > currentCells) {
    return exact >= currentCells + 0.5 + hysteresisCells ? candidate : currentCells;
  }
  return exact <= currentCells - 0.5 - hysteresisCells ? candidate : currentCells;
}

/**
 * Resolves a pointer drag on a resize handle into the widget's next grid rect.
 *
 * `start` is the rect when the gesture began and is what every delta is
 * measured from, so the result never drifts as the widget re-renders mid-drag.
 * `current` is the rect right now, used only as the hysteresis tie-break.
 *
 * Only the edges named in `edges` move; the others hold, which is what anchors
 * the opposite corner on a diagonal drag. The result is clamped so it always
 * satisfies `WidgetPlacementSchema`: inside the 12 columns, at most 6 rows, at
 * or above `minSize`, and never negative. Collision with other widgets is NOT
 * considered here — `applyResize` reflows them out of the way (Req 4.6.5).
 */
export function resolveResizeRect(
  start: GridRect,
  current: GridRect,
  deltaPx: { x: number; y: number },
  edges: ResizeEdges,
  pitch: CellPitch,
  minSize: { w: number; h: number },
  hysteresisPx: number,
): GridRect {
  let { x, y, w, h } = start;

  if (edges.right) {
    const dCols = snapDeltaToCells(deltaPx.x, pitch.colSpanPx, current.w - start.w, hysteresisPx);
    w = start.w + dCols;
    w = Math.max(minSize.w, Math.min(w, GRID_COLUMNS - x));
  }

  if (edges.left) {
    const dCols = snapDeltaToCells(deltaPx.x, pitch.colSpanPx, current.x - start.x, hysteresisPx);
    // The right edge is anchored, so x and w move together.
    const right = start.x + start.w;
    x = Math.min(Math.max(start.x + dCols, 0), right - minSize.w);
    w = right - x;
  }

  if (edges.bottom) {
    const dRows = snapDeltaToCells(deltaPx.y, pitch.rowSpanPx, current.h - start.h, hysteresisPx);
    h = Math.max(minSize.h, Math.min(start.h + dRows, GRID_MAX_ROWS));
  }

  if (edges.top) {
    const dRows = snapDeltaToCells(deltaPx.y, pitch.rowSpanPx, current.y - start.y, hysteresisPx);
    // The bottom edge is anchored. `y` cannot go negative, and cannot rise so
    // far that the widget would exceed the 6-row cap.
    const bottom = start.y + start.h;
    const lowestY = Math.max(0, bottom - GRID_MAX_ROWS);
    y = Math.min(Math.max(start.y + dRows, lowestY), bottom - minSize.h);
    h = bottom - y;
  }

  return { x, y, w, h };
}
