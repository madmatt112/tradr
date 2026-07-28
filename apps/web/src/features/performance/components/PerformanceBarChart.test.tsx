// @vitest-environment jsdom
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { SeriesBucket } from '@tradr/shared';

// Recharts' ResponsiveContainer measures via ResizeObserver, which never fires
// in jsdom — the SVG would never mount. Mock it to a fixed-size passthrough so
// the chart's actual SVG (cells, labels, axes, reference line) renders and can
// be asserted.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            width: 800,
            height: 320,
          })
        : children,
  };
});

import PerformanceBarChart, { fillForValue } from './PerformanceBarChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bucket(bucketStart: string, netPnl: string): SeriesBucket {
  return {
    bucketStart,
    netPnl,
    grossPnl: netPnl,
    fees: '0.00',
    totalPositions: 1,
    wins: 0,
    losses: 0,
    breakevens: 0,
  };
}

const SERIES: SeriesBucket[] = [
  bucket('2026-04-01T00:00:00.000Z', '1240.00'),
  bucket('2026-04-02T00:00:00.000Z', '-320.00'),
  bucket('2026-04-03T00:00:00.000Z', '0.00'),
  bucket('2026-04-04T00:00:00.000Z', '55.00'),
];

function mount(series: SeriesBucket[]) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PerformanceBarChart series={series} />);
  });
  return {
    container,
    cleanup() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('PerformanceBarChart', () => {
  it('is exported as the default export so React.lazy works idiomatically', () => {
    expect(PerformanceBarChart).toBeTypeOf('function');
  });

  it('maps each money direction to its token fill (gain/loss/flat) — the chart half of the colorblind gate', () => {
    expect(fillForValue(1240)).toBe('var(--color-gain)');
    expect(fillForValue(-320)).toBe('var(--color-loss)');
    expect(fillForValue(0)).toBe('var(--color-flat)');
  });

  it('colours the rendered bars with the gain/loss tokens (not the legacy primary/destructive split)', () => {
    const { container, cleanup } = mount(SERIES);

    const fills = Array.from(container.querySelectorAll('path.recharts-rectangle')).map((el) =>
      el.getAttribute('fill'),
    );
    expect(fills).toContain('var(--color-gain)');
    expect(fills).toContain('var(--color-loss)');
    expect(fills).not.toContain('var(--color-primary)');
    expect(fills).not.toContain('var(--color-destructive)');

    cleanup();
  });

  it('renders signed, tabular data labels with token fills carrying direction in B&W', () => {
    const { container, cleanup } = mount(SERIES);

    const labels = Array.from(container.querySelectorAll('.recharts-label-list text'));
    const texts = labels.map((el) => el.textContent);
    // Signed strings (Intl uses the leading +/ASCII -), reinforcing direction
    // without hue.
    expect(texts).toContain('+1,240');
    expect(texts).toContain('-320');

    // Every data label uses tabular figures and a token fill (SVG text is
    // coloured by `fill`, not a Tailwind text-* class).
    for (const el of labels) {
      expect(el.getAttribute('style') ?? '').toMatch(/tabular-nums/);
    }
    const gainLabel = labels.find((el) => el.textContent === '+1,240');
    expect(gainLabel?.getAttribute('fill')).toBe('var(--color-gain)');
    const lossLabel = labels.find((el) => el.textContent === '-320');
    expect(lossLabel?.getAttribute('fill')).toBe('var(--color-loss)');

    cleanup();
  });

  it('draws a zero baseline reference line so direction reads against zero in B&W', () => {
    const { container, cleanup } = mount(SERIES);
    expect(container.querySelector('.recharts-reference-line')).not.toBeNull();
    cleanup();
  });

  it('renders signed, tabular Y-axis ticks via the consolidated formatter', () => {
    const { container, cleanup } = mount(SERIES);
    const yTicks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'));
    const texts = yTicks.map((el) => el.textContent ?? '');
    expect(texts.some((t) => t.startsWith('+') || t.startsWith('-'))).toBe(true);
    for (const el of yTicks) {
      expect(el.getAttribute('style') ?? '').toMatch(/tabular-nums/);
    }
    cleanup();
  });

  it('handles an empty series without throwing', () => {
    expect(() => {
      const { cleanup } = mount([]);
      cleanup();
    }).not.toThrow();
  });
});
