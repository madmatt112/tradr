// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PerformanceStats } from '@tradr/shared';

import { StatsPanel } from './StatsPanel';

const BASE_STATS: PerformanceStats = {
  totalPositions: 10,
  totalNetPnl: '500.00',
  winRate: 60,
  breakevenRate: 10,
  avgWin: '100.00',
  avgLoss: '-50.00',
  profitFactor: 2.0,
  largestWin: '300.00',
  largestLoss: '-150.00',
  hasWins: true,
  hasLosses: true,
};

describe('StatsPanel', () => {
  it('renders all REQ-4 stats when fully populated', () => {
    const html = renderToStaticMarkup(<StatsPanel stats={BASE_STATS} currency="USD" />);
    expect(html).toContain('Total Positions');
    expect(html).toContain('Total Net P&amp;L');
    expect(html).toContain('Win Rate');
    expect(html).toContain('Breakeven Rate');
    expect(html).toContain('Avg Win');
    expect(html).toContain('Avg Loss');
    expect(html).toContain('Profit Factor');
    expect(html).toContain('Largest Win');
    expect(html).toContain('Largest Loss');
    expect(html).toContain('60.0%'); // winRate 1 decimal
    expect(html).toContain('2.00'); // profit factor 2 decimals
  });

  it('shows em-dash (U+2014) for null winRate / breakevenRate / money fields', () => {
    const stats: PerformanceStats = {
      ...BASE_STATS,
      winRate: null,
      breakevenRate: null,
      avgWin: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      profitFactor: null,
      hasWins: false,
      hasLosses: false,
    };
    const html = renderToStaticMarkup(<StatsPanel stats={stats} currency="USD" />);
    // Em-dash, not a hyphen.
    expect(html).toContain('—');
    expect(html).not.toContain('>-<');
  });

  it('renders ∞ for profit factor only when hasWins && !hasLosses && profitFactor==null', () => {
    const stats: PerformanceStats = {
      ...BASE_STATS,
      profitFactor: null,
      hasWins: true,
      hasLosses: false,
    };
    const html = renderToStaticMarkup(<StatsPanel stats={stats} currency="USD" />);
    expect(html).toContain('∞');
  });

  it('does NOT render ∞ when profitFactor is null with hasWins=false', () => {
    const stats: PerformanceStats = {
      ...BASE_STATS,
      profitFactor: null,
      hasWins: false,
      hasLosses: false,
    };
    const html = renderToStaticMarkup(<StatsPanel stats={stats} currency="USD" />);
    expect(html).not.toContain('∞');
  });

  it('does NOT render ∞ when profitFactor is a finite number', () => {
    const html = renderToStaticMarkup(<StatsPanel stats={BASE_STATS} currency="USD" />);
    expect(html).not.toContain('∞');
  });
});
