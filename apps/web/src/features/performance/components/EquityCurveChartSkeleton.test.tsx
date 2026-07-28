// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EquityCurveChartSkeleton } from './EquityCurveChartSkeleton';

describe('EquityCurveChartSkeleton', () => {
  it('renders the skeleton with the chart container dimensions', () => {
    const html = renderToStaticMarkup(<EquityCurveChartSkeleton />);
    expect(html).toContain('data-testid="equity-curve-chart-skeleton"');
    // Matches `EquityCurveChart`'s outer 320px height + full width — no
    // layout shift when the lazy chunk swaps in.
    expect(html).toContain('h-[320px]');
    expect(html).toContain('w-full');
    // Skeleton inherits the shadcn `animate-pulse` class — a quick proof
    // it actually composes the shared primitive rather than re-rendering
    // a static box.
    expect(html).toContain('animate-pulse');
  });

  it('forwards an extra className to the underlying skeleton', () => {
    const html = renderToStaticMarkup(<EquityCurveChartSkeleton className="mt-4" />);
    expect(html).toContain('mt-4');
  });
});
