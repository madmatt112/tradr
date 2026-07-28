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

import { formatMoney } from '@/lib/format';

export interface EquityCurveChartProps {
  /**
   * The equity-curve points to render. Each entry has an ISO `bucketStart`
   * timestamp and a `cumulativeNetPnl` decimal string (the running total at
   * the END of the bucket).
   */
  series: ReadonlyArray<EquityCurvePoint>;
  /** Currency code (e.g., "USD") for tooltip formatting. */
  currency: string;
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
export default function EquityCurveChart({ series, currency }: EquityCurveChartProps) {
  // Recharts cannot plot decimal-strings — convert once for the line; keep
  // the decimal string on the datum so the tooltip uses the exact value.
  const data: ChartDatum[] = series.map((point) => ({
    bucketStart: point.bucketStart,
    cumulativeNetPnl: point.cumulativeNetPnl,
    value: Number(point.cumulativeNetPnl),
  }));

  return (
    <div data-testid="equity-curve-chart" className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
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
            width={64}
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
