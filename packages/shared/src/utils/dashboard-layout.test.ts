import { describe, expect, it } from 'vitest';

import { DEFAULT_WIDGETS } from '../constants/dashboard-defaults';
import {
  PerWidgetMinSize,
  PutDashboardLayoutRequestSchema,
  type WidgetPlacement,
  type WidgetType,
} from '../schemas/dashboard';

import { reconcileStoredLayout } from './dashboard-layout';

const ID = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;

function pinned(type: WidgetType): number {
  return DEFAULT_WIDGETS.find((widget) => widget.type === type)!.h;
}

/**
 * A layout as it sits in the database for anyone who arranged their dashboard
 * before the geometry was fixed. Every height here was legal when it was
 * written: `stats-summary` at h=1 and both charts at h=2 in the 80px era,
 * doubled to 2 and 4 by migration 0021, with the charts landing exactly on the
 * h=4 minimum they had before it was derived from the height a chart needs.
 */
function staleLayout(): WidgetPlacement[] {
  return [
    { id: ID(1), type: 'stats-summary', x: 0, y: 0, w: 12, h: 2 },
    { id: ID(2), type: 'performance-chart', x: 0, y: 2, w: 8, h: 4 },
    { id: ID(3), type: 'account-balances', x: 8, y: 2, w: 4, h: 4 },
    { id: ID(4), type: 'equity-curve', x: 0, y: 6, w: 8, h: 4 },
    { id: ID(5), type: 'position-sizing', x: 8, y: 6, w: 4, h: 6 },
    { id: ID(6), type: 'open-positions', x: 0, y: 12, w: 12, h: 4 },
  ];
}

function currentLayout(): WidgetPlacement[] {
  return DEFAULT_WIDGETS.map((widget, i) => ({ id: ID(i + 1), ...widget }));
}

function anyOverlap(widgets: WidgetPlacement[]): boolean {
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i];
      const b = widgets[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
}

describe('reconcileStoredLayout', () => {
  // THE WHOLE POINT, in one assertion: the geometry a stale row hands back is
  // geometry the user can save. Every non-drag edit — add, remove, timeframe —
  // PUTs the layout it was given, so a response that does not satisfy this is a
  // 400 the user cannot clear (the Retry re-sends the same body).
  it('produces a layout the write schema accepts, from one it rejects', () => {
    const stale = staleLayout();
    expect(PutDashboardLayoutRequestSchema.safeParse({ widgets: stale }).success).toBe(false);
    expect(
      PutDashboardLayoutRequestSchema.safeParse({ widgets: reconcileStoredLayout(stale) }).success,
    ).toBe(true);
  });

  it('removing a widget from the reconciled layout still validates', () => {
    // The add/remove path: the client filters the layout it was given and PUTs
    // the rest. Nothing about dropping a widget can reintroduce a bad height,
    // but this is the exact payload the defect 400d on.
    const widgets = reconcileStoredLayout(staleLayout()).filter(
      (widget) => widget.type !== 'open-positions',
    );
    expect(PutDashboardLayoutRequestSchema.safeParse({ widgets }).success).toBe(true);
  });

  it('gives a widget below its minimum the pinned default height, not the minimum', () => {
    const out = reconcileStoredLayout(staleLayout());
    const heightOf = (type: WidgetType): number => out.find((w) => w.type === type)!.h;

    // The half a write-path clamp does not reach: `stats-summary` was saved at
    // a height that is legal-looking but clips its figures, and only the pinned
    // default fits what it renders in both tier states.
    expect(heightOf('stats-summary')).toBe(pinned('stats-summary'));
    expect(heightOf('performance-chart')).toBe(pinned('performance-chart'));
    expect(heightOf('equity-curve')).toBe(pinned('equity-curve'));
    // …and the default is above the minimum, so the repaired layout is not
    // sitting on the bound it just failed.
    expect(heightOf('performance-chart')).toBeGreaterThan(PerWidgetMinSize['performance-chart'].h);
  });

  it('re-flows y so growing a widget does not overlap its neighbour', () => {
    const stale = staleLayout();
    expect(anyOverlap(stale)).toBe(false);
    const out = reconcileStoredLayout(stale);
    expect(anyOverlap(out)).toBe(false);
    // Stacking order survives, which is what makes the repaired layout still
    // recognisably theirs. Not whole-page reading order — the two columns grow
    // by different amounts (the charts are on the left, the short rail widgets
    // on the right), so rows that used to align no longer do. What holds is the
    // order of any two widgets that share columns: one was above the other and
    // still is.
    for (const a of stale) {
      for (const b of stale) {
        if (a.id === b.id) continue;
        const sharesColumns = a.x < b.x + b.w && b.x < a.x + a.w;
        if (!sharesColumns || a.y >= b.y) continue;
        const outA = out.find((w) => w.id === a.id)!;
        const outB = out.find((w) => w.id === b.id)!;
        expect(outA.y).toBeLessThan(outB.y);
      }
    }
    // And so does the horizontal axis — columns never moved.
    for (const widget of out) {
      const before = stale.find((w) => w.id === widget.id)!;
      expect({ x: widget.x, w: widget.w }).toEqual({ x: before.x, w: before.w });
    }
  });

  it('returns the widgets in the order it was given', () => {
    const stale = staleLayout();
    expect(reconcileStoredLayout(stale).map((w) => w.id)).toEqual(stale.map((w) => w.id));
  });

  it('leaves a current layout untouched', () => {
    // Reconciliation runs on every read, so a layout that is already legal must
    // come back byte-identical — otherwise it rearranges dashboards nobody
    // asked it to.
    const current = currentLayout();
    expect(reconcileStoredLayout(current)).toEqual(current);
  });

  it('leaves a deliberately resized widget alone above its minimum', () => {
    // A user who shrank Stats Summary to its minimum chose that. Only heights
    // BELOW the minimum — which the UI cannot produce — are repaired.
    const min = PerWidgetMinSize['stats-summary'].h;
    const widgets: WidgetPlacement[] = [
      { id: ID(1), type: 'stats-summary', x: 0, y: 0, w: 12, h: min },
    ];
    expect(reconcileStoredLayout(widgets)[0].h).toBe(min);
  });

  it('clamps a width below the minimum and shifts x back inside the grid', () => {
    const widgets: WidgetPlacement[] = [
      { id: ID(1), type: 'open-positions', x: 10, y: 0, w: 2, h: 4 },
    ];
    const [out] = reconcileStoredLayout(widgets);
    expect(out.w).toBe(PerWidgetMinSize['open-positions'].w);
    expect(out.x + out.w).toBeLessThanOrEqual(12);
  });

  it('keeps config and id on a repaired widget', () => {
    const widgets: WidgetPlacement[] = [
      {
        id: ID(2),
        type: 'performance-chart',
        x: 0,
        y: 0,
        w: 8,
        h: 4,
        config: { timeframe: 'ytd' },
      },
    ];
    const [out] = reconcileStoredLayout(widgets);
    expect(out).toMatchObject({ id: ID(2), config: { timeframe: 'ytd' } });
  });
});
