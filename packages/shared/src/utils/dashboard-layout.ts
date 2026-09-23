import {
  DEFAULT_WIDGETS,
  PRIOR_DEFAULT_LAYOUTS,
  WidgetDefaultSize,
} from '../constants/dashboard-defaults';
import {
  GRID_MAX_ROWS,
  PerWidgetMinSize,
  type WidgetPlacement,
  type WidgetType,
} from '../schemas/dashboard';

/** The grid the schema validates against: `x <= 11`, `w <= 12`, `x + w <= 12`. */
const GRID_COLUMNS = 12;

function overlaps(a: WidgetPlacement, b: WidgetPlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Bring a STORED layout up to the geometry the app enforces today.
 *
 * A saved row is written once and read forever; nothing revisits it. So a
 * widget-geometry fix — the row unit moving from 80px to 40px, the two chart
 * minimums being derived from the height their chart needs, the Stats Summary
 * tile grid being measured — lands in `WidgetDefaultSize` and `PerWidgetMinSize`
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
 * not merely raised to the minimum — a deliberate trade, not something
 * correctness forces. The heights being repaired were LEGAL CHOICES when they
 * were saved: the chart minimum was h=4 and Stats Summary's was h=2 until the
 * commit that added this derived them from what the widgets render, so a user
 * really could have picked one and meant it. What changed is that the app no
 * longer supports those heights — the widget cannot show its content at them,
 * and gridstack now carries the raised minimum as `minH`, so the user cannot
 * resize back to one either. Between preserving a height that is no longer
 * usable and handing the widget the size it would be given if it were placed
 * today, this prefers the usable widget. The pinned default is `WidgetDefaultSize`
 * for the type, clamped to `GRID_MAX_ROWS`; every type has one, so there is no
 * fallback. Clamping to the minimum instead would leave a Stats Summary saved at
 * h=2 clipping its figures for as long as the user never resized it, which is the
 * half of this defect that a write-path fix alone does not reach.
 *
 * Widths are clamped rather than replaced, because the horizontal axis has
 * never moved: a width below the minimum can only come from a hand-written API
 * payload, and widening interacts with the 12-column bound, so the conservative
 * repair (the minimum, shifted left only as far as it must be) is the right one.
 *
 * GROWING A WIDGET CAN PUSH IT INTO ITS NEIGHBOUR, and an overlapping layout
 * fails `checkNoOverlap` — swapping one 400 for another. So the second pass
 * re-flows `y`, moving a widget DOWN past anything it now collides with and
 * never up. Columns and widths come through untouched, and no widget ends up
 * higher than it was stored.
 *
 * RELATIVE STACKING ORDER IS PRESERVED. If one widget sat entirely above
 * another in the stored layout (`a.y + a.h <= b.y`), it still does in the
 * repaired one — for every such pair, whether or not they share columns. The
 * pass visits widgets in stored `(y, x, index)` order and floors each one below
 * every already-placed widget whose stored rectangle ended at or above its own
 * stored `y`; a later collision push only raises `y` further, so the order can
 * never invert. A pair that was side by side (neither entirely above the other)
 * carries no floor between them and stays free to keep its own rows.
 *
 * A layout that already satisfies all of this — nothing below a minimum, no
 * overlap, every above-pair still above — is returned unchanged: each widget
 * keeps its `y`, so the object comes back by reference and the function is
 * idempotent. Input types are unique, enforced by the PUT schema.
 */
export function reconcileStoredLayout(widgets: WidgetPlacement[]): WidgetPlacement[] {
  const repaired = widgets.map((widget) => {
    const min = PerWidgetMinSize[widget.type];
    if (!min) return widget;

    let { x, w, h } = widget;
    if (h < min.h) {
      h = Math.min(WidgetDefaultSize[widget.type].h, GRID_MAX_ROWS);
    }
    if (w < min.w) {
      w = Math.min(min.w, GRID_COLUMNS);
      x = Math.min(x, GRID_COLUMNS - w);
    }
    if (x === widget.x && w === widget.w && h === widget.h) return widget;
    return { ...widget, x, w, h };
  });

  // Visit widgets in stored reading order, carrying the original index so the
  // output keeps the order the caller gave — a read must not reshuffle the
  // response. `widgets` is the stored input; `out` is the result.
  const order = repaired
    .map((_widget, index) => index)
    .sort((a, b) => widgets[a].y - widgets[b].y || widgets[a].x - widgets[b].x || a - b);

  const out = new Array<WidgetPlacement>(repaired.length);
  const placed: number[] = [];
  for (const i of order) {
    const c = repaired[i];
    // Floor this widget below every placed widget that ended at or above its
    // stored top — the pairs that were entirely above it and must stay so.
    let floor = 0;
    for (const j of placed) {
      if (widgets[j].y + widgets[j].h <= widgets[i].y) {
        floor = Math.max(floor, out[j].y + out[j].h);
      }
    }
    let y = Math.max(c.y, floor);
    // Then push down past anything the repaired rectangle now collides with.
    // `y` only ever increases, so the loop terminates.
    for (;;) {
      const hit = placed.find((j) => overlaps(out[j], { ...c, y }));
      if (hit === undefined) break;
      y = out[hit].y + out[hit].h;
    }
    out[i] = y === c.y ? c : { ...c, y };
    placed.push(i);
  }
  return out;
}

type Geometry = { type: WidgetType; x: number; y: number; w: number; h: number };

function geometrySignature(list: readonly Geometry[]): string {
  return list
    .map((w) => `${w.type}:${w.x},${w.y},${w.w},${w.h}`)
    .sort()
    .join('|');
}

/**
 * True when a stored layout's geometry (its `{type, x, y, w, h}` set, ids and
 * config ignored) equals the current default or any past default. Such a layout
 * was never arranged, or was reset to a default, so it follows the default
 * forward instead of being reconciled.
 */
export function isDefaultGeometry(widgets: readonly WidgetPlacement[]): boolean {
  const target = geometrySignature(widgets);
  if (target === geometrySignature(DEFAULT_WIDGETS)) return true;
  return PRIOR_DEFAULT_LAYOUTS.some((layout) => target === geometrySignature(layout));
}

/**
 * Carry each stored widget's `config` onto the target layout by type, returning
 * new objects and never mutating `target` (the service caches it). Stored types
 * absent from `target` are ignored; target types with no stored config keep
 * whatever they had.
 */
export function carryConfig(
  target: readonly WidgetPlacement[],
  stored: readonly WidgetPlacement[],
): WidgetPlacement[] {
  const configByType = new Map<WidgetType, unknown>();
  for (const widget of stored) {
    if (widget.config !== undefined) configByType.set(widget.type, widget.config);
  }
  return target.map((widget) =>
    configByType.has(widget.type)
      ? { ...widget, config: configByType.get(widget.type) }
      : { ...widget },
  );
}
