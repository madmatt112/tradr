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
// chart is paired with a rail widget of the SAME row span — rows in a CSS grid
// are shared, so a 3-row chart beside a 2-row panel would stretch that panel
// into a tall near-empty box.
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
// body clipped 69px of it. No row span fixes that on its own — h=6 is the most
// the 24-row ceiling leaves for this widget once the two chart bands and Open
// Positions take 18 rows below it, and 173px of body still clips 29px. So the
// notice is rendered in its one-line `compact` form (24px) instead: 100px of
// tiles + 12px gap + 24px of notice + 24px of padding = 160px, inside the 173px
// h=6 gives, 13px spare. Both states now fit.
// See StatsSummaryWidget.height.test.tsx, which fails if either drops back.
export const DEFAULT_WIDGETS: readonly DefaultWidgetSpec[] = [
  { type: 'stats-summary', x: 0, y: 0, w: 12, h: 6 },
  { type: 'performance-chart', x: 0, y: 6, w: 8, h: 6 },
  { type: 'account-balances', x: 8, y: 6, w: 4, h: 6 },
  { type: 'equity-curve', x: 0, y: 12, w: 8, h: 6 },
  { type: 'position-sizing', x: 8, y: 12, w: 4, h: 6 },
  { type: 'open-positions', x: 0, y: 18, w: 12, h: 6 },
] as const;

// Maximum size of a PUT /dashboard/layout request body. Enforced by the
// backend bodyLimit middleware and pre-checked on the frontend via
// TextEncoder before sending.
export const BODY_LIMIT_BYTES = 16 * 1024;
