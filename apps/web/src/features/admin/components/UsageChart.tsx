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

import type { AdminUsage } from '@tradr/shared/schemas/admin';

import { formatMoney } from '@/lib/format';

import { formatIntString, formatMicroUsd, MICRO_USD_PER_USD } from '../lib/format';

export interface UsageChartProps {
  /** UTC day buckets from GET /api/admin/usage (integer-string sums). */
  series: AdminUsage['series'];
}

interface ChartDatum {
  day: string;
  /**
   * Billed credits coerced to a USD number for plotting only — Recharts
   * cannot plot integer strings. The raw strings are preserved on the datum
   * so the tooltip never displays a JS-float-derived value.
   */
  value: number;
  billedCredits: string;
  inputTokens: string;
  outputTokens: string;
}

function formatAxisTick(day: string): string {
  try {
    return format(parseISO(day), 'MMM d');
  } catch {
    return day;
  }
}

interface UsageTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartDatum }>;
}

function UsageTooltip({ active, payload }: UsageTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  let label: string;
  try {
    label = format(parseISO(datum.day), 'PP');
  } catch {
    label = datum.day;
  }
  return (
    <div
      data-testid="usage-chart-tooltip"
      className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
    >
      <div className="font-medium">{label}</div>
      <div className="text-muted-foreground">
        {formatMicroUsd(datum.billedCredits)} billed credits
      </div>
      <div className="text-muted-foreground">
        {formatIntString(datum.inputTokens)} in · {formatIntString(datum.outputTokens)} out tokens
      </div>
    </div>
  );
}

/**
 * UsageChart — Recharts `LineChart` plotting billed credits per UTC day.
 *
 * This module is the ONLY Recharts importer in the admin feature: the parent
 * (`UsageSection`) imports it via `React.lazy(() => import('./UsageChart'))`
 * so Recharts stays in its own async chunk (REQ-7.5) — the
 * `features/performance` `EquityCurveChart` precedent. Admin charts are not
 * dashboard widgets: no `widget-budgets.json` entry.
 */
export default function UsageChart({ series }: UsageChartProps) {
  const data: ChartDatum[] = series.map((point) => ({
    day: point.day,
    value: Number(point.billedCredits) / MICRO_USD_PER_USD,
    billedCredits: point.billedCredits,
    inputTokens: point.inputTokens,
    outputTokens: point.outputTokens,
  }));

  return (
    <div data-testid="usage-chart" className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="day"
            tickFormatter={formatAxisTick}
            tick={{ fontSize: 12, fill: 'currentColor', opacity: 0.7 }}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            // Axis is in USD dollars (the plotted `value`); route it through the
            // shared money formatter with tabular figures + the numeric font so
            // the axis reads consistently with the tooltip (R6.5).
            tickFormatter={(value: number) => formatMoney(String(value), 'USD')}
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
          <Tooltip content={<UsageTooltip />} />
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
