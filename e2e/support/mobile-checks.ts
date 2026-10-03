import { expect, type Page } from '@playwright/test';

/**
 * Phone-register checks (mobile-pwa design C7, Requirements 6.1 and 6.2).
 *
 * Two assertions a route case runs after it renders at the iPhone 13 viewport:
 * nothing pushes the page wider than the screen, and every interactive target
 * is big enough to tap. The route cases that call these land in later tasks;
 * this file is the shared helper they build on.
 */

/**
 * Requirement 6.1 — no page-level sideways scroll. The document is never wider
 * than the viewport it renders in.
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `documentElement.scrollWidth (${scrollWidth}) must not exceed window.innerWidth (${innerWidth})`,
  ).toBeLessThanOrEqual(innerWidth);
}

/**
 * Requirement 6.2 — every visible interactive element has a bounding box of at
 * least `min` by `min` CSS px (24 by default).
 *
 * Skips, so the assertion is about what a finger can actually reach:
 *   - elements with no client rects (not laid out at all);
 *   - `visibility: hidden`;
 *   - a box of 1 by 1 px or less (the sr-only pattern);
 *   - anything under an `aria-hidden="true"` or `inert` ancestor.
 *
 * On failure it lists every offender as `{ selector, text, width, height }`.
 */
export async function expectTargetSizes(page: Page, min = 24): Promise<void> {
  const offenders = await page.evaluate((minSize) => {
    const SELECTOR = [
      'a[href]',
      'button',
      'input:not([type=hidden])',
      'select',
      'textarea',
      'summary',
      '[role=button]',
      '[role=link]',
      '[role=tab]',
      '[role=checkbox]',
      '[role=switch]',
      '[role=menuitem]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const className = typeof el.className === 'string' ? el.className.trim() : '';
      const cls = className ? `.${className.split(/\s+/).slice(0, 2).join('.')}` : '';
      return `${tag}${id}${cls}`;
    }

    const found: { selector: string; text: string; width: number; height: number }[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (el.getClientRects().length === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const rect = el.getBoundingClientRect();
      // sr-only lives in a 1px (or smaller) box — not a real target.
      if (rect.width <= 1 && rect.height <= 1) continue;
      if (rect.width < minSize || rect.height < minSize) {
        found.push({
          selector: describe(el),
          text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        });
      }
    }
    return found;
  }, min);

  expect(
    offenders,
    `interactive targets smaller than ${min}x${min} px:\n${offenders
      .map((o) => `  ${o.selector} "${o.text}" ${o.width}x${o.height}`)
      .join('\n')}`,
  ).toEqual([]);
}
