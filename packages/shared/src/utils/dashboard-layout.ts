import { DEFAULT_WIDGETS } from '../constants/dashboard-defaults';
import { GRID_MAX_ROWS, PerWidgetMinSize, type WidgetPlacement } from '../schemas/dashboard';

/** The grid the schema validates against: `x <= 11`, `w <= 12`, `x + w <= 12`. */
const GRID_COLUMNS = 12;

const PinnedHeight = new Map(DEFAULT_WIDGETS.map((widget) => [widget.type, widget.h]));

function overlaps(a: WidgetPlacement, b: WidgetPlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Bring a STORED layout up to the geometry the app enforces today.
 *
 * A saved row is written once and read forever; nothing revisits it. So a
 * widget-geometry fix — the row unit moving from 80px to 40px, the two chart
 * minimums being derived from the height their chart needs, the Stats Summary
 * tile grid being measured — lands in `DEFAULT_WIDGETS` and `PerWidgetMinSize`
 * and reaches only the users who have never arranged their dashboard. Everyone
 * else keeps geometry that was legal when they saved it and is not legal now:
 * the layout still READS (nothing parses the GET response, and gridstack clamps
 * on render), but the next write that does not come from a drag or a resize —
 * an add, a remove, a timeframe change — sends that stale geometry back from
 * React state, fails `WidgetPlacementSchema`, and 400s with a Retry that can
 * only ever re-send the same body.
 *
 * This is the reconciliation, applied wherever a stored layout is read.
 *
 * A HEIGHT BELOW THE TYPE'S MINIMUM IS REPAIRED TO THE TYPE'S PINNED DEFAULT,
 * not merely raised to the minimum. The minimum is the floor the UI itself
 * enforces — gridstack carries it as `minH` and will not resize past it — so a
 * stored height below it cannot be something a user chose. It can only be
 * geometry from an older bound, and the honest repair for that is the height
 * the widget would be given if it were placed today. Clamping to the minimum
 * instead would leave a Stats Summary saved at h=2 clipping its figures for as
 * long as the user never resized it, which is the half of this defect that a
 * write-path fix alone does not reach.
 *
 * Widths are clamped rather than replaced, because the horizontal axis has
 * never moved: a width below the minimum can only come from a hand-written API
 * payload, and widening interacts with the 12-column bound, so the conservative
 * repair (the minimum, shifted left only as far as it must be) is the right one.
 *
 * GROWING A WIDGET CAN PUSH IT INTO ITS NEIGHBOUR, and an overlapping layout
 * fails `checkNoOverlap` — swapping one 400 for another. So the second pass
 * re-flows `y` in reading order, moving a widget DOWN past anything it now
 * collides with and never up. Relative order, columns and widths are preserved,
 * which is what makes the repaired layout still recognisably the user's.
 *
 * A layout that is already current is returned unchanged: nothing is below a
 * minimum, so nothing grows, so no widget collides with one already placed.
 */
export function reconcileStoredLayout(widgets: WidgetPlacement[]): WidgetPlacement[] {
  const repaired = widgets.map((widget) => {
    const min = PerWidgetMinSize[widget.type];
    if (!min) return widget;

    let { x, w, h } = widget;
    if (h < min.h) {
      h = Math.min(PinnedHeight.get(widget.type) ?? min.h, GRID_MAX_ROWS);
    }
    if (w < min.w) {
      w = Math.min(min.w, GRID_COLUMNS);
      x = Math.min(x, GRID_COLUMNS - w);
    }
    if (x === widget.x && w === widget.w && h === widget.h) return widget;
    return { ...widget, x, w, h };
  });

  // Reading order, with the original index carried so the output keeps the
  // order the caller gave — a read must not reshuffle the response.
  const order = repaired
    .map((widget, index) => ({ widget, index }))
    .sort((a, b) => a.widget.y - b.widget.y || a.widget.x - b.widget.x || a.index - b.index);

  const out: WidgetPlacement[] = new Array<WidgetPlacement>(repaired.length);
  const placed: WidgetPlacement[] = [];
  for (const { widget, index } of order) {
    let candidate = widget;
    // Each hit sits at or above `candidate`, so `hit.y + hit.h` is strictly
    // below where it started: `y` only ever increases and the loop terminates.
    for (;;) {
      const hit = placed.find((other) => overlaps(other, candidate));
      if (!hit) break;
      candidate = { ...candidate, y: hit.y + hit.h };
    }
    placed.push(candidate);
    out[index] = candidate;
  }
  return out;
}
