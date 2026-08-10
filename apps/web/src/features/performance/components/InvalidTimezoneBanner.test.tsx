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
    expect(html).toContain('We could not resolve your reporting timezone');
    expect(html).not.toContain('browser timezone');
  });

  // This is the state where changing the preference IS the fix: the request
  // carried the stored reporting timezone and the server rejected it.
  it('links to profile settings as the place to change the preference', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={false} />);
    const link = html.match(
      /<a[^>]*data-testid="invalid-timezone-banner-settings-link"[^>]*>[^<]*<\/a>/,
    );
    expect(link).not.toBeNull();
    expect(link?.[0]).toContain('href="/settings/profile"');
    expect(link?.[0]).toContain('cursor-pointer');
    expect(link?.[0]).toContain('profile settings');
  });

  // `tz` lives in this page's URL, seeded by the sidebar from the stored
  // preference. Saving a new preference does not rewrite an already-loaded
  // `/performance?tz=…`, so the copy must not imply the change lands here.
  it('says the new preference applies on re-entry from the sidebar', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={false} />);
    expect(html).toContain('reopen Performance from the sidebar');
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

  // This state is only reached after the retry OMITTED `tz`, so the server
  // validated its own `UTC` default and rejected that. The stored preference
  // is not what failed — the copy must name the server, not the browser, and
  // must not promise a fix the user cannot perform.
  it('attributes the failure to the server rejecting UTC, not the browser', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={true} />);
    expect(html).toContain('the server rejected UTC as well');
    expect(html).toContain('a problem on the server');
    expect(html).not.toContain('browser timezone');
  });

  it('offers no profile-settings remedy, which cannot resolve this state', () => {
    const html = renderToStaticMarkup(<InvalidTimezoneBanner isSecondFailure={true} />);
    expect(html).not.toContain('/settings/profile');
    expect(html).not.toContain('invalid-timezone-banner-settings-link');
    expect(html).not.toContain('profile settings');
  });
});

// `AlertDescription` is `display: grid` with `gap-1`, so every direct child —
// including each anonymous run of text around an inline `<a>` — becomes its own
// GRID ITEM and lands on its own row. Mixed inline content must therefore sit
// inside a single `<p>` (the convention `DataQualityBanner` follows, and what
// the description's `[&_p]:leading-relaxed` selector exists for). Asserting a
// single element child with no stray text nodes is the DOM-level invariant that
// keeps the sentence to one flow.
describe('InvalidTimezoneBanner — description is a single grid item', () => {
  function renderInto(isSecondFailure: boolean) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<InvalidTimezoneBanner isSecondFailure={isSecondFailure} />);
    });
    const desc = container.querySelector('[data-slot="alert-description"]')!;
    return { container, root, desc };
  }

  for (const isSecondFailure of [false, true]) {
    it(`wraps the ${isSecondFailure ? 'second' : 'first'}-failure copy in one <p>`, () => {
      const { container, root, desc } = renderInto(isSecondFailure);

      expect(Array.from(desc.childNodes).map((n) => n.nodeName)).toEqual(['P']);

      act(() => {
        root.unmount();
      });
      container.remove();
    });
  }

  it('keeps the settings link inside that <p>, not as a sibling grid item', () => {
    const { container, root, desc } = renderInto(false);

    const link = desc.querySelector('[data-testid="invalid-timezone-banner-settings-link"]')!;
    expect(link).not.toBeNull();
    expect(link.parentElement?.nodeName).toBe('P');
    expect(link.parentElement).toBe(desc.firstElementChild);

    act(() => {
      root.unmount();
    });
    container.remove();
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
