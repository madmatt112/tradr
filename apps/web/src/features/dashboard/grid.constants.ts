export const GRID_COLUMNS = 12;
// Re-exported from the schema so the client cannot drift from the bound the
// server validates (`h: 1..GRID_MAX_ROWS`). Deep path, not the package barrel:
// `grid.constants` is imported by most of the dashboard, and pulling the whole
// of `@tradr/shared` through it changes module init order enough to break
// unrelated suites under a full run.
export { GRID_MAX_ROWS } from '@tradr/shared/schemas/dashboard';
export const GRID_GAP_PX = 16;
/**
 * Fixed row pitch (Req 1.10). A widget spanning `h` rows occupies exactly `40h`
 * px of canvas and depends on nothing else on it.
 *
 * gridstack insets `GRID_GAP_PX / 2` on every side of an item, so the gutter
 * between two widgets is the full 16px while the pitch stays a flat 40 — the
 * gap comes out of the cell rather than sitting between cells. A widget's
 * visible height is therefore `40h - 16`.
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
