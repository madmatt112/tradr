// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ChartChunkStaleBanner } from './ChartChunkStaleBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ChartChunkStaleBanner — render (SSR)', () => {
  it('renders the banner with a Refresh button that has cursor-pointer', () => {
    const html = renderToStaticMarkup(<ChartChunkStaleBanner />);
    expect(html).toContain('data-testid="chart-chunk-stale-banner"');
    expect(html).toContain('data-testid="chart-chunk-stale-banner-refresh"');
    expect(html).toContain('Refresh');
    // CLAUDE.md rule: button-like elements must include cursor-pointer.
    const buttonMatch = html.match(
      /<button[^>]*data-testid="chart-chunk-stale-banner-refresh"[^>]*>/,
    );
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch?.[0]).toContain('cursor-pointer');
  });

  it('renders no dismiss button (banner is non-dismissible)', () => {
    const html = renderToStaticMarkup(<ChartChunkStaleBanner />);
    // The only button on this banner is the Refresh button. Anything else
    // would be a dismiss/close affordance and would violate the design.
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
  });

  it('uses aria-live="assertive" so screen-readers announce immediately', () => {
    const html = renderToStaticMarkup(<ChartChunkStaleBanner />);
    expect(html).toContain('aria-live="assertive"');
  });
});

describe('ChartChunkStaleBanner — refresh click (jsdom)', () => {
  it('clicking Refresh fires the supplied onReload exactly once', () => {
    const onReload = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<ChartChunkStaleBanner onReload={onReload} />);
    });

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="chart-chunk-stale-banner-refresh"]',
    );
    expect(btn).not.toBeNull();

    act(() => {
      btn!.click();
    });

    expect(onReload).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
