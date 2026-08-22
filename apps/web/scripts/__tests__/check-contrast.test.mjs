import { describe, it, expect } from 'vitest';

import {
  extractBlockBody,
  parseDeclarations,
  resolveAliases,
  gamutMapToSrgb,
  relativeLuminance,
  contrastRatio,
  composite,
  deltaEOK,
} from '../check-contrast.mjs';
import { parse } from 'culori';

// The gate's trustworthiness rests on the hand-rolled WCAG-ratio function, so
// pin it against known reference pairs.
describe('contrastRatio (hand-rolled WCAG) reference pairs', () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 1, g: 1, b: 1 };
  // #777777 sRGB channel value.
  const midGrey = { r: 0x77 / 255, g: 0x77 / 255, b: 0x77 / 255 };

  it('black on white = 21:1', () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    // symmetric
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
  });

  it('white on white = 1:1', () => {
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it('mid-grey #777 vs white ≈ 4.48:1', () => {
    expect(contrastRatio(midGrey, white)).toBeCloseTo(4.48, 1);
  });

  it('mid-grey #777 vs black ≈ 4.69:1', () => {
    expect(contrastRatio(midGrey, black)).toBeCloseTo(4.69, 1);
  });

  it('relativeLuminance: black=0, white=1', () => {
    expect(relativeLuminance(black)).toBeCloseTo(0, 6);
    expect(relativeLuminance(white)).toBeCloseTo(1, 6);
  });
});

describe('gamutMapToSrgb (CSS Color 4 gamut mapping)', () => {
  it('maps pure-black/white OKLCH to sRGB extremes', () => {
    const k = gamutMapToSrgb('oklch(0 0 0)');
    const w = gamutMapToSrgb('oklch(1 0 0)');
    expect(k.r).toBeCloseTo(0, 4);
    expect(w.r).toBeCloseTo(1, 4);
    // round-trips to 21:1 through the hand-rolled ratio.
    expect(contrastRatio(k, w)).toBeCloseTo(21, 4);
  });

  it('gamut-maps an out-of-sRGB OKLCH into [0,1] (not a per-channel clamp)', () => {
    // A high-chroma green is outside sRGB; gamut mapping pulls it in-gamut by
    // reducing chroma, keeping every channel within [0,1].
    const c = gamutMapToSrgb('oklch(0.7 0.4 150)');
    // Allow a tiny floating-point epsilon around the [0,1] gamut bounds.
    const eps = 1e-9;
    for (const ch of [c.r, c.g, c.b]) {
      expect(ch).toBeGreaterThanOrEqual(-eps);
      expect(ch).toBeLessThanOrEqual(1 + eps);
    }
  });

  it('throws on an unparseable color', () => {
    expect(() => gamutMapToSrgb('not-a-color')).toThrow();
  });
});

describe('CSS block parse + var() alias resolution (small fixture)', () => {
  const fixture = `
    @theme {
      --color-focus: oklch(0.62 0.13 240);
      --color-ring: var(--color-focus);
      --color-fallback: var(--color-missing, oklch(0.5 0 0));
    }
    .dark {
      --color-focus: oklch(0.70 0.13 240);
    }
  `;

  it('extracts @theme and .dark bodies independently', () => {
    const theme = extractBlockBody(fixture, '@theme');
    const dark = extractBlockBody(fixture, '.dark');
    expect(theme).toContain('--color-focus');
    expect(theme).toContain('--color-ring');
    expect(dark).toContain('--color-focus');
    expect(dark).not.toContain('--color-ring');
  });

  it('resolves a var() alias to the concrete target value before any math', () => {
    const map = parseDeclarations(extractBlockBody(fixture, '@theme'));
    const resolved = resolveAliases(map);
    expect(resolved.get('--color-ring')).toBe(resolved.get('--color-focus'));
    expect(resolved.get('--color-ring')).toBe('oklch(0.62 0.13 240)');
  });

  it('uses the var() fallback when the target is absent', () => {
    const map = parseDeclarations(extractBlockBody(fixture, '@theme'));
    const resolved = resolveAliases(map);
    expect(resolved.get('--color-fallback')).toBe('oklch(0.5 0 0)');
  });
});

describe('composite (source-over alpha over an opaque surface)', () => {
  it('alpha=1 returns the foreground; alpha=0 returns the surface', () => {
    const fg = { r: 1, g: 0, b: 0 };
    const bg = { r: 0, g: 0, b: 1 };
    expect(composite(fg, 1, bg)).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(composite(fg, 0, bg)).toMatchObject({ r: 0, g: 0, b: 1 });
  });

  it('alpha=0.1 blends 10% foreground over the surface', () => {
    const out = composite({ r: 1, g: 1, b: 1 }, 0.1, { r: 0, g: 0, b: 0 });
    expect(out.r).toBeCloseTo(0.1, 6);
  });
});

describe('deltaEOK (OKLab Euclidean distinctness)', () => {
  it('identical colors have ΔEOK 0', () => {
    expect(deltaEOK(parse('oklch(0.7 0.13 240)'), parse('oklch(0.7 0.13 240)'))).toBeCloseTo(0, 6);
  });

  it('clearly distinct hues exceed the 0.05 threshold', () => {
    expect(deltaEOK(parse('oklch(0.6 0.2 27)'), parse('oklch(0.6 0.2 150)'))).toBeGreaterThan(0.05);
  });
});

describe('extractBlockBody selector escaping', () => {
  it('locates a block whose selector contains regex metacharacters', () => {
    const css = `:root { --a: 1; }\n:root[data-theme='light'] { --b: 2; }\n`;
    const body = extractBlockBody(css, ":root[data-theme='light']");
    expect(body).not.toBeNull();
    expect(parseDeclarations(body).get('--b')).toBe('2');
  });

  it('does not let an unescaped dot match arbitrary characters', () => {
    // Before the escape fix, ".dark" compiled to the regex /.dark\s*\{/ and
    // would match "xdark {" — the dot must be literal.
    const css = `xdark { --a: 1; }\n.dark { --b: 2; }\n`;
    const body = extractBlockBody(css, '.dark');
    expect(parseDeclarations(body).get('--b')).toBe('2');
    expect(parseDeclarations(body).has('--a')).toBe(false);
  });
});
