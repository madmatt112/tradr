// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDataQualityBannerState,
  DataQualityBanner,
  hasAnyDataQualityIssue,
  shouldShowHistoryOverlap,
  shouldShowTimeframeOverlap,
  type DataQuality,
} from './DataQualityBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function dq(over: Partial<DataQuality['timeframeExcluded']> = {}, hist = 0): DataQuality {
  const tf = { total: 0, unsupported: 0, mismatch: 0, ...over };
  // Maintain `total = max of contributing reasons` (DISTINCT-row count) when the
  // caller didn't pin it explicitly.
  if (over.total === undefined) {
    tf.total = Math.max(tf.unsupported, tf.mismatch);
  }
  return {
    timeframeExcluded: tf,
    historyExcluded: { total: hist, closed_at_null: hist },
  };
}

beforeEach(() => {
  sessionStorage.clear();
  __resetDataQualityBannerState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldShowTimeframeOverlap — disclaimer rule', () => {
  it('returns true when ≥ 2 per-reason counts in timeframe scope are non-zero', () => {
    expect(shouldShowTimeframeOverlap(dq({ unsupported: 5, mismatch: 3 }))).toBe(true);
  });

  it('returns false when only one per-reason count is non-zero', () => {
    expect(shouldShowTimeframeOverlap(dq({ unsupported: 5 }))).toBe(false);
    expect(shouldShowTimeframeOverlap(dq({ mismatch: 7 }))).toBe(false);
  });

  it('returns false when the scope is empty', () => {
    expect(shouldShowTimeframeOverlap(dq())).toBe(false);
  });
});

describe('shouldShowHistoryOverlap — single-reason scope', () => {
  it('returns false for the only history reason — single reason cannot overlap', () => {
    expect(shouldShowHistoryOverlap(dq({}, 5))).toBe(false);
  });
});

describe('hasAnyDataQualityIssue', () => {
  it('returns true when any scope has a non-zero total', () => {
    expect(hasAnyDataQualityIssue(dq({ unsupported: 1 }))).toBe(true);
    expect(hasAnyDataQualityIssue(dq({}, 2))).toBe(true);
  });

  it('returns false when both scopes are zero', () => {
    expect(hasAnyDataQualityIssue(dq())).toBe(false);
  });
});

describe('DataQualityBanner — render (SSR)', () => {
  it('renders nothing when no issues exist', () => {
    const html = renderToStaticMarkup(<DataQualityBanner dataQuality={dq()} />);
    expect(html).toBe('');
  });

  it('renders a dismiss button with cursor-pointer', () => {
    const html = renderToStaticMarkup(
      <DataQualityBanner dataQuality={dq({ unsupported: 5, total: 5 })} />,
    );
    expect(html).toContain('data-testid="data-quality-banner"');
    const btnMatch = html.match(/<button[^>]*data-testid="data-quality-banner-dismiss"[^>]*>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch?.[0]).toContain('cursor-pointer');
  });

  it('uses aria-live="polite" (informational)', () => {
    const html = renderToStaticMarkup(
      <DataQualityBanner dataQuality={dq({ unsupported: 1, total: 1 })} />,
    );
    expect(html).toContain('aria-live="polite"');
  });

  it('shows overlap disclaimer in timeframe section ONLY when ≥ 2 reasons non-zero', () => {
    const single = renderToStaticMarkup(
      <DataQualityBanner dataQuality={dq({ unsupported: 5, total: 5 })} />,
    );
    expect(single).not.toContain('some may have multiple issues');

    const multi = renderToStaticMarkup(
      <DataQualityBanner dataQuality={dq({ unsupported: 5, mismatch: 3, total: 7 })} />,
    );
    expect(multi).toContain('some may have multiple issues');
  });

  it('renders both timeframe and history sections when both have totals', () => {
    const html = renderToStaticMarkup(
      <DataQualityBanner dataQuality={dq({ unsupported: 5, total: 5 }, 3)} />,
    );
    expect(html).toContain('data-testid="data-quality-banner-timeframe"');
    expect(html).toContain('data-testid="data-quality-banner-history"');
  });
});

describe('DataQualityBanner — dismiss interaction (jsdom)', () => {
  it('clicking dismiss writes session flag and hides the banner', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<DataQualityBanner dataQuality={dq({ unsupported: 5, total: 5 })} />);
    });
    expect(container.querySelector('[data-testid="data-quality-banner"]')).not.toBeNull();

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="data-quality-banner-dismiss"]',
    );
    act(() => {
      btn!.click();
    });

    expect(container.querySelector('[data-testid="data-quality-banner"]')).toBeNull();
    // Session flag persisted under the reason-set key (timeframe:unsupported).
    expect(sessionStorage.getItem('perf.dq_dismissed.tf:unsupported|h:')).toBe('true');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('a previously-dismissed reason set stays dismissed across remount', () => {
    sessionStorage.setItem('perf.dq_dismissed.tf:unsupported|h:', 'true');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<DataQualityBanner dataQuality={dq({ unsupported: 5, total: 5 })} />);
    });
    // Banner should NOT render at all — already dismissed.
    expect(container.querySelector('[data-testid="data-quality-banner"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('Safari private-mode: setItem throws → fallback prevents re-display in same mount', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<DataQualityBanner dataQuality={dq({ unsupported: 5, total: 5 })} />);
    });

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="data-quality-banner-dismiss"]',
    );
    act(() => {
      btn!.click();
    });

    // Banner hides immediately via local state even when storage write fails.
    expect(container.querySelector('[data-testid="data-quality-banner"]')).toBeNull();
    expect(warn).toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
