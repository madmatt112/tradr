import type { WidgetType } from '../schemas/dashboard';

export type DefaultWidgetSpec = {
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
};

// 12-column grid. Geometry only — IDs are computed per-user via uuidv5 in the
// service layer, and config defaults come from the frontend widget registry.
//
// Proportions follow what each widget actually renders: the two charts get the
// wide 8-column band, while Account Balances (a handful of figures) and
// Position Sizing (a narrow form) sit in the 4-column rail beside them. Each
// chart is paired with a rail widget of the same row span, so the two bands
// read as bands. (The original reason — shared CSS-grid rows stretching a short
// widget — no longer applies: gridstack positions every item absolutely from
// its own `h`. The pairing is now a visual choice, and both rail widgets have
// more content than 6 rows shows, so neither is padded out by it.)
//
// Denominated in 40px rows (Req 1.10). Every `y` and `h` is double the value
// it held under the 80px unit, which is the same transform Req 1.11 applies to
// saved layouts — so defaults and migrated user layouts stay consistent.
//
// Stats Summary is 6 rows, not the 2 it started with, because 2 could not show
// what the widget renders. A widget's visible height is `40h - 16`, and
// WidgetCard spends 2px of border and a 49px header out of that before its body
// sees a pixel, so the body is `40h - 67`. Measured in chromium at 1440x900:
// the populated tile grid needs 124px (two rows of tiles at 44px, one 12px gap,
// 24px of body padding). h=2 gave the body 13px and clipped 111px of figures;
// h=5 (133px body) fits those tiles with 9px to spare.
//
// 5 was still short for the enforced free tier, where TierWindowNotice renders
// inside the same body: boxed it is 66px plus a 12px stack gap, and 133px of
// body clipped 69px of it. So the notice is rendered in its one-line `compact`
// form (24px) instead: 100px of tiles + 12px gap + 24px of notice + 24px of
// padding = 160px, inside the 173px h=6 gives, 13px spare. Both states fit.
// See StatsSummaryWidget.height.test.tsx, which fails if either drops back.
//
// The two chart bands are 12 rows, not the 6 they started with. The charts now
// size to their container rather than to a hard-coded 320px, so 6 no longer
// CLIPS them — but it leaves the performance chart a 105px box once its
// timeframe buttons are paid for, and measured in chromium at 1440x900 that is
// a ~55px plot with the signed data labels sitting on top of the date ticks.
// Not clipped and not readable is still broken. 12 rows gives the body 413px:
// the performance chart's plot box comes to 345px (309px with the free-tier
// notice) and the equity curve's to 389px (353px), around the 320px the
// Performance page gives the same chart. See ChartWidget.height.test.tsx.
//
// Rows 0-35, every column covered, no overlap and no gap:
//   0-5    stats-summary      x0-11
//   6-17   performance-chart  x0-7   | account-balances  x8-11
//   18-29  equity-curve       x0-7   | position-sizing   x8-11
//   30-35  open-positions     x0-11
//
// That is past row 24, which is fine: GRID_MAX_ROWS bounds a widget's `h`, and
// `y` is deliberately unbounded (the schema does not check `y + h`, and
// DashboardGrid deliberately leaves gridstack's whole-canvas `maxRow` unset).
// The dashboard has always scrolled — 24 rows is 960px against a 900px
// viewport — so the constraint the old geometry appeared to obey was never one.
export const DEFAULT_WIDGETS: readonly DefaultWidgetSpec[] = [
  { type: 'stats-summary', x: 0, y: 0, w: 12, h: 6 },
  { type: 'performance-chart', x: 0, y: 6, w: 8, h: 12 },
  { type: 'account-balances', x: 8, y: 6, w: 4, h: 12 },
  { type: 'equity-curve', x: 0, y: 18, w: 8, h: 12 },
  { type: 'position-sizing', x: 8, y: 18, w: 4, h: 12 },
  { type: 'open-positions', x: 0, y: 30, w: 12, h: 6 },
] as const;

// Maximum size of a PUT /dashboard/layout request body. Enforced by the
// backend bodyLimit middleware and pre-checked on the frontend via
// TextEncoder before sending.
export const BODY_LIMIT_BYTES = 16 * 1024;
