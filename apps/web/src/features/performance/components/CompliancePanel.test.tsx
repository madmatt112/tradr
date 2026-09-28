// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `Link` is stubbed to a plain anchor so the panel mounts without a router
// context; `to` becomes `href` so the no-rules link is assertable.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// Both hooks are React Query (→ `api.get`); this file renders with no
// `QueryClientProvider`, so each is mocked with a factory returning a controlled
// result (a bare `vi.mock` would automock to `undefined` and throw).
const useTradingRulesMock = vi.fn();
vi.mock('@/features/trading-rules/hooks/useTradingRules', () => ({
  useTradingRules: () => useTradingRulesMock(),
}));

const useBreakdownMock = vi.fn();
vi.mock('../hooks/useBreakdown', () => ({
  useBreakdown: () => useBreakdownMock(),
}));

import { CompliancePanel, type CompliancePanelProps } from './CompliancePanel';

const PARAMS: CompliancePanelProps['params'] = {
  start: '2026-01-01T00:00:00.000Z',
  end: '2027-01-01T00:00:00.000Z',
  tz: 'UTC',
};

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    totalPositions: 3,
    totalNetPnl: '90.00',
    winRate: 66.7,
    breakevenRate: 0.0,
    avgWin: '60.00',
    avgLoss: '-30.00',
    profitFactor: 4.0,
    largestWin: '60.00',
    largestLoss: '-30.00',
    expectancy: '30.00',
    hasWins: true,
    hasLosses: true,
    ...overrides,
  };
}

function buildBreakdownResult(complianceRate: number | null = 66.7) {
  return {
    status: 'success' as const,
    data: {
      by: 'compliance',
      multiValued: false,
      resolvedTimezone: 'UTC',
      resolvedWeekStartDay: 0,
      dataQuality: { timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 } },
      currencies: [
        {
          code: 'USD',
          total: makeStats(),
          complianceRate,
          rows: [
            {
              key: 'compliant',
              label: 'Compliant',
              tag: null,
              stats: makeStats({ totalPositions: 6, totalNetPnl: '300.00' }),
            },
            {
              key: 'non_compliant',
              label: 'Non-compliant',
              tag: null,
              stats: makeStats({ totalPositions: 2, totalNetPnl: '-120.00' }),
            },
            { key: 'unscored', label: 'Unscored', tag: null, stats: makeStats() },
          ],
        },
      ],
    },
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  useTradingRulesMock.mockReset();
  useTradingRulesMock.mockReturnValue({ data: [{ id: 'rule-1' }] });
  useBreakdownMock.mockReset();
  useBreakdownMock.mockReturnValue(buildBreakdownResult());
});

afterEach(() => {
  cleanup();
});

describe('CompliancePanel — no rules', () => {
  it('links to the Rules tab instead of showing figures', () => {
    useTradingRulesMock.mockReturnValue({ data: [] });
    render(<CompliancePanel params={PARAMS} currency="USD" />);

    const link = screen.getByTestId('compliance-rules-link');
    expect(link.getAttribute('href')).toBe('/settings/rules');
    // No figures on the no-rules path.
    expect(screen.queryByTestId('compliance-rate')).toBeNull();
    expect(screen.queryByTestId('compliance-row-compliant')).toBeNull();
  });
});

describe('CompliancePanel — compliance rate', () => {
  it('shows the rate as a percent', () => {
    render(<CompliancePanel params={PARAMS} currency="USD" />);
    expect(screen.getByTestId('compliance-rate').textContent).toContain('66.7%');
  });

  it('shows an em dash when the rate is null', () => {
    useBreakdownMock.mockReturnValue(buildBreakdownResult(null));
    render(<CompliancePanel params={PARAMS} currency="USD" />);
    expect(screen.getByTestId('compliance-rate').textContent).toContain('—');
  });
});

describe('CompliancePanel — rows', () => {
  it('renders the compliant and non-compliant rows with their figures', () => {
    render(<CompliancePanel params={PARAMS} currency="USD" />);

    const compliant = screen.getByTestId('compliance-row-compliant');
    const nonCompliant = screen.getByTestId('compliance-row-non_compliant');
    expect(compliant.textContent).toContain('Compliant');
    expect(compliant.textContent).toContain('6');
    expect(nonCompliant.textContent).toContain('Non-compliant');
    expect(nonCompliant.textContent).toContain('2');
    // The `unscored` group is not shown — only the scored split.
    expect(screen.queryByTestId('compliance-row-unscored')).toBeNull();
  });
});

describe('CompliancePanel — error', () => {
  it('shows an error message with a retry control', () => {
    const refetch = vi.fn();
    useBreakdownMock.mockReturnValue({ status: 'error' as const, refetch });
    render(<CompliancePanel params={PARAMS} currency="USD" />);

    expect(screen.getByTestId('compliance-error')).toBeTruthy();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
