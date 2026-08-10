/**
 * The shortest a P&L chart may be drawn, in px.
 *
 * Re-exported from the shared package rather than declared here. The number is
 * two things at once and they have to be one constant:
 *
 *   1. a RENDER floor — an inline `minHeight` on the chart box and on
 *      `ResponsiveContainer` (the box recharts actually observes), so a chart
 *      sized to its container is never smaller than this whatever the container
 *      does. Without it the stacked mobile dashboard, where `WidgetCard` has no
 *      determinate height at all, drew both charts at 0px.
 *   2. a LAYOUT bound — `PerWidgetMinSize` is derived from it, so a dashboard
 *      chart widget cannot be resized shorter than its chart plus its own
 *      chrome. A floor without that bound only converts a squashed chart into a
 *      silently scrolled-away one.
 *
 * See `@tradr/shared/constants/dashboard-geometry` for why 240 and what the
 * bound is made of.
 */
export { CHART_MIN_HEIGHT_PX } from '@tradr/shared/constants/dashboard-geometry';
