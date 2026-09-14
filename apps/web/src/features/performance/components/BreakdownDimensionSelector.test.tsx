// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BREAKDOWN_DIMENSIONS } from '@tradr/shared';

// React 19 requires this flag for act() to work in non-test-renderer envs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();

// Mock TanStack Router's `useNavigate` so tests don't need a router context.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { BreakdownDimensionSelector } from './BreakdownDimensionSelector';

beforeEach(() => {
  navigateMock.mockReset();
  document.body.innerHTML = '';
});

describe('BreakdownDimensionSelector — render (SSR)', () => {
  it('renders the four dimension tabs with cursor-pointer under a labelled tablist', () => {
    const html = renderToStaticMarkup(<BreakdownDimensionSelector value="symbol" />);
    for (const by of BREAKDOWN_DIMENSIONS) {
      expect(html).toContain(`data-testid="breakdown-dimension-${by}"`);
    }
    expect(html).toContain('Symbol');
    expect(html).toContain('Weekday');
    expect(html).toContain('Hour');
    expect(html).toContain('Tag');
    // CLAUDE.md rule: button-like elements must have `cursor-pointer`.
    expect(html).toMatch(/cursor-pointer/);
    // role=tablist labelled "Breakdown by" for keyboard accessibility (R6.7).
    expect(html).toMatch(/role="tablist"/);
    expect(html).toContain('aria-label="Breakdown by"');
  });

  it('marks the active dimension with data-state=active and aria-selected=true', () => {
    const html = renderToStaticMarkup(<BreakdownDimensionSelector value="tag" />);
    const tagMatch = html.match(/<button[^>]*data-testid="breakdown-dimension-tag"[^>]*>/);
    expect(tagMatch).not.toBeNull();
    expect(tagMatch?.[0]).toContain('data-state="active"');
    expect(tagMatch?.[0]).toContain('aria-selected="true"');
    const symbolMatch = html.match(/<button[^>]*data-testid="breakdown-dimension-symbol"[^>]*>/);
    expect(symbolMatch?.[0]).toContain('aria-selected="false"');
  });
});

describe('BreakdownDimensionSelector — navigate semantics (jsdom)', () => {
  it('clicking a dimension fires navigate once with a function-form `search` that merges { by }', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<BreakdownDimensionSelector value="symbol" />);
    });

    const tagBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="breakdown-dimension-tag"]',
    );
    expect(tagBtn).not.toBeNull();

    act(() => {
      tagBtn!.click();
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const arg = navigateMock.mock.calls[0]?.[0] as { search: (prev: unknown) => unknown };
    expect(typeof arg.search).toBe('function');
    // The patch merges the new dimension onto the existing search, untouched.
    const result = arg.search({
      granularity: 'month',
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-07-01T00:00:00.000Z',
      tz: 'UTC',
      currency: 'USD',
      by: 'symbol',
    }) as Record<string, unknown>;
    expect(result.by).toBe('tag');
    expect(result.granularity).toBe('month');
    expect(result.currency).toBe('USD');
    expect(result.tz).toBe('UTC');

    act(() => root.unmount());
    container.remove();
  });

  it('clicking the already-active dimension does NOT fire navigate', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<BreakdownDimensionSelector value="symbol" />);
    });

    const symbolBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="breakdown-dimension-symbol"]',
    );
    act(() => {
      symbolBtn!.click();
    });

    expect(navigateMock).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it('activates a tab from the keyboard: the tabs are focusable native buttons', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<BreakdownDimensionSelector value="symbol" />);
    });

    const hourBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="breakdown-dimension-hour"]',
    );
    // A native <button role="tab"> is keyboard-operable: the browser turns
    // Enter/Space into a click. Assert it is a focusable button and that the
    // activation click carries the merge patch.
    expect(hourBtn?.tagName).toBe('BUTTON');
    act(() => {
      hourBtn!.focus();
    });
    expect(document.activeElement).toBe(hourBtn);
    act(() => {
      hourBtn!.click();
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const arg = navigateMock.mock.calls[0]?.[0] as { search: (prev: unknown) => unknown };
    const result = arg.search({ by: 'symbol' }) as Record<string, unknown>;
    expect(result.by).toBe('hour');

    act(() => root.unmount());
    container.remove();
  });
});
