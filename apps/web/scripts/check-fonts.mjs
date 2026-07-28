#!/usr/bin/env node
// Font-asset + reduced-motion CI gate (visual-design Task 8; design Component 6
// / Req 9.4, 11.3, 12.3).
//
// A node gate DISTINCT from the font-blind JS bundle gate (check-bundle-size.mjs)
// that enforces three properties against the BUILT `dist/` + the source
// `src/index.css`:
//
//   1. FONT-TRANSFER BUDGET — the total gzipped size of every emitted font
//      asset (*.woff2 / *.woff / *.ttf) in dist/ must be <= 150 KB. This is a
//      pinned, concrete number (150 KB gz), not a vague "within budget". The
//      gzip-of-emitted-assets approach mirrors check-bundle-size.mjs.
//   2. @font-face HYGIENE — every `@font-face` block in src/index.css must carry
//      `font-display: swap` (or `optional`) AND reference a latin-subset file
//      (the block declares a `unicode-range` covering latin, OR its src url
//      names a latin-subset file). A render-blocking webface or a full-unicode
//      font is a finding.
//   3. REDUCED-MOTION — the global `@media (prefers-reduced-motion: reduce)`
//      block must exist in src/index.css. Presence check ONLY — the
//      essential-motion enumeration is a human review artifact, not a checker.
//
// Emitted fonts are discovered by walking dist/ for font file extensions (fonts
// are NOT in the Vite JS manifest; Vite emits them as hashed assets referenced
// from CSS), mirroring check-bundle-size.mjs's gzip-sizing of emitted assets.
//
// CI-FAILING MODE: prints every finding and EXITS 1 on any finding (Task 19
// flipped REPORT_MODE off once all surfaces were migrated, R9.6).
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const distDir = resolve(webRoot, 'dist');
const indexCssPath = resolve(webRoot, 'src', 'index.css');

const REPORT_MODE = false; // CI-failing (Task 19 flipped report → fail, R9.6).

// Pinned font-transfer budget: 150 KB gzipped total across all emitted fonts.
export const FONT_BUDGET_BYTES = 150 * 1024;
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf']);

// ---- gzip-sizing of emitted font assets (mirrors check-bundle-size.mjs) -----

function gzipSize(absPath) {
  return gzipSync(readFileSync(absPath)).length;
}

// Walk a directory tree and return absolute paths of every font asset.
export function findFontFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findFontFiles(abs));
    } else if (FONT_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(abs);
    }
  }
  return out;
}

// Sum gzipped font transfer and emit a finding if over budget.
// Returns { totalGz, files: [{ file, gz }], findings: [...] }.
export function checkFontBudget(fontFiles, budget = FONT_BUDGET_BYTES) {
  const files = fontFiles.map((abs) => ({ file: abs, gz: gzipSize(abs) }));
  const totalGz = files.reduce((sum, f) => sum + f.gz, 0);
  const findings = [];
  if (totalGz > budget) {
    findings.push(
      `[FONT-TRANSFER] total emitted font transfer ${totalGz} bytes gz > budget ${budget} bytes gz (150 KB)`,
    );
  }
  return { totalGz, files, findings };
}

// ---- @font-face hygiene ------------------------------------------------------

// Extract each `@font-face { ... }` block body from CSS source. Strip CSS
// comments first so a commented-out `@font-face` block is not parsed as live
// (which would produce false-positive FONT-DISPLAY / FONT-SUBSET findings).
export function extractFontFaceBlocks(css) {
  const blocks = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /@font-face\s*\{/gi;
  let m;
  while ((m = re.exec(stripped))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < stripped.length && depth > 0; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') depth--;
    }
    blocks.push(stripped.slice(start, i - 1));
  }
  return blocks;
}

// A latin subset is proven either by a `unicode-range` containing the latin
// basic-latin / latin-1 range (U+0000-00FF), OR by a src url naming a
// latin-subset file (…-latin… in the filename).
function isLatinSubset(block) {
  const ur = /unicode-range\s*:\s*([^;]+);/i.exec(block);
  if (ur && /U\+0+-0*FF/i.test(ur[1].replace(/\s+/g, ''))) return true;
  return /url\(\s*['"]?[^'")]*latin[^'")]*['"]?\s*\)/i.test(block);
}

// Assert font-display: swap|optional AND a latin subset for every @font-face.
// Returns a list of finding strings (one per offending property per block).
export function checkFontFaces(css) {
  const findings = [];
  const blocks = extractFontFaceBlocks(css);
  if (blocks.length === 0) {
    findings.push('[FONT-FACE] no @font-face blocks found in index.css');
    return findings;
  }
  blocks.forEach((block, idx) => {
    const family = (/font-family\s*:\s*([^;]+);/i.exec(block) || [, `#${idx}`])[1].trim();
    const display = /font-display\s*:\s*(swap|optional)\b/i.test(block);
    if (!display) {
      findings.push(
        `[FONT-DISPLAY] @font-face ${family} missing 'font-display: swap' (or optional) — webfont is render-blocking`,
      );
    }
    if (!isLatinSubset(block)) {
      findings.push(
        `[FONT-SUBSET] @font-face ${family} is not a latin subset — missing latin unicode-range and no latin-subset src file`,
      );
    }
  });
  return findings;
}

// ---- reduced-motion presence -------------------------------------------------

// Assert the global prefers-reduced-motion: reduce block exists.
export function checkReducedMotion(css) {
  const present = /@media[^{]*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(css);
  return present
    ? []
    : [
        '[REDUCED-MOTION] no global @media (prefers-reduced-motion: reduce) block found in index.css',
      ];
}

// ---- main --------------------------------------------------------------------

function main() {
  const findings = [];

  // 1. Font-transfer budget against emitted dist fonts.
  const fontFiles = findFontFiles(distDir);
  const budget = checkFontBudget(fontFiles);
  const kb = (budget.totalGz / 1024).toFixed(1);
  if (fontFiles.length === 0) {
    console.log(
      `font transfer: 0 emitted font assets found under ${distDir} (build dist/ before running this gate)`,
    );
  } else {
    console.log(
      `font transfer: ${fontFiles.length} emitted font asset(s) = ${budget.totalGz} bytes gz (${kb} KB) (budget: ${FONT_BUDGET_BYTES} bytes gz / 150 KB)`,
    );
  }
  findings.push(...budget.findings);

  // 2 + 3. @font-face hygiene + reduced-motion presence against index.css.
  let css;
  try {
    css = readFileSync(indexCssPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      findings.push(`[INDEX-CSS] index.css missing at ${indexCssPath}`);
      css = null;
    } else {
      throw err;
    }
  }

  if (css != null) {
    const faceFindings = checkFontFaces(css);
    findings.push(...faceFindings);
    if (faceFindings.length === 0) {
      console.log(
        `@font-face: ${extractFontFaceBlocks(css).length} block(s), all carry font-display swap/optional + latin subset`,
      );
    }

    const motionFindings = checkReducedMotion(css);
    findings.push(...motionFindings);
    if (motionFindings.length === 0) {
      console.log('reduced-motion: global @media (prefers-reduced-motion: reduce) block present');
    }
  }

  if (findings.length === 0) {
    console.log('font + reduced-motion gate OK — 0 findings');
  } else {
    console.log(`font + reduced-motion findings (${findings.length}):`);
    for (const f of findings) {
      if (REPORT_MODE) console.warn(`::warning::${f}`);
      else console.error(`::error::${f}`);
    }
  }

  if (REPORT_MODE) {
    console.log('\n[report mode] exit 0 (warn-only).');
    process.exit(0);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
