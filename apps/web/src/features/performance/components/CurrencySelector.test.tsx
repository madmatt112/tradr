// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceCurrency } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// Mock the shadcn Select primitive so jsdom doesn't have to fight Radix's
// pointer-event machinery (which relies on browser-only features missing in
// jsdom). The mock renders a real <select> + <option>s and forwards the
// onValueChange prop, which is the only behavior we need to test:
//   - click an option → onValueChange(value) → component fires navigate()
//   - dormant options carry the right data-attributes + suffix label
const triggerSpy = vi.fn();
vi.mock('@/components/ui/select', () => {
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange: (v: string) => void;
    }) => {
      // We render the children as-is so SelectItem can attach its own
      // data-attributes; we attach a hidden test trigger that flips value.
      return (
        <div data-testid="select-root" data-value={value}>
          <select
            data-testid="select-native"
            value={value}
            onChange={(e) => onValueChange(e.currentTarget.value)}
          >
            {/* Native option is purely for jsdom event firing; the rendered
                children below are what tests inspect for dormant attrs. */}
          </select>
          {children}
        </div>
      );
    },
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="select-content">{children}</div>
    ),
    SelectTrigger: ({
      children,
      className,
      ...rest
    }: {
      children: React.ReactNode;
      className?: string;
    } & Record<string, unknown>) => {
      triggerSpy({ className, ...rest });
      return (
        <button
          type="button"
          data-testid={rest['data-testid'] ?? 'select-trigger'}
          className={className}
        >
          {children}
        </button>
      );
    },
    SelectValue: () => <span data-testid="select-value" />,
    SelectItem: ({
      children,
      value,
      className,
      ...rest
    }: {
      children: React.ReactNode;
      value: string;
      className?: string;
    } & Record<string, unknown>) => (
      <div
        role="option"
        data-value={value}
        data-testid={rest['data-testid'] ?? `select-item-${value}`}
        data-dormant={rest['data-dormant'] as string | undefined}
        className={className}
      >
        {children}
      </div>
    ),
  };
});

import { buildCurrencyChangePatch, CurrencySelector } from './CurrencySelector';

// `totalClosedPositions` defaults to 1 (has all-history positions). `series`
// defaults to a single non-empty bucket so the currency reads as "has data in
// the active timeframe" — pass `[]` to simulate an in-timeframe-empty
// (dormant) currency.
function makeCurrency(
  code: string,
  totalClosedPositions = 1,
  series: PerformanceCurrency['series'] = [
    {
      bucketStart: '2026-06-01T00:00:00.000Z',
      netPnl: '0',
      grossPnl: '0',
      fees: '0',
      totalPositions: 1,
      wins: 0,
      losses: 0,
      breakevens: 1,
    },
  ],
): PerformanceCurrency {
  return {
    code,
    historyRange: {
      earliestClosedAt: totalClosedPositions === 0 ? null : '2024-04-15T10:00:00Z',
      mostRecentClosedAt: totalClosedPositions === 0 ? null : '2026-06-01T12:00:00Z',
      totalClosedPositions,
    },
    series,
    equityCurve: [],
    stats: {
      totalPositions: 0,
      totalNetPnl: '0',
      winRate: null,
      breakevenRate: null,
      avgWin: null,
      avgLoss: null,
      profitFactor: null,
      largestWin: null,
      largestLoss: null,
      hasWins: false,
      hasLosses: false,
    },
  };
}

beforeEach(() => {
  navigateMock.mockReset();
  triggerSpy.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CurrencySelector — single-currency static label', () => {
  it('renders a static <span>, not a Select trigger button, when only one currency exists', () => {
    const html = renderToStaticMarkup(
      <CurrencySelector
        value="USD"
        currencies={[makeCurrency('USD')]}
        currentPreset="monthly"
        resolvedTimezone="UTC"
        resolvedWeekStartDay={0}
      />,
    );
    expect(html).toContain('data-testid="currency-selector-static"');
    expect(html).toContain('USD');
    // No interactive trigger present.
    expect(html).not.toContain('data-testid="currency-selector"');
    // It is rendered as a span, not a button.
    expect(html).toMatch(/<span[^>]*data-testid="currency-selector-static"/);
  });

  it('also renders static label when zero currencies (defensive)', () => {
    const html = renderToStaticMarkup(
      <CurrencySelector
        value="USD"
        currencies={[]}
        currentPreset="monthly"
        resolvedTimezone="UTC"
        resolvedWeekStartDay={0}
      />,
    );
    expect(html).toContain('data-testid="currency-selector-static"');
  });
});

