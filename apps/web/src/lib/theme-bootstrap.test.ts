// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyBootTheme, INLINE_BOOT_SCRIPT_SOURCE } from './theme-bootstrap';

function setCookie(value: string): void {
  document.cookie = `tradr_theme=${value}; path=/`;
}

function clearCookie(): void {
  document.cookie = 'tradr_theme=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

function mockMatchMedia(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('applyBootTheme', () => {
  beforeEach(() => {
    clearCookie();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    clearCookie();
    document.documentElement.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it('missing cookie + matchMedia matches:false → applies light (no .dark class)', () => {
    mockMatchMedia(false);
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('missing cookie + matchMedia matches:true → applies dark (.dark class)', () => {
    mockMatchMedia(true);
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('valid cookie "light" → applies light (removes .dark class)', () => {
    document.documentElement.classList.add('dark');
    setCookie('light');
    mockMatchMedia(true); // should be ignored
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('valid cookie "dark" → applies .dark class', () => {
    setCookie('dark');
    mockMatchMedia(false); // should be ignored
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('valid cookie "system" → defers to matchMedia (matches:true → dark)', () => {
    setCookie('system');
    mockMatchMedia(true);
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('invalid cookie "magenta" → matchMedia fallback (treated as missing)', () => {
    setCookie('magenta');
    mockMatchMedia(true);
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('whitespace cookie " " → matchMedia fallback (not in allowlist)', () => {
    setCookie(' ');
    mockMatchMedia(true);
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('URL-encoded valid value "%6cight" → decoded to "light" and applied', () => {
    document.documentElement.classList.add('dark');
    setCookie('%6cight');
    mockMatchMedia(true); // should be ignored
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('uppercase "DARK" → matchMedia fallback (case-sensitive allowlist)', () => {
    setCookie('DARK');
    mockMatchMedia(false);
    applyBootTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('INLINE_BOOT_SCRIPT_SOURCE matches index.html inline script (§H-r4 drift guard)', () => {
    const indexHtmlPath = path.resolve(__dirname, '../../index.html');
    const html = readFileSync(indexHtmlPath, 'utf8');

    const startSentinel = '<!-- tradr:boot-theme -->';
    const endSentinel = '<!-- /tradr:boot-theme -->';
    const startIdx = html.indexOf(startSentinel);
    const endIdx = html.indexOf(endSentinel);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    let block = html.slice(startIdx + startSentinel.length, endIdx);
    // Strip <script> opening tag (allow attributes) and </script> closing tag.
    block = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    // Trim leading/trailing blank lines (preserve interior).
    block = block.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');

    // Dedent: compute the minimum leading-whitespace across non-blank lines, strip it.
    const lines = block.split('\n');
    const nonBlank = lines.filter((l) => l.trim().length > 0);
    const minIndent = nonBlank.reduce((min, l) => {
      const m = l.match(/^[ \t]*/);
      const indent = m ? m[0].length : 0;
      return Math.min(min, indent);
    }, Number.POSITIVE_INFINITY);
    const dedentN = Number.isFinite(minIndent) ? minIndent : 0;
    const dedented = lines
      .map((l) => (l.length >= dedentN ? l.slice(dedentN) : l))
      .join('\n')
      .trim();

    expect(dedented).toEqual(INLINE_BOOT_SCRIPT_SOURCE.trim());
  });
});

// Contract — Requirement 1.5 (D7): applyBootTheme() sets the browser's
// theme-color before first paint when the cookie-resolved theme differs
// from the system scheme. Pre-condition: two `meta[name="theme-color"]`
// elements exist in <head> (one per `prefers-color-scheme` media value), as
// index.html ships them (design C1). Call: `applyBootTheme()`. Observable
// result: both metas' `content` attribute. Expected value source: design
// C1's hex literals (`#ffffff` light, `#0c0d0f` dark — the culori
// conversion of the `--color-background` tokens at apps/web/src/index.css:47
// and :149, cross-checked in pwaColors.test.ts).
//
// Note: the companion D7 clause ("a `system` or absent cookie leaves the
// metas alone") cannot be authored as a red test here — with no branch
// implemented yet, the metas are never touched by any cookie value, so an
// assertion of "unchanged on system" passes vacuously at base (RED-IMPOSSIBLE).
// It becomes a meaningful regression check only once the light/dark branch
// below exists; flagged for the implementer brief.
function addThemeColorMetas(lightContent: string, darkContent: string): void {
  const light = document.createElement('meta');
  light.setAttribute('name', 'theme-color');
  light.setAttribute('media', '(prefers-color-scheme: light)');
  light.setAttribute('content', lightContent);
  document.head.appendChild(light);

  const dark = document.createElement('meta');
  dark.setAttribute('name', 'theme-color');
  dark.setAttribute('media', '(prefers-color-scheme: dark)');
  dark.setAttribute('content', darkContent);
  document.head.appendChild(dark);
}

function removeThemeColorMetas(): void {
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
}

function themeColorContents(): string[] {
  return Array.from(document.querySelectorAll('meta[name="theme-color"]')).map(
    (el) => el.getAttribute('content') ?? '',
  );
}

describe('applyBootTheme — theme-color metas (Requirement 1.5)', () => {
  beforeEach(() => {
    clearCookie();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    clearCookie();
    document.documentElement.classList.remove('dark');
    removeThemeColorMetas();
    vi.restoreAllMocks();
  });

  it('cookie "dark" (system prefers light, so the resolved theme differs) sets both theme-color metas to #0c0d0f', () => {
    addThemeColorMetas('#ffffff', '#0c0d0f');
    setCookie('dark');
    mockMatchMedia(false); // system prefers light
    applyBootTheme();
    expect(themeColorContents()).toEqual(['#0c0d0f', '#0c0d0f']);
  });

  it('cookie "light" (system prefers dark, so the resolved theme differs) sets both theme-color metas to #ffffff', () => {
    addThemeColorMetas('#ffffff', '#0c0d0f');
    setCookie('light');
    mockMatchMedia(true); // system prefers dark
    applyBootTheme();
    expect(themeColorContents()).toEqual(['#ffffff', '#ffffff']);
  });
});
