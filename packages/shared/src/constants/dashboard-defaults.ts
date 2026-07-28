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
export const DEFAULT_WIDGETS: readonly DefaultWidgetSpec[] = [
  { type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 },
  { type: 'performance-chart', x: 0, y: 1, w: 6, h: 2 },
  { type: 'account-balances', x: 6, y: 1, w: 6, h: 2 },
  { type: 'equity-curve', x: 0, y: 3, w: 6, h: 2 },
  { type: 'position-sizing', x: 6, y: 3, w: 6, h: 3 },
  { type: 'open-positions', x: 0, y: 6, w: 12, h: 2 },
] as const;

// Maximum size of a PUT /dashboard/layout request body. Enforced by the
// backend bodyLimit middleware and pre-checked on the frontend via
// TextEncoder before sending.
export const BODY_LIMIT_BYTES = 16 * 1024;
