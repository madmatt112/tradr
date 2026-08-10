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
// Stats Summary is 5 rows, not the 2 it started with, because 2 could not show
// what the widget renders. Measured in chromium at 1440x900: the populated tile
// grid needs 124px (two rows of tiles at 44px, one 12px gap, 24px of body
// padding) beneath a 49px card header and 2px of card border — a 175px card. A
// widget's visible height is `40h - 16`, so h=2 gave the body 24px and clipped
// 100px of figures; h=4 (144px card) still falls short; h=5 is the first that
// fits — a 184px card whose body measures 133px, 9px more than the tiles need.
// It was survivable only while the widget queried the current month alone and
// so usually rendered its one-line empty state; all-time figures do not fit.
// See StatsSummaryWidget.height.test.tsx, which fails if this drops back.
export const DEFAULT_WIDGETS: readonly DefaultWidgetSpec[] = [
  { type: 'stats-summary', x: 0, y: 0, w: 12, h: 5 },
  { type: 'performance-chart', x: 0, y: 5, w: 8, h: 6 },
  { type: 'account-balances', x: 8, y: 5, w: 4, h: 6 },
  { type: 'equity-curve', x: 0, y: 11, w: 8, h: 6 },
  { type: 'position-sizing', x: 8, y: 11, w: 4, h: 6 },
  { type: 'open-positions', x: 0, y: 17, w: 12, h: 6 },
] as const;

// Maximum size of a PUT /dashboard/layout request body. Enforced by the
// backend bodyLimit middleware and pre-checked on the frontend via
// TextEncoder before sending.
export const BODY_LIMIT_BYTES = 16 * 1024;
