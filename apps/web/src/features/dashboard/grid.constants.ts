export const GRID_COLUMNS = 12;
// Re-exported from the schema so the client cannot drift from the bound the
// server validates (`h: 1..GRID_MAX_ROWS`). Deep path, not the package barrel:
// `grid.constants` is imported by most of the dashboard, and pulling the whole
// of `@tradr/shared` through it changes module init order enough to break
// unrelated suites under a full run.
export { GRID_MAX_ROWS } from '@tradr/shared/schemas/dashboard';
// The row pitch and the gutter live in the shared package for the same reason,
// one step further on: `PerWidgetMinSize` is derived from them (a chart widget's
// minimum height is its chart's floor plus its chrome, converted to rows), and
// that minimum is validated server-side. A second copy of "a row is 40px" here
// would let the two answers drift. See `constants/dashboard-geometry` for both.
export { GRID_GAP_PX, GRID_ROW_HEIGHT_PX } from '@tradr/shared/constants/dashboard-geometry';
export const DEBOUNCE_PUT_MS = 300;
export const THEME_PUT_FAILURE_TOMBSTONE_MS = 60_000;
