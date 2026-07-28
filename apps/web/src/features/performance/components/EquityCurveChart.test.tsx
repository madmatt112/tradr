// @vitest-environment jsdom
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { EquityCurvePoint } from '@tradr/shared';

// ResponsiveContainer measures via ResizeObserver (never fires in jsdom); mock
// it to a fixed-size passthrough so the SVG axes render for assertion.
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

import EquityCurveChart from './EquityCurveChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERIES: EquityCurvePoint[] = [
  { bucketStart: '2026-04-01T00:00:00.000Z', cumulativeNetPnl: '0.00' },
  { bucketStart: '2026-04-02T00:00:00.000Z', cumulativeNetPnl: '125.50' },
  { bucketStart: '2026-04-03T00:00:00.000Z', cumulativeNetPnl: '-25.00' },
  { bucketStart: '2026-04-04T00:00:00.000Z', cumulativeNetPnl: '300.75' },
];

describe('EquityCurveChart', () => {
  it('is exported as the default export so React.lazy works idiomatically', () => {
    // The Task 32 composition site does `React.lazy(() => import('./EquityCurveChart'))`
    // and expects the default export to be the component. If a future refactor
    // accidentally converts this to a named-only export, the lazy import on
    // the page would break with no compile-time error.
    expect(EquityCurveChart).toBeTypeOf('function');
  });

  it('renders the outer chart container with the expected height/width', () => {
    const container = document.createElement('div');
    // Stub a non-zero size so Recharts ResponsiveContainer can mount.
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<EquityCurveChart series={SERIES} currency="USD" />);
    });

    const wrapper = container.querySelector('[data-testid="equity-curve-chart"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain('h-[320px]');
    expect(wrapper?.className).toContain('w-full');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('routes Y-axis ticks through the shared money formatter with tabular figures', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<EquityCurveChart series={SERIES} currency="USD" />);
    });

    const yTicks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'));
    expect(yTicks.length).toBeGreaterThan(0);
    // Shared `formatMoney` shapes the figure as currency ($…) rather than a
    // bare number.
    expect(yTicks.some((el) => (el.textContent ?? '').includes('$'))).toBe(true);
    // Tabular figures on the SVG axis text (the numeric convention).
    for (const el of yTicks) {
      expect(el.getAttribute('style') ?? '').toMatch(/tabular-nums/);
    }

    const line = container.querySelector('.recharts-line-curve');
    expect(line?.getAttribute('stroke')).toBe('var(--color-primary)');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('handles an empty series without throwing', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
    document.body.appendChild(container);
    const root = createRoot(container);

    expect(() => {
      act(() => {
        root.render(<EquityCurveChart series={[]} currency="USD" />);
      });
    }).not.toThrow();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
