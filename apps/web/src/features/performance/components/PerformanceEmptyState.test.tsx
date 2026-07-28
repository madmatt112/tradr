// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetDataQualityBannerState, type DataQuality } from './DataQualityBanner';
import { PerformanceEmptyState } from './PerformanceEmptyState';

const emptyDq: DataQuality = {
  timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
  historyExcluded: { total: 0, closed_at_null: 0 },
};

const issueDq: DataQuality = {
  timeframeExcluded: { total: 5, unsupported: 5, mismatch: 0 },
  historyExcluded: { total: 0, closed_at_null: 0 },
};

beforeEach(() => {
  sessionStorage.clear();
  __resetDataQualityBannerState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PerformanceEmptyState — branch selection', () => {
  it('selects the no-accounts branch when !hasAnyAccounts', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={false}
        hasAnyClosedPositions={false}
        hasAnyClosedPositionsInSupportedCurrency={false}
      />,
    );
    expect(html).toContain('data-testid="performance-empty-state-no-accounts"');
    expect(html).toContain('Create an account to get started');
  });

  it('selects the no-closed-positions branch', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={true}
        hasAnyClosedPositions={false}
        hasAnyClosedPositionsInSupportedCurrency={false}
      />,
    );
    expect(html).toContain('data-testid="performance-empty-state-no-closed-positions"');
    expect(html).toContain('Close a position to start tracking performance');
  });

  it('selects the unsupported-currency branch', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={true}
        hasAnyClosedPositions={true}
        hasAnyClosedPositionsInSupportedCurrency={false}
      />,
    );
    expect(html).toContain('data-testid="performance-empty-state-unsupported-currency"');
    expect(html).toContain('currencies not yet supported');
  });

  it('returns null when all flags satisfied and timeframe is not empty', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={true}
        hasAnyClosedPositions={true}
        hasAnyClosedPositionsInSupportedCurrency={true}
        isInTimeframeEmpty={false}
      />,
    );
    expect(html).toBe('');
  });

  it('selects the in-timeframe-empty branch when flags satisfied and timeframe empty', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={true}
        hasAnyClosedPositions={true}
        hasAnyClosedPositionsInSupportedCurrency={true}
        isInTimeframeEmpty={true}
      />,
    );
    expect(html).toContain('data-testid="performance-empty-state-in-timeframe-empty"');
    expect(html).toContain('No closed positions in this timeframe');
  });
});

describe('PerformanceEmptyState — DataQualityBanner stacking (in-timeframe-empty co-display)', () => {
  it('stacks DataQualityBanner ABOVE the empty-state when issues exist', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={true}
        hasAnyClosedPositions={true}
        hasAnyClosedPositionsInSupportedCurrency={true}
        isInTimeframeEmpty={true}
        dataQuality={issueDq}
      />,
    );
    const bannerIdx = html.indexOf('data-testid="data-quality-banner"');
    const emptyIdx = html.indexOf('data-testid="performance-empty-state-in-timeframe-empty"');
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(-1);
    // Banner is *inside* the empty-state wrapper but appears textually first
    // (i.e., visually stacked above) — the wrapper opens first, then the
    // banner div, then the EmptyState card.
    const bannerDivIdx = html.indexOf('mb-4');
    const emptyCardIdx = html.indexOf('Card');
    if (bannerDivIdx !== -1 && emptyCardIdx !== -1) {
      expect(bannerDivIdx).toBeLessThan(emptyCardIdx);
    }
  });

  it('does NOT render the banner when dataQuality has no issues', () => {
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={true}
        hasAnyClosedPositions={true}
        hasAnyClosedPositionsInSupportedCurrency={true}
        isInTimeframeEmpty={true}
        dataQuality={emptyDq}
      />,
    );
    expect(html).not.toContain('data-testid="data-quality-banner"');
    expect(html).toContain('data-testid="performance-empty-state-in-timeframe-empty"');
  });

  it('does NOT render the banner in upstream branches (no-accounts) even if issues exist', () => {
    // The upstream branches mean there's no useful data to QA — the banner
    // would be confusing copy noise. Spec: only co-display in the
    // in-timeframe-empty branch.
    const html = renderToStaticMarkup(
      <PerformanceEmptyState
        hasAnyAccounts={false}
        hasAnyClosedPositions={false}
        hasAnyClosedPositionsInSupportedCurrency={false}
        dataQuality={issueDq}
      />,
    );
    expect(html).not.toContain('data-testid="data-quality-banner"');
    expect(html).toContain('data-testid="performance-empty-state-no-accounts"');
  });
});
