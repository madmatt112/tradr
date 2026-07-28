// @vitest-environment jsdom
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { AdminUsage } from '@tradr/shared/schemas/admin';

// ResponsiveContainer measures via ResizeObserver (never fires in jsdom); mock
// it to a fixed-size passthrough so the SVG axes/line render for assertion.
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

import UsageChart from './UsageChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERIES: AdminUsage['series'] = [
  { day: '2026-04-01', billedCredits: '1500000', inputTokens: '1200', outputTokens: '800' },
  { day: '2026-04-02', billedCredits: '3250000', inputTokens: '2400', outputTokens: '1600' },
  { day: '2026-04-03', billedCredits: '500000', inputTokens: '600', outputTokens: '400' },
];

describe('UsageChart', () => {
  it('is exported as the default export so React.lazy works idiomatically', () => {
    expect(UsageChart).toBeTypeOf('function');
  });

  it('routes Y-axis ticks through the shared money formatter with tabular figures', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<UsageChart series={SERIES} />);
    });

    const yTicks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'));
    expect(yTicks.length).toBeGreaterThan(0);
    // Shared `formatMoney` shapes the USD axis figure as currency.
    expect(yTicks.some((el) => (el.textContent ?? '').includes('$'))).toBe(true);
    // Tabular figures on the SVG axis text.
    for (const el of yTicks) {
      expect(el.getAttribute('style') ?? '').toMatch(/tabular-nums/);
    }

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the line with a per-theme token stroke (not raw currentColor)', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<UsageChart series={SERIES} />);
    });

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
        root.render(<UsageChart series={[]} />);
      });
    }).not.toThrow();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
