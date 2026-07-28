// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrencyHistoryRange } from '../utils/derivePresetRange';

// React 19 requires this flag for act() to work in non-test-renderer envs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();

// Mock TanStack Router's `useNavigate` so tests don't need a router context.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { buildTimeframePatch, TIMEFRAME_PRESETS, TimeframeSelector } from './TimeframeSelector';

const HISTORY: CurrencyHistoryRange = {
  earliestClosedAt: '2024-04-15T10:00:00Z',
  mostRecentClosedAt: '2026-06-01T12:00:00Z',
  totalClosedPositions: 42,
};

beforeEach(() => {
  navigateMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TimeframeSelector — render (SSR)', () => {
  it('renders six preset buttons in order with cursor-pointer', () => {
    const html = renderToStaticMarkup(
      <TimeframeSelector
        value="monthly"
        currencyHistoryRange={HISTORY}
        resolvedTimezone="UTC"
        resolvedWeekStartDay={0}
      />,
    );
    for (const preset of TIMEFRAME_PRESETS) {
      expect(html).toContain(`data-testid="timeframe-preset-${preset.id}"`);
      expect(html).toContain(preset.label);
    }
    // CLAUDE.md rule: button-like elements must have `cursor-pointer`.
    expect(html).toMatch(/cursor-pointer/);
    // role=tablist for keyboard accessibility.
    expect(html).toMatch(/role="tablist"/);
  });

  it('marks the active preset with data-state=active and aria-selected=true', () => {
    const html = renderToStaticMarkup(
      <TimeframeSelector
        value="weekly"
        currencyHistoryRange={HISTORY}
        resolvedTimezone="UTC"
        resolvedWeekStartDay={0}
      />,
    );
    const weeklyMatch = html.match(/<button[^>]*data-testid="timeframe-preset-weekly"[^>]*>/);
    expect(weeklyMatch).not.toBeNull();
    expect(weeklyMatch?.[0]).toContain('data-state="active"');
    expect(weeklyMatch?.[0]).toContain('aria-selected="true"');
    const dailyMatch = html.match(/<button[^>]*data-testid="timeframe-preset-daily"[^>]*>/);
    expect(dailyMatch?.[0]).toContain('aria-selected="false"');
  });
});

describe('buildTimeframePatch (pure)', () => {
  it('daily: returns correct granularity/start/end', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = buildTimeframePatch('daily', HISTORY, 'UTC', 0, now);
    expect(r.granularity).toBe('day');
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    expect(r.start).toBe('2026-05-17T00:00:00.000Z');
  });

  it('monthly: granularity=month, start = end - 12m', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = buildTimeframePatch('monthly', HISTORY, 'UTC', 0, now);
    expect(r.granularity).toBe('month');
    // end clamped to today+1 (natural start-of-next-month 2026-07-01 is future).
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    expect(r.start).toBe('2025-07-01T00:00:00.000Z');
  });

  it('all-time: pulls start from currencyHistoryRange.earliestClosedAt', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = buildTimeframePatch('all-time', HISTORY, 'UTC', 0, now);
    expect(r.granularity).toBe('month');
    expect(r.start).toBe('2024-04-01T00:00:00.000Z');
    // end clamped to today+1 (natural start-of-next-month 2026-07-01 is future).
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
  });
});

describe('TimeframeSelector — navigate semantics (jsdom)', () => {
  it('clicking a preset fires navigate exactly once with a function-form `search` that merges the patch', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TimeframeSelector
          value="monthly"
          currencyHistoryRange={HISTORY}
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    const dailyBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="timeframe-preset-daily"]',
    );
    expect(dailyBtn).not.toBeNull();

    act(() => {
      dailyBtn!.click();
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const arg = navigateMock.mock.calls[0]?.[0] as { search: (prev: unknown) => unknown };
    expect(typeof arg.search).toBe('function');
    const result = arg.search({
      granularity: 'month',
      start: '2025-07-01T00:00:00.000Z',
      end: '2026-07-01T00:00:00.000Z',
      tz: 'UTC',
      currency: 'USD',
    }) as Record<string, unknown>;
    expect(result.tz).toBe('UTC');
    expect(result.currency).toBe('USD');
    expect(result.granularity).toBe('day');
    expect(result.end).toBe('2026-06-16T00:00:00.000Z');
    expect(result.start).toBe('2026-05-17T00:00:00.000Z');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('clicking the already-active preset does NOT fire navigate', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TimeframeSelector
          value="monthly"
          currencyHistoryRange={HISTORY}
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    const monthlyBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="timeframe-preset-monthly"]',
    );
    act(() => {
      monthlyBtn!.click();
    });

    expect(navigateMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
