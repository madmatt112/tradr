// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetInvalidTimezoneBannerState, InvalidTimezoneBanner } from './InvalidTimezoneBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  sessionStorage.clear();
  __resetInvalidTimezoneBannerState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InvalidTimezoneBanner — first failure (dismissible, polite)', () => {
  it('renders dismiss button with cursor-pointer', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={false} />);
    expect(html).toContain('data-testid="invalid-timezone-banner"');
    const btnMatch = html.match(/<button[^>]*data-testid="invalid-timezone-banner-dismiss"[^>]*>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch?.[0]).toContain('cursor-pointer');
  });

  it('uses aria-live="polite"', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={false} />);
    expect(html).toContain('aria-live="polite"');
  });

  it('shows "Dates shown in UTC" copy', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={false} />);
    expect(html).toContain('Dates shown in UTC');
  });

  it('clicking dismiss writes session flag and hides the banner', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<InvalidTimezoneBanner isSecondFailure={false} />);
    });

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="invalid-timezone-banner-dismiss"]',
    );
    act(() => {
      btn!.click();
    });

    expect(container.querySelector('[data-testid="invalid-timezone-banner"]')).toBeNull();
    expect(sessionStorage.getItem('perf.invalid_tz_first_dismissed')).toBe('true');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('a remount honors the previously-dismissed session flag', () => {
    sessionStorage.setItem('perf.invalid_tz_first_dismissed', 'true');
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={false} />);
    expect(html).toBe('');
  });
});

describe('InvalidTimezoneBanner — second failure (non-dismissible, assertive)', () => {
  it('renders WITHOUT a dismiss button', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={true} />);
    expect(html).toContain('data-testid="invalid-timezone-banner"');
    expect(html).not.toContain('data-testid="invalid-timezone-banner-dismiss"');
    // The only element on the banner is informational — no button at all.
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(0);
  });

  it('uses aria-live="assertive"', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={true} />);
    expect(html).toContain('aria-live="assertive"');
  });

  it('renders even when the first-failure session flag is set (second failure overrides)', () => {
    sessionStorage.setItem('perf.invalid_tz_first_dismissed', 'true');
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={true} />);
    expect(html).toContain('data-testid="invalid-timezone-banner"');
    expect(html).toContain('aria-live="assertive"');
  });

  it('uses destructive variant', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={true} />);
    expect(html).toContain('data-second-failure="true"');
  });
});

describe('InvalidTimezoneBanner — Safari private mode (setItem throws)', () => {
  it('first-failure dismiss still hides banner via local state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<InvalidTimezoneBanner isSecondFailure={false} />);
    });
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="invalid-timezone-banner-dismiss"]',
    );
    act(() => {
      btn!.click();
    });

    expect(container.querySelector('[data-testid="invalid-timezone-banner"]')).toBeNull();
    expect(warn).toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
