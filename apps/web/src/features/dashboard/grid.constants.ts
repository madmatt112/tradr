export const GRID_COLUMNS = 12;
// Re-exported from the schema so the client cannot drift from the bound the
// server validates (`h: 1..GRID_MAX_ROWS`). Deep path, not the package barrel:
// `grid.constants` is imported by most of the dashboard, and pulling the whole
// of `@tradr/shared` through it changes module init order enough to break
// unrelated suites under a full run.
export { GRID_MAX_ROWS } from '@tradr/shared/schemas/dashboard';
export const GRID_GAP_PX = 16;
/** Deadband (px) the resize gesture must cross past the ½-cell snap line. */
export const RESIZE_HYSTERESIS_PX = 1;
/**
 * Fixed row pitch (Req 1.10). A widget spanning `h` rows is exactly
 * `40h + 16(h-1)` px tall and depends on nothing else on the canvas.
 *
 * Two earlier rules are withdrawn. `80px` fixed was too coarse once `h` had to
 * express a full page. `minmax(80px, auto)` was worse: CSS Grid rows are shared,
 * so a tall widget stretched every short widget in its band — a short widget
 * beside a 3-row 430px neighbour measured 176px normally and 281px with the
 * edit backdrop present. A fixed unit makes a cell a cell everywhere, which is
 * what free placement needs to be predictable.
 *
 * The trade: widget height stops being dictated by content and becomes
 * something the user sets by resizing, so content taller than its widget
 * scrolls inside it. That is only acceptable because the seven-handle resize
 * (Req 4.6.2) makes height easy to adjust — the two decisions stand or fall
 * together.
 */
export const GRID_ROW_HEIGHT_PX = 40;
export const DEBOUNCE_PUT_MS = 300;
export const THEME_PUT_FAILURE_TOMBSTONE_MS = 60_000;
