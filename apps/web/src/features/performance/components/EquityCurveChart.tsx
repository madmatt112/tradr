import { format, parseISO } from 'date-fns';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { EquityCurvePoint } from '@tradr/shared';

import { CHART_MIN_HEIGHT_PX } from '@/features/performance/chart.constants';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface EquityCurveChartProps {
  /**
   * The equity-curve points to render. Each entry has an ISO `bucketStart`
   * timestamp and a `cumulativeNetPnl` decimal string (the running total at
   * the END of the bucket).
   */
  series: ReadonlyArray<EquityCurvePoint>;
  /** Currency code (e.g., "USD") for tooltip formatting. */
  currency: string;
  /**
   * Sizing for the chart's outer box, which `ResponsiveContainer` measures.
   *
   * The default is `h-full` — the chart takes the height it is GIVEN. It used
   * to hard-code `h-[320px]`, which made it the wrong size everywhere except
   * the one container that happened to be 320px tall: inside the dashboard
   * widget, whose body is 149px at the pinned default, 320px of chart was
   * simply cut off, and it stayed cut off at every height a user could resize
   * to. A caller that has no height of its own passes one here.
   *
   * "Takes the height it is GIVEN" cuts both ways, which is why the chart also
   * carries `CHART_MIN_HEIGHT_PX` as a floor of its own — see that constant. A
   * caller does not have to supply one, and a `flex-1` caller must NOT override
   * it with `min-h-0`.
   */
  className?: string;
}

interface ChartDatum {
  bucketStart: string;
  /**
   * Coerced number form for Recharts, which cannot plot a decimal-string Y
   * value. The raw decimal string is preserved on `cumulativeNetPnl` for the
   * tooltip so we never display a JS-float-rounded value.
   */
  value: number;
  cumulativeNetPnl: string;
}

/**
 * Render the timestamp on the X axis. Day-resolution by default; the parent
 * page selects an appropriate domain so this never has to be granularity
 * aware. (Granularity-specific labelling happens in `BreakdownTable` —
 * Task 30 — not in the chart axis.)
 */
function formatAxisTick(iso: string): string {
  try {
    return format(parseISO(iso), 'MMM d');
  } catch {
    return iso;
  }
}

interface EquityTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartDatum }>;
  currency: string;
}

function EquityTooltip({ active, payload, currency }: EquityTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const first = payload[0];
  if (!first) return null;
  const datum = first.payload;
  if (!datum) return null;
  let label: string;
  try {
    label = format(parseISO(datum.bucketStart), 'PP');
  } catch {
    label = datum.bucketStart;
  }
  return (
    <div
      data-testid="equity-curve-tooltip"
      className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
    >
      <div className="font-medium">{label}</div>
      <div className="text-muted-foreground">{formatMoney(datum.cumulativeNetPnl, currency)}</div>
    </div>
  );
}

/**
 * EquityCurveChart — Recharts `LineChart` plotting cumulative net P&L over
 * the active timeframe.
 *
 * This module is the SOLE importer of `recharts` in the app: the parent
 * (Task 32, `PerformancePage`) imports it via `React.lazy(() => import(...))`
 * so Recharts ships in a separate chunk that's only fetched when the
 * Performance page is visited.
 *
 * The error boundary that catches lazy-chunk-404s lives in Task 32, NOT
 * here — wrapping a boundary inside this file would defeat the lazy split
 * (the boundary code would also live in the lazy chunk and so couldn't
 * catch its own load error).
 */
export default function EquityCurveChart({ series, currency, className }: EquityCurveChartProps) {
  // Recharts cannot plot decimal-strings — convert once for the line; keep
  // the decimal string on the datum so the tooltip uses the exact value.
  const data: ChartDatum[] = series.map((point) => ({
    bucketStart: point.bucketStart,
    cumulativeNetPnl: point.cumulativeNetPnl,
    value: Number(point.cumulativeNetPnl),
  }));

  return (
    <div
      data-testid="equity-curve-chart"
      // The floor goes on BOTH boxes, and as a style rather than a class so no
      // caller's `className` can merge it away. On the wrapper it keeps the box
      // and the drawn plot the same size at every container height; on the
      // ResponsiveContainer it is the one recharts can actually measure.
      style={{ minHeight: CHART_MIN_HEIGHT_PX }}
      className={cn('h-full w-full', className)}
    >
      <ResponsiveContainer width="100%" height="100%" minHeight={CHART_MIN_HEIGHT_PX}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="bucketStart"
            tickFormatter={formatAxisTick}
            tick={{ fontSize: 12, fill: 'currentColor', opacity: 0.7 }}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            // Route the axis figures through the shared money formatter with
            // tabular figures + the numeric font (SVG text is styled by font
            // CSS props; color stays theme-aware via currentColor) (R6.5).
            tickFormatter={(value: number) => formatMoney(String(value), currency)}
            tick={{
              fontSize: 12,
              fill: 'currentColor',
              opacity: 0.7,
              // `style` is forwarded to the SVG <text>; the numeric convention
              // must live here (not as bare tick props) to land as inline style.
              style: { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' },
            }}
            tickMargin={8}
            // `auto`, not the 64px this used to pin. A money tick is as wide as
            // the figure demands — "$10,000.00" at 12px mono is ~72px — and a
            // fixed 64 rendered it off the left edge of the SVG, so the axis
            // read ".0,000.00". recharts measures the ticks and reserves what
            // they need.
            width="auto"
          />
          <Tooltip content={<EquityTooltip currency={currency} />} />
          <Line
            type="monotone"
            dataKey="value"
            // Per-theme brand token (resolves light/dark via `.dark`) rather
            // than raw currentColor (R6.5). Not money-direction-colored.
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
