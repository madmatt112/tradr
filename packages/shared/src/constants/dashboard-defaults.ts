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
// This list is also a valid left-to-right top-to-bottom packing of itself, in
// declared order; `repackLayout` pins that (see layout.test.ts).
export const DEFAULT_WIDGETS: readonly DefaultWidgetSpec[] = [
  { type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 },
  { type: 'performance-chart', x: 0, y: 1, w: 8, h: 3 },
  { type: 'account-balances', x: 8, y: 1, w: 4, h: 3 },
  { type: 'equity-curve', x: 0, y: 4, w: 8, h: 3 },
  { type: 'position-sizing', x: 8, y: 4, w: 4, h: 3 },
  { type: 'open-positions', x: 0, y: 7, w: 12, h: 3 },
] as const;

// Maximum size of a PUT /dashboard/layout request body. Enforced by the
// backend bodyLimit middleware and pre-checked on the frontend via
// TextEncoder before sending.
export const BODY_LIMIT_BYTES = 16 * 1024;
