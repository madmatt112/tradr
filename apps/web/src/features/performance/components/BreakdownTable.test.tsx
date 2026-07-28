// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Granularity, SeriesBucket } from '@tradr/shared';

import { BreakdownTable } from './BreakdownTable';

function bucket(start: string, overrides: Partial<SeriesBucket> = {}): SeriesBucket {
  return {
    bucketStart: start,
    netPnl: '0.00',
    grossPnl: '0.00',
    fees: '0.00',
    totalPositions: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    ...overrides,
  };
}

describe('BreakdownTable', () => {
  it('renders one row per bucket with the column headers', () => {
    const series = [
      bucket('2026-03-15T00:00:00.000Z', { totalPositions: 3, wins: 2, losses: 1 }),
      bucket('2026-03-16T00:00:00.000Z', { totalPositions: 1, wins: 1 }),
    ];
    const html = renderToStaticMarkup(
      <BreakdownTable series={series} granularity="day" tz="UTC" currency="USD" />,
    );
    expect(html).toContain('Period');
    expect(html).toContain('Net P&amp;L');
    expect(html).toContain('Mar 15');
    expect(html).toContain('Mar 16');
  });

  it('uses the day label format for granularity=day', () => {
    const html = renderToStaticMarkup(
      <BreakdownTable
        series={[bucket('2026-03-15T00:00:00.000Z')]}
        granularity="day"
        tz="UTC"
        currency="USD"
      />,
    );
    expect(html).toContain('Mar 15');
    expect(html).not.toContain('Mar 15–');
    expect(html).not.toContain('Mar 2026');
  });

  it('uses the week label format for granularity=week', () => {
    const html = renderToStaticMarkup(
      <BreakdownTable
        series={[bucket('2026-03-15T00:00:00.000Z')]}
        granularity="week"
        tz="UTC"
        currency="USD"
      />,
    );
    expect(html).toContain('Mar 15–21');
  });

  it('uses the month label format for granularity=month', () => {
    const html = renderToStaticMarkup(
      <BreakdownTable
        series={[bucket('2026-03-01T00:00:00.000Z')]}
        granularity="month"
        tz="UTC"
        currency="USD"
      />,
    );
    expect(html).toContain('Mar 2026');
  });

  it('uses the year label format for granularity=year', () => {
    const html = renderToStaticMarkup(
      <BreakdownTable
        series={[bucket('2026-01-01T00:00:00.000Z')]}
        granularity="year"
        tz="UTC"
        currency="USD"
      />,
    );
    expect(html).toContain('2026');
    expect(html).not.toContain('Jan 2026');
    expect(html).not.toContain('Jan 1');
  });

  it('routes a money-direction figure (gain net P&L) through the primitive: reserved slot, sign, gain color, 2dp', () => {
    const html = renderToStaticMarkup(
      <BreakdownTable
        series={[bucket('2026-03-15T00:00:00.000Z', { netPnl: '500.00' })]}
        granularity="day"
        tz="UTC"
        currency="USD"
      />,
    );
    // Rendered through Numeric (data-testid), not a bare span.
    expect(html).toContain('data-testid="numeric"');
    // The reserved leading slot is present (the load-bearing alignment invariant).
    expect(html).toContain('data-testid="numeric-slot"');
    // Gain encoding: + sign, gain token, currency body at 2dp.
    expect(html).toContain('data-state="gain"');
    expect(html).toContain('text-gain');
    expect(html).toContain('+');
    expect(html).toContain('$500.00');
  });

  it('renders a neutral figure (integer count) via direction="none": no sign, no gain/loss color', () => {
    const html = renderToStaticMarkup(
      <BreakdownTable
        series={[bucket('2026-03-15T00:00:00.000Z', { totalPositions: 7, netPnl: '500.00' })]}
        granularity="day"
        tz="UTC"
        currency="USD"
      />,
    );
    // The integer count is neutral: state=neutral, no +/− sign coloring on it.
    expect(html).toContain('data-state="neutral"');
    // Count renders at 0dp.
    expect(html).toContain('>7<');
  });

  it('renders the table-shaped empty variant for an empty series, preserving column geometry', () => {
    const granularities: Granularity[] = ['day', 'week', 'month', 'year'];
    for (const g of granularities) {
      const html = renderToStaticMarkup(
        <BreakdownTable series={[]} granularity={g} tz="UTC" currency="USD" />,
      );
      // Column headers still render (geometry preserved), not collapsed away.
      expect(html).toContain('Period');
      expect(html).toContain('Net P&amp;L');
      // The empty message row spans all 8 columns rather than emitting bare cells.
      expect(html).toContain('data-testid="table-empty-state"');
      expect(html).toContain('colSpan="8"');
    }
  });
});
