/**
 * The pixel geometry the dashboard grid is denominated in, and the arithmetic
 * that turns a chart's minimum drawn height into a minimum widget size.
 *
 * It lives in the shared package rather than in the web app because
 * `PerWidgetMinSize` — the bound the SERVER validates and the one gridstack
 * refuses to resize past — has to be derived from the same numbers the browser
 * lays out with. Two copies of "a row is 40px" or "the chart floor is 240" is
 * exactly how a widget ends up sizeable below what its content can occupy.
 *
 * The chrome figures are measured off a real chromium render at 1440x900
 * against the built CSS; jsdom performs no layout and cannot supply them.
 */

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
 * together — AND because a widget whose content cannot shrink carries a minimum
 * size that reserves room for it (`chartWidgetMinRows` below).
 */
export const GRID_ROW_HEIGHT_PX = 40;

/** The visible gutter between two neighbouring widgets, in px. */
export const GRID_GAP_PX = 16;

/**
 * The shortest a P&L chart may be drawn, in px.
 *
 * Both charts size to the box they are given (`h-full`), which is right on the
 * Performance page and on the dashboard grid, and wrong in exactly one place:
 * the stacked mobile dashboard, where `DashboardGrid` renders `WidgetCard`
 * with no determinate height at all. A percentage height against an auto
 * parent is auto, so `ResponsiveContainer` measured 0 and drew nothing — both
 * charts rendered at 0px and the Equity Curve widget was a 73px empty strip.
 *
 * So the charts carry a floor as well as a fill. It is a `minHeight` on
 * `ResponsiveContainer` — the box recharts actually observes — so the chart is
 * never smaller than this whatever its container does, and it propagates back up
 * as the wrapper's min-content height, which is what makes a `flex-1` chart
 * reserve the room inside a content-sized widget.
 *
 * 240 is a legibility floor, not an arbitrary one: below it the y-axis falls to
 * three ticks and the signed data labels start colliding with the date ticks.
 *
 * A floor that the container can be smaller than is an overflow, though, and
 * the widget body scrolls — so the same number also sets how short the widget
 * itself may be made (`chartWidgetMinRows`). The two must be derived from one
 * constant or a resize walks the chart straight back off the bottom of its card.
 */
export const CHART_MIN_HEIGHT_PX = 240;

/** `WidgetCard`'s own border, top and bottom, inside the gridstack cell. */
export const CARD_BORDER_PX = 2;

/** `<header>` of WidgetCard: a text-sm title at px-3 py-2 over a 1px border. */
export const CARD_HEADER_PX = 49;

/** `p-3` on WidgetCard's scroll body, top and bottom. */
export const BODY_PADDING_PX = 24;

/** `gap-3` between the rows of a widget's column stack. */
export const STACK_GAP_PX = 12;

/**
 * The timeframe buttons above the performance chart. `size="sm"` is `h-8`, and
 * the strip is `flex-wrap`, so this is TWO rows plus the `gap-2` between them —
 * not one row.
 *
 * Two rows is not the pessimistic case, it is the case at the widget's minimum
 * WIDTH: measured in chromium, the six buttons occupy one 32px row at w=8 and
 * two at w=4, which is the narrowest a user may make this widget. A height
 * bound that assumed the wide form would be 40px short exactly where it is
 * being relied on.
 */
export const TIMEFRAME_ROW_PX = 32 + 8 + 32;

/**
 * The fewest grid rows a chart widget may span without its chart overflowing
 * the widget body.
 *
 * `toolbarPx` is whatever the widget stacks ABOVE its chart — the performance
 * chart pays for its timeframe strip and the `gap-3` under it, the equity curve
 * has no toolbar and passes 0.
 *
 * Everything else is fixed chrome: the body's padding, WidgetCard's header and
 * border, and the 16px gridstack takes out of the cell. Rounded UP, because a
 * partial row does not exist.
 *
 * WHY THIS IS A BOUND AND NOT A SUGGESTION. The chart cannot shrink below
 * `CHART_MIN_HEIGHT_PX`, and the widget body is `overflow-auto` — so a widget
 * shorter than this does not squash the chart, it hides the bottom of it behind
 * a scroller that takes no layout space. Measured in chromium, the performance
 * chart hid 203px at h=4 and 43px at h=8: visually identical to the original
 * hard-coded-height defect, and just as invisible to a DOM assertion.
 *
 * The one state deliberately NOT budgeted for is the free tier's clamped-window
 * notice (24px plus a 12px gap), which renders in the same body when the
 * response says the window was clamped. Reserving room for a conditional row
 * would push the performance chart's minimum to its pinned default and take
 * vertical resizing away from every user to protect one transient state; the
 * pinned default carries that headroom instead (see `DEFAULT_WIDGETS`, and
 * `ChartWidget.height.test.tsx`, which pins both).
 */
export function chartWidgetMinRows(toolbarPx: number): number {
  const contentPx = CHART_MIN_HEIGHT_PX + toolbarPx;
  const chromePx = BODY_PADDING_PX + CARD_HEADER_PX + CARD_BORDER_PX + GRID_GAP_PX;
  return Math.ceil((contentPx + chromePx) / GRID_ROW_HEIGHT_PX);
}
