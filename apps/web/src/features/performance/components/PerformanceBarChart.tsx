import { format, parseISO } from 'date-fns';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { SeriesBucket } from '@tradr/shared';

import { CHART_MIN_HEIGHT_PX } from '@/features/performance/chart.constants';
import { formatSigned, moneyDirection } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PerformanceBarChartProps {
  /**
   * The per-bucket P&L series to render as vertical bars. Each entry has an
   * ISO `bucketStart` timestamp and a `netPnl` decimal string. Bar colour is
   * decided by the sign of `parseFloat(netPnl)`.
   */
  series: ReadonlyArray<SeriesBucket>;
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
   * value. The raw decimal string is preserved on `netPnl` for the tooltip so
   * we never display a JS-float-rounded value.
   */
  value: number;
  netPnl: string;
}

/**
 * Token fill for a bar by the sign of its value. `--color-gain` for positive,
 * `--color-loss` for negative, `--color-flat` for zero — each resolves per
 * theme because `.dark` re-values the token. Replaces the legacy
 * `--color-primary`/`--color-destructive` split (which was not the financial
 * direction palette and did not encode the flat case).
 */
export function fillForValue(value: number): string {
  switch (moneyDirection(value)) {
    case 'gain':
      return 'var(--color-gain)';
    case 'loss':
      return 'var(--color-loss)';
    default:
      return 'var(--color-flat)';
  }
}

/** Signed integer label/tick string (`+1,240` / `−320` / `0`), tabular. */
function formatSignedAxis(value: number): string {
  return formatSigned(value, { maximumFractionDigits: 0 });
}

function formatAxisTick(iso: string): string {
  try {
    return format(parseISO(iso), 'MMM d');
  } catch {
    return iso;
  }
}

interface BarTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartDatum }>;
}

function BarTooltip({ active, payload }: BarTooltipProps) {
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
  // Signed + currency-shaped figure with the gain/loss DOM color (a React DOM
  // node, so Tailwind `text-*` is the right channel here — unlike SVG text).
  const dir = moneyDirection(Number(datum.netPnl));
  const valueClass = dir === 'gain' ? 'text-gain' : dir === 'loss' ? 'text-loss' : 'text-flat';
  const signed = formatSigned(Number(datum.netPnl), {
    style: 'currency',
    currency: 'USD',
  });
  return (
    <div
      data-testid="performance-bar-tooltip"
      className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
    >
      <div className="font-medium">{label}</div>
      <div className={`tabular-nums ${valueClass}`}>{signed}</div>
    </div>
  );
}

/**
 * Compute the indices that ALWAYS keep a signed data label: the max-gain and
 * max-loss extremes. On a dense single-sided window (all gains or all losses)
 * bar position alone cannot disambiguate direction, so guaranteeing the two
 * extremes are labelled keeps a directional readout in B&W (R6.3).
 */
function extremeIndices(data: ReadonlyArray<ChartDatum>): Set<number> {
  const extremes = new Set<number>();
  let maxIdx = -1;
  let minIdx = -1;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i]!.value;
    if (maxIdx === -1 || v > data[maxIdx]!.value) maxIdx = i;
    if (minIdx === -1 || v < data[minIdx]!.value) minIdx = i;
  }
  if (maxIdx !== -1) extremes.add(maxIdx);
  if (minIdx !== -1) extremes.add(minIdx);
  return extremes;
}

/**
 * PerformanceBarChart — Recharts vertical `BarChart` plotting per-bucket
 * net P&L. Pure presentational: receives `series` via props, no data
 * fetching.
 *
 * Money direction is encoded the colorblind-safe way (Requirement 6): per-bar
 * `--color-gain`/`--color-loss`/`--color-flat` fills carry colour, and a
 * drawn zero baseline + signed Y-axis + signed data labels carry direction in
 * pure B&W. The tooltip is hover-only and does NOT count toward the B&W gate.
 */
