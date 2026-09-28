// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ComplianceEntry, PositionCompliance } from '@tradr/shared';

import { ComplianceCard } from './ComplianceCard';

function makeEntry(overrides: Partial<ComplianceEntry> = {}): ComplianceEntry {
  return {
    ruleId: '33333333-3333-4333-8333-333333333333',
    type: 'max_risk_amount',
    description: 'Risk per trade at most $500',
    weight: 'critical',
    outcome: 'breach',
    unit: 'currency',
    currency: 'USD',
    measured: '750',
    limit: '500',
    reason: null,
    ...overrides,
  };
}

function makeCompliance(overrides: Partial<PositionCompliance> = {}): PositionCompliance {
  return {
    finality: 'provisional',
    score: 67,
    status: 'non_compliant',
    entries: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ComplianceCard — breach', () => {
  it('shows the description, measured against limit and weight', () => {
    render(
      <ComplianceCard compliance={makeCompliance({ entries: [makeEntry({ ruleId: 'a' })] })} />,
    );

    expect(screen.getByText('Risk per trade at most $500')).toBeTruthy();
    expect(screen.getByText('Breaches')).toBeTruthy();
    expect(screen.getByText('Critical')).toBeTruthy();
    // Measured and limit render as currency figures with the entry's currency.
    expect(screen.getByText(/against/)).toBeTruthy();
    expect(screen.getByText('$750.00')).toBeTruthy();
    expect(screen.getByText('$500.00')).toBeTruthy();
  });
});

describe('ComplianceCard — not evaluable', () => {
  it("shows the rule with its reason in words and doesn't say Breaches", () => {
    render(
      <ComplianceCard
        compliance={makeCompliance({
          score: null,
          status: 'unscored',
          entries: [
            makeEntry({
              ruleId: 'b',
              type: 'min_risk_reward',
              description: 'Risk-to-reward at least 2',
              outcome: 'not_evaluable',
              unit: 'ratio',
              currency: null,
              measured: null,
              limit: '2',
              reason: 'no_stop_loss',
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('Not evaluable')).toBeTruthy();
    expect(screen.getByText('Risk-to-reward at least 2')).toBeTruthy();
    expect(screen.getByText('No stop loss set')).toBeTruthy();
    expect(screen.queryByText('Breaches')).toBeNull();
  });
});

describe('ComplianceCard — empty entries', () => {
  it('says no rule applies and shows no score', () => {
    render(
      <ComplianceCard
        compliance={makeCompliance({ score: 100, finality: 'final', entries: [] })}
      />,
    );

    expect(screen.getByText('No rule applies to this position')).toBeTruthy();
    // No score is shown when there are no entries (Requirement 6.3).
    expect(screen.queryByText('100')).toBeNull();
    expect(screen.queryByText('Final')).toBeNull();
  });
});

describe('ComplianceCard — finality label', () => {
  it('labels an open position Provisional', () => {
    render(
      <ComplianceCard
        compliance={makeCompliance({
          finality: 'provisional',
          entries: [makeEntry({ ruleId: 'c' })],
        })}
      />,
    );

    expect(screen.getByText('Provisional')).toBeTruthy();
    expect(screen.getByText('67')).toBeTruthy();
    expect(screen.queryByText('Final')).toBeNull();
  });

  it('labels a closed position Final', () => {
    render(
      <ComplianceCard
        compliance={makeCompliance({ finality: 'final', entries: [makeEntry({ ruleId: 'd' })] })}
      />,
    );

    expect(screen.getByText('Final')).toBeTruthy();
    expect(screen.queryByText('Provisional')).toBeNull();
  });
});