describe('CurrencySelector — dormant indicator (jsdom)', () => {
  it('attaches data-dormant="true" + suffix to currencies whose in-timeframe series is empty', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // EUR has all-history positions (totalClosedPositions=10) but an empty
    // series in the active timeframe — this is the primary in-timeframe-empty
    // signal the dormant indicator must surface.
    // GBP has no all-history positions (secondary "never had positions"
    // signal) — should also be dormant.
    // USD/JPY have non-empty series + history → not dormant.
    act(() => {
      root.render(
        <CurrencySelector
          value="USD"
          currencies={[
            makeCurrency('USD', 12),
            makeCurrency('EUR', 10, []),
            makeCurrency('GBP', 0, []),
            makeCurrency('JPY', 5),
          ]}
          currentPreset="monthly"
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    const eurOption = container.querySelector<HTMLElement>('[data-testid="currency-option-EUR"]');
    const gbpOption = container.querySelector<HTMLElement>('[data-testid="currency-option-GBP"]');
    const usdOption = container.querySelector<HTMLElement>('[data-testid="currency-option-USD"]');
    const jpyOption = container.querySelector<HTMLElement>('[data-testid="currency-option-JPY"]');

    expect(eurOption).not.toBeNull();
    expect(gbpOption).not.toBeNull();
    expect(usdOption).not.toBeNull();
    expect(jpyOption).not.toBeNull();
    // Primary signal: empty series (despite all-history positions).
    expect(eurOption?.getAttribute('data-dormant')).toBe('true');
    // Secondary signal: zero all-history positions.
    expect(gbpOption?.getAttribute('data-dormant')).toBe('true');
    expect(usdOption?.getAttribute('data-dormant')).toBeNull();
    expect(jpyOption?.getAttribute('data-dormant')).toBeNull();
    expect(eurOption?.textContent).toContain('no positions in timeframe');
    expect(gbpOption?.textContent).toContain('no positions in timeframe');
    expect(usdOption?.textContent).not.toContain('no positions in timeframe');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders trigger with cursor-pointer for multi-currency', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CurrencySelector
          value="USD"
          currencies={[makeCurrency('USD'), makeCurrency('EUR')]}
          currentPreset="monthly"
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    expect(triggerSpy).toHaveBeenCalled();
    const lastCall = triggerSpy.mock.lastCall?.[0] as Record<string, unknown>;
    expect(String(lastCall?.className ?? '')).toContain('cursor-pointer');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('CurrencySelector — alphabetical option order', () => {
  it('sorts currencies alphabetically regardless of input order', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CurrencySelector
          value="USD"
          currencies={[makeCurrency('USD'), makeCurrency('EUR'), makeCurrency('JPY')]}
          currentPreset="monthly"
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    const opts = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="currency-option-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(opts).toEqual(['currency-option-EUR', 'currency-option-JPY', 'currency-option-USD']);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('buildCurrencyChangePatch (pure)', () => {
  it('returns all four keys (currency, granularity, start, end) using the new currency historyRange', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const currencies = [
      makeCurrency('USD', 12),
      {
        ...makeCurrency('EUR', 5),
        historyRange: {
          earliestClosedAt: '2025-09-01T00:00:00Z',
          mostRecentClosedAt: '2026-05-01T00:00:00Z',
          totalClosedPositions: 5,
        },
      },
    ];

    const patch = buildCurrencyChangePatch('EUR', currencies, 'all-time', 'UTC', 0, now);

    expect(patch).toEqual({
      currency: 'EUR',
      granularity: 'month',
      start: '2025-09-01T00:00:00.000Z',
      // end clamped to today+1 (natural start-of-next-month 2026-07-01 is future).
      end: '2026-06-16T00:00:00.000Z',
    });
  });

  it('returns sane fallback for unknown currency (defensive)', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const patch = buildCurrencyChangePatch('XXX', [], 'monthly', 'UTC', 0, now);
    expect(patch.currency).toBe('XXX');
    expect(patch.granularity).toBe('month');
  });
});

describe('CurrencySelector — atomic single navigate() on currency change (jsdom)', () => {
  it('fires EXACTLY ONE navigate() with all four search keys updated', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const currencies = [
      makeCurrency('USD', 12),
      {
        ...makeCurrency('EUR', 5),
        historyRange: {
          earliestClosedAt: '2025-09-01T00:00:00Z',
          mostRecentClosedAt: '2026-05-01T00:00:00Z',
          totalClosedPositions: 5,
        },
      },
    ];

    act(() => {
      root.render(
        <CurrencySelector
          value="USD"
          currencies={currencies}
          currentPreset="all-time"
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    // Drive the change via the mocked native <select> — this is what
    // simulates the user picking EUR from the dropdown.
    const nativeSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="select-native"]',
    );
    expect(nativeSelect).not.toBeNull();
    // Inject the EUR option so jsdom's <select>.value can be set.
    const opt = document.createElement('option');
    opt.value = 'EUR';
    nativeSelect!.appendChild(opt);

    act(() => {
      nativeSelect!.value = 'EUR';
      nativeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const arg = navigateMock.mock.calls[0]?.[0] as { search: (prev: unknown) => unknown };
    expect(typeof arg.search).toBe('function');

    const prev = {
      granularity: 'month',
      start: '2024-04-01T00:00:00.000Z',
      end: '2026-07-01T00:00:00.000Z',
      tz: 'UTC',
      currency: 'USD',
    };
    const result = arg.search(prev) as Record<string, unknown>;

    // All four keys updated atomically (REQ: ONE navigate call, four keys).
    expect(result.currency).toBe('EUR');
    expect(result.granularity).toBe('month');
    expect(result.start).toBe('2025-09-01T00:00:00.000Z');
    // end clamped to today+1 (faked clock is 2026-06-15; natural end is future).
    expect(result.end).toBe('2026-06-16T00:00:00.000Z');
    // Non-patched keys preserved.
    expect(result.tz).toBe('UTC');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('selecting the already-active currency does NOT fire navigate', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CurrencySelector
          value="USD"
          currencies={[makeCurrency('USD', 12), makeCurrency('EUR', 5)]}
          currentPreset="monthly"
          resolvedTimezone="UTC"
          resolvedWeekStartDay={0}
        />,
      );
    });

    const nativeSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="select-native"]',
    );
    const opt = document.createElement('option');
    opt.value = 'USD';
    nativeSelect!.appendChild(opt);

    act(() => {
      nativeSelect!.value = 'USD';
      nativeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(navigateMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
