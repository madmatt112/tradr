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
 * never smaller than this whatever its container does, and it propagates back
 * up as the wrapper's min-content height, which is what makes a `flex-1`
 * chart reserve the room inside a content-sized widget.
 *
 * 240 is a legibility floor, not an arbitrary one: below it the y-axis falls to
 * three ticks and the signed data labels start colliding with the date ticks.
 * It is the same number `ChartWidget.height.test.tsx` holds the pinned dashboard
 * defaults to. It never binds where there IS a height to divide — the grid hands
 * the charts 345px and 389px, the Performance page 320px — so it costs those
 * surfaces nothing.
 */
export const CHART_MIN_HEIGHT_PX = 240;
