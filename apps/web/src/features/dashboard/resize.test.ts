import { describe, expect, it } from 'vitest';

import { GRID_MAX_ROWS } from './grid.constants';
import { resolveResizeRect, snapDeltaToCells, type GridRect } from './resize';

// Unit pitch: 100px per column, 80px per row, so a delta in pixels maps
// cleanly onto whole cells.
const PITCH = { colSpanPx: 100, rowSpanPx: 80 };
const MIN = { w: 2, h: 2 };
const start: GridRect = { x: 4, y: 2, w: 4, h: 3 };

function resize(
  edges: Parameters<typeof resolveResizeRect>[3],
  deltaPx: { x: number; y: number },
  current: GridRect = start,
): GridRect {
  return resolveResizeRect(start, current, deltaPx, edges, PITCH, MIN, 0);
}

describe('snapDeltaToCells', () => {
  it('holds inside the ½-cell deadband and switches once it is crossed', () => {
    // span 100px, currently +0 cells → the boundary sits at 50px, widened by
    // the 4px hysteresis to 54px.
    expect(snapDeltaToCells(45, 100, 0, 4)).toBe(0);
    expect(snapDeltaToCells(53, 100, 0, 4)).toBe(0);
    expect(snapDeltaToCells(56, 100, 0, 4)).toBe(1);
    // Symmetric on the way back down.
    expect(snapDeltaToCells(-56, 100, 0, 4)).toBe(-1);
  });

  it('is a no-op for a non-positive span', () => {
    expect(snapDeltaToCells(500, 0, 3, 0)).toBe(3);
  });
});

describe('resolveResizeRect — edges move independently', () => {
  it('right edge changes width only, origin anchored', () => {
    expect(resize({ right: true }, { x: 200, y: 500 })).toEqual({
      x: 4,
      y: 2,
      w: 6,
      h: 3,
    });
  });

  it('bottom edge changes height only, origin anchored', () => {
    expect(resize({ bottom: true }, { x: 500, y: 80 })).toEqual({
      x: 4,
      y: 2,
      w: 4,
      h: 4,
    });
  });

  it('left edge moves the origin and keeps the right edge anchored', () => {
    const next = resize({ left: true }, { x: -200, y: 0 });
    expect(next).toEqual({ x: 2, y: 2, w: 6, h: 3 });
    // Right edge is exactly where it started.
    expect(next.x + next.w).toBe(start.x + start.w);
  });
});

describe('resolveResizeRect — corners anchor the opposite corner', () => {
  it('top-left drag anchors the bottom-right corner', () => {
    const next = resize({ top: true, left: true }, { x: -200, y: -80 });
    expect(next).toEqual({ x: 2, y: 1, w: 6, h: 4 });
    expect(next.x + next.w).toBe(start.x + start.w);
    expect(next.y + next.h).toBe(start.y + start.h);
  });

  it('bottom-right drag anchors the top-left corner', () => {
    const next = resize({ bottom: true, right: true }, { x: 100, y: 80 });
    expect(next).toEqual({ x: 4, y: 2, w: 5, h: 4 });
    expect(next.x).toBe(start.x);
    expect(next.y).toBe(start.y);
  });

  it('top-right drag anchors the bottom-left corner', () => {
    const next = resize({ top: true, right: true }, { x: 100, y: -80 });
    expect(next).toEqual({ x: 4, y: 1, w: 5, h: 4 });
    expect(next.x).toBe(start.x);
    expect(next.y + next.h).toBe(start.y + start.h);
  });
});

describe('resolveResizeRect — clamps to what the schema accepts', () => {
  it('stops the right edge at the 12-column bound', () => {
    expect(resize({ right: true }, { x: 5000, y: 0 }).w).toBe(12 - start.x);
  });

  it('stops the left edge at column 0 and never inverts the rect', () => {
    const next = resize({ left: true }, { x: -5000, y: 0 });
    expect(next.x).toBe(0);
    expect(next.x + next.w).toBe(start.x + start.w);
  });

  it('holds the minimum width when the left edge is dragged inward', () => {
    const next = resize({ left: true }, { x: 5000, y: 0 });
    expect(next.w).toBe(MIN.w);
    expect(next.x + next.w).toBe(start.x + start.w);
  });

  it('caps height at GRID_MAX_ROWS', () => {
    // The bound tracks the schema, which moved with the row unit (80px -> 40px,
    // Req 1.10) so the reachable pixel height is unchanged.
    expect(resize({ bottom: true }, { x: 0, y: 5000 }).h).toBe(GRID_MAX_ROWS);
  });

  it('never lets a top-edge drag push y negative', () => {
    const next = resize({ top: true }, { x: 0, y: -5000 });
    expect(next.y).toBe(0);
    expect(next.h).toBeLessThanOrEqual(6);
    expect(next.y + next.h).toBe(start.y + start.h);
  });

  it('holds the minimum height when the bottom edge is dragged inward', () => {
    expect(resize({ bottom: true }, { x: 0, y: -5000 }).h).toBe(MIN.h);
  });
});