export default function PerformanceBarChart({ series, className }: PerformanceBarChartProps) {
  const data: ChartDatum[] = series.map((bucket) => ({
    bucketStart: bucket.bucketStart,
    netPnl: bucket.netPnl,
    value: Number(bucket.netPnl),
  }));

  const extremes = extremeIndices(data);

  // Density-thin the data labels. `<LabelList>` has no collision avoidance, so
  // the thinning rule is ours: stride the series so a long daily window
  // (BUCKET_COUNT_CAP=1095) is not a label smear, but ALWAYS keep the max-gain
  // and max-loss extremes labelled. We mirror the X-axis `minTickGap={24}`
  // intent by capping the visible labels to roughly one per ~32px of a typical
  // chart width — a fixed stride is deterministic and jsdom-safe.
  const MAX_LABELS = 24;
  const stride = data.length > MAX_LABELS ? Math.ceil(data.length / MAX_LABELS) : 1;

  return (
    <div
      data-testid="performance-bar-chart"
      // The floor goes on BOTH boxes, and as a style rather than a class so no
      // caller's `className` can merge it away. On the wrapper it keeps the box
      // and the drawn plot the same size at every container height; on the
      // ResponsiveContainer it is the one recharts can actually measure.
      style={{ minHeight: CHART_MIN_HEIGHT_PX }}
      className={cn('h-full w-full', className)}
    >
      <ResponsiveContainer width="100%" height="100%" minHeight={CHART_MIN_HEIGHT_PX}>
        {/*
          20px of top margin, not 8: the signed data label for the max-gain bar
          is drawn 4px ABOVE that bar's top edge, and the max bar's top edge IS
          the top of the plot area — at 8px the label's ascenders were sheared
          off by the SVG viewport. 20 clears an 11px glyph plus its 4px offset.
        */}
        <BarChart data={data} margin={{ top: 20, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="bucketStart"
            tickFormatter={formatAxisTick}
            tick={{ fontSize: 12, fill: 'currentColor', opacity: 0.7 }}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            // Zero-inclusive domain so the drawn zero line is on-canvas even on
            // a one-sided (all-gain or all-loss) window — the B&W direction
            // baseline (R6.3).
            domain={([dataMin, dataMax]: readonly [number, number]) =>
              [Math.min(0, dataMin), Math.max(0, dataMax)] as [number, number]
            }
            tickFormatter={formatSignedAxis}
            tick={{
              fontSize: 12,
              fill: 'currentColor',
              opacity: 0.7,
              // Recharts forwards `style` to the SVG <text>; font-variant /
              // font-family must go here (NOT as bare tick props) to land as
              // inline style — the numeric SVG-text convention (R6.2).
              style: { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' },
            }}
            tickMargin={8}
            // `auto`, not a pinned 64px: a signed figure is as wide as the
            // account is large, and anything past ~6 characters was drawn off
            // the left edge of the SVG. recharts measures the ticks and
            // reserves what they need.
            width="auto"
          />
          {/* Drawn zero baseline — the hue-independent direction channel. */}
          <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.5} />
          <Tooltip content={<BarTooltip />} cursor={{ className: 'fill-muted/40' }} />
          <Bar dataKey="value" isAnimationActive={false}>
            {data.map((datum) => (
              <Cell key={datum.bucketStart} fill={fillForValue(datum.value)} />
            ))}
            <LabelList
              dataKey="value"
              content={(props: {
                x?: string | number;
                y?: string | number;
                width?: string | number;
                value?: unknown;
                index?: number;
              }) => {
                const { x, y, width, value, index } = props;
                // Skip = render nothing (an empty <g/>; Recharts content must
                // return a renderable, not null).
                if (index === undefined || value === undefined || value === null) return <g />;
                // Thin by stride, but never thin an extreme.
                if (index % stride !== 0 && !extremes.has(index)) return <g />;
                const num = Number(value);
                const cx = Number(x) + Number(width) / 2;
                // Place gains above the bar top, losses below — clear of the
                // zero baseline either way.
                const cy = num >= 0 ? Number(y) - 4 : Number(y) + 14;
                const fill =
                  moneyDirection(num) === 'gain'
                    ? 'var(--color-gain)'
                    : moneyDirection(num) === 'loss'
                      ? 'var(--color-loss)'
                      : 'var(--color-flat)';
                return (
                  <text
                    x={cx}
                    y={cy}
                    fill={fill}
                    fontSize={11}
                    textAnchor="middle"
                    style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}
                  >
                    {formatSignedAxis(num)}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
