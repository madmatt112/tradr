import type { WidgetType } from '../schemas/dashboard';

export type DefaultWidgetSpec = {
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
};

// The default layout's height ceiling in 40px rows (Req 1.3): every
// DEFAULT_WIDGETS entry keeps `y + h <= DEFAULT_LAYOUT_MAX_ROWS`. It bounds the
// default alone — WidgetPlacementSchema leaves `y` unbounded and DashboardGrid
// leaves gridstack's whole-canvas `maxRow` unset (design D2), so a stored user
// layout may sit past it.
export const DEFAULT_LAYOUT_MAX_ROWS = 36;

// The per-type default size the registry, picker and repair all read from, so a
// widget gets one size wherever it is created (Req 5.2, design D5). Every `w`/`h`
// is at least PerWidgetMinSize[type] and `h` is at most GRID_MAX_ROWS.
export const WidgetDefaultSize: Record<WidgetType, { w: number; h: number }> = {
  'stats-summary': { w: 12, h: 6 },
  'performance-chart': { w: 6, h: 12 },
  'equity-curve': { w: 6, h: 12 },
  'open-positions': { w: 8, h: 12 },
  'account-balances': { w: 4, h: 12 },
  'position-sizing': { w: 4, h: 24 },
};

// 12-column grid. Geometry only — IDs are computed per-user via uuidv5 in the
// service layer, and config defaults come from the frontend widget registry.
//
// Three bands. Stats Summary spans all twelve columns on top. Below it the two
// charts sit side by side, six columns each — both need a wide plot and the
// full twelve rows to read (see below). Open Positions and Account Balances
// share the bottom band: the table takes the eight-column width its six data
// columns need, and Account Balances — a handful of figures — sits in the
// four-column remainder beside it. Position Sizing is no longer part of the
// default; it is added from the picker.
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
// h=5 (133px body) is the tightest that fits those tiles, which is why it is the
// per-type minimum. The default carries one row of headroom above that minimum
// at h=6 (173px body) — the same split the two charts carry.
// See StatsSummaryWidget.height.test.tsx, which fails if either drops back.
//
// Both charts are 12 rows, not the 6 they started with. The charts now size to
// their container rather than to a hard-coded 320px, so 6 no longer CLIPS
// them — but it leaves the performance chart a 105px box once its timeframe
// buttons are paid for, and measured in chromium at 1440x900 that is a ~55px
// plot with the signed data labels sitting on top of the date ticks. Not
// clipped and not readable is still broken. 12 rows gives the body 413px: the
// performance chart's plot box comes to 345px and the equity curve's to 389px,
// around the 320px the Performance page gives the same chart. See
// ChartWidget.height.test.tsx.
//
// 12 is also one row above the performance chart's derived MINIMUM (11): the
// minimum reserves the chart's floor plus the widget's permanent chrome, and the
// default carries one row of headroom above it — the same split Stats Summary
// carries.
//
// Rows 0-29, every column covered, no overlap and no gap:
//   0-5    stats-summary      x0-11
//   6-17   performance-chart  x0-5   | equity-curve      x6-11
//   18-29  open-positions     x0-7   | account-balances  x8-11
//
// The layout ends at row 30, inside DEFAULT_LAYOUT_MAX_ROWS (36). That is past
// row 24, which is fine: GRID_MAX_ROWS bounds a widget's `h`, and `y` is
// deliberately unbounded (the schema does not check `y + h`, and DashboardGrid
// deliberately leaves gridstack's whole-canvas `maxRow` unset). The dashboard
// has always scrolled — 24 rows is 960px against a 900px viewport — so the
// constraint the old geometry appeared to obey was never one.
export const DEFAULT_WIDGETS: readonly DefaultWidgetSpec[] = [
  { type: 'stats-summary', x: 0, y: 0, ...WidgetDefaultSize['stats-summary'] },
  { type: 'performance-chart', x: 0, y: 6, ...WidgetDefaultSize['performance-chart'] },
  { type: 'equity-curve', x: 6, y: 6, ...WidgetDefaultSize['equity-curve'] },
  { type: 'open-positions', x: 0, y: 18, ...WidgetDefaultSize['open-positions'] },
  { type: 'account-balances', x: 8, y: 18, ...WidgetDefaultSize['account-balances'] },
] as const;

// Every default layout the product has shipped, oldest first. A stored layout is
// compared against these so a user who never rearranged their dashboard is
// answered with the current default on read (design D). Append a new entry when
// the default changes; never edit an existing one. Today's one entry is the
// six-widget default this spec replaces.
export const PRIOR_DEFAULT_LAYOUTS: readonly (readonly DefaultWidgetSpec[])[] = [
  [
    { type: 'stats-summary', x: 0, y: 0, w: 12, h: 6 },
    { type: 'performance-chart', x: 0, y: 6, w: 8, h: 12 },
    { type: 'account-balances', x: 8, y: 6, w: 4, h: 12 },
    { type: 'equity-curve', x: 0, y: 18, w: 8, h: 12 },
    { type: 'position-sizing', x: 8, y: 18, w: 4, h: 12 },
    { type: 'open-positions', x: 0, y: 30, w: 12, h: 6 },
  ],
] as const;

// Maximum size of a PUT /dashboard/layout request body. Enforced by the
// backend bodyLimit middleware and pre-checked on the frontend via
// TextEncoder before sending.
export const BODY_LIMIT_BYTES = 16 * 1024;
