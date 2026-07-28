import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import {
  FONT_BUDGET_BYTES,
  findFontFiles,
  checkFontBudget,
  extractFontFaceBlocks,
  checkFontFaces,
  checkReducedMotion,
} from '../check-fonts.mjs';

// A real reduced-motion block + two well-formed @font-face blocks (mirrors the
// shape Task 2/3 shipped into src/index.css).
const GOOD_FONT_FACE = `@font-face {
  font-family: 'Inter Variable';
  font-display: swap;
  src: url('./assets/fonts/inter-latin-variable-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153;
}`;

const REDUCED_MOTION_BLOCK = `@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; }
}`;

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Build a throwaway dist tree with the given font files (name -> byte length of
// HIGHLY-COMPRESSIBLE content so gzipped size is controllable).
function makeDistWithFonts(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-fonts-'));
  tmpDirs.push(dir);
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(assets, name), Buffer.alloc(bytes, 0));
  }
  return dir;
}

describe('FONT-TRANSFER budget check', () => {
  it('passes a small font set (under 150 KB gz)', () => {
    const dist = makeDistWithFonts({ 'a.woff2': 1024, 'b.woff2': 2048 });
    const fonts = findFontFiles(dist);
    expect(fonts).toHaveLength(2);
    const { findings, totalGz } = checkFontBudget(fonts);
    expect(totalGz).toBeLessThan(FONT_BUDGET_BYTES);
    expect(findings).toHaveLength(0);
  });

  it('fails an over-budget font set with a FONT-TRANSFER finding', () => {
    // Use random (incompressible) bytes so gzipped size ~= raw size and clears
    // the 150 KB budget deterministically.
    const big = Buffer.from(
      Array.from({ length: 200 * 1024 }, () => Math.floor(Math.random() * 256)),
    );
    const dir = mkdtempSync(join(tmpdir(), 'check-fonts-big-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'huge.ttf'), big);
    const fonts = findFontFiles(dir);
    const { findings, totalGz } = checkFontBudget(fonts);
    expect(totalGz).toBeGreaterThan(FONT_BUDGET_BYTES);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('FONT-TRANSFER');
  });

  it('only counts font extensions, recursing into subdirs', () => {
    const dist = makeDistWithFonts({ 'x.woff2': 64, 'y.woff': 64, 'z.ttf': 64 });
    // a non-font file in the same dir must be ignored
    writeFileSync(join(dist, 'assets', 'index.css'), 'body{}');
    const fonts = findFontFiles(dist);
    expect(fonts).toHaveLength(3);
  });

  it('returns an empty list when dist is missing', () => {
    expect(findFontFiles(join(tmpdir(), 'no-such-dist-xyz'))).toEqual([]);
  });
});

describe('@font-face hygiene check', () => {
  it('passes a swap + latin-unicode-range @font-face', () => {
    const css = GOOD_FONT_FACE;
    expect(extractFontFaceBlocks(css)).toHaveLength(1);
    expect(checkFontFaces(css)).toHaveLength(0);
  });

  it('passes font-display: optional', () => {
    const css = GOOD_FONT_FACE.replace('font-display: swap', 'font-display: optional');
    expect(checkFontFaces(css)).toHaveLength(0);
  });

  it('flags an @font-face missing font-display', () => {
    const css = GOOD_FONT_FACE.replace('\n  font-display: swap;', '');
    const findings = checkFontFaces(css);
    expect(findings.some((f) => f.includes('FONT-DISPLAY'))).toBe(true);
  });

  it('flags an @font-face that is not a latin subset', () => {
    // Drop the latin unicode-range and use a non-latin src filename.
    const css = `@font-face {
      font-family: 'Full Unicode';
      font-display: swap;
      src: url('./assets/fonts/full.woff2') format('woff2');
    }`;
    const findings = checkFontFaces(css);
    expect(findings.some((f) => f.includes('FONT-SUBSET'))).toBe(true);
  });

  it('accepts a latin-subset src filename even without unicode-range', () => {
    const css = `@font-face {
      font-family: 'Inter';
      font-display: swap;
      src: url('./assets/fonts/inter-latin-variable.woff2') format('woff2');
    }`;
    expect(checkFontFaces(css)).toHaveLength(0);
  });

  it('flags when there are no @font-face blocks at all', () => {
    const findings = checkFontFaces('body { color: red; }');
    expect(findings.some((f) => f.includes('FONT-FACE'))).toBe(true);
  });

  it('ignores a commented-out @font-face block (no false-positive findings)', () => {
    // A bad block (missing font-display, no latin subset) that WOULD fail if
    // treated as live, wrapped in a CSS comment alongside one live good block.
    const css = `/*
${GOOD_FONT_FACE.replace('\n  font-display: swap;', '').replace(
  "src: url('./assets/fonts/inter-latin-variable-wght-normal.woff2') format('woff2-variations');",
  "src: url('./assets/fonts/full.woff2') format('woff2');",
).replace('\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153;', '')}
*/
${GOOD_FONT_FACE}`;
    // Only the live block is extracted...
    expect(extractFontFaceBlocks(css)).toHaveLength(1);
    // ...and it produces no findings (the commented bad block is ignored).
    expect(checkFontFaces(css)).toHaveLength(0);
  });
});

describe('REDUCED-MOTION presence check', () => {
  it('passes when the prefers-reduced-motion: reduce block exists', () => {
    expect(checkReducedMotion(`a{}\n${REDUCED_MOTION_BLOCK}`)).toHaveLength(0);
  });

  it('flags index.css missing the reduced-motion block', () => {
    const findings = checkReducedMotion('body { color: red; }\n.dark { color: white; }');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('REDUCED-MOTION');
  });
});
