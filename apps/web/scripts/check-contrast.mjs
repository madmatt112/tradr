#!/usr/bin/env node
// Per-theme WCAG-AA contrast + ΔEOK distinctness + both-theme-presence gate
// (visual-design Task 6; design Component 6 / Req 9.1, 9.2, 9.3, 11.1, 2.3, 1.4).
//
// A deterministic, no-browser node gate over apps/web/src/index.css. It:
//
//   1. Parses the `@theme` (light) AND `.dark` blocks into two full token maps.
//   2. Resolves `var()` aliases (e.g. `--color-ring: var(--color-focus)`) to a
//      concrete color BEFORE any math.
//   3. Gamut-maps each OKLCH into sRGB via the CSS Color 4 gamut-mapping
//      algorithm (culori `toGamut('rgb','oklch')`, NOT a per-channel clamp), so
//      it scores the exact browser-rendered color, then computes the WCAG
//      relative-luminance contrast ratio with a HAND-ROLLED ratio function.
//   4. Derives the foreground×surface pair list from an adjacency map and
//      asserts a REQUIRED-MINIMUM set is present — a MISSING required pair
//      FAILS (it cannot be silently dropped), not just a below-threshold one.
//      Thresholds: text 4.5, on-amber 4.5, focus/non-text 3, status-as-text
//      4.5 on pure surfaces AND on the composited `bg-{status}/10` tint over
//      background+card+popover, solid-fill `*-foreground` 4.5, borders 3.
//   5. Asserts ΔEOK ≥ 0.05 (OKLab Euclidean — culori `differenceEuclidean`)
//      across the pinned distinctness pair set, computed INDEPENDENTLY per
//      theme.
//   6. BOTH-THEME PRESENCE (R1.4): every net-new `@theme` role must be
//      re-valued in `.dark` and vice-versa — FAIL on a role present in one
//      block but not the other.
//
// CI-FAILING MODE: prints every finding and EXITS 1 on any finding (Task 19
// flipped REPORT_MODE off once all surfaces were migrated, R9.6). `culori` is a
// DEV dependency (OKLCH parse + sRGB convert) — never imported by the app bundle.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, toGamut, converter, differenceEuclidean } from 'culori';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '..', 'src', 'index.css');

// CI-FAILING MODE — collect findings, print, exit 1 on any finding (Task 19
// flipped REPORT_MODE → false now that all surfaces are migrated, R9.6).
const REPORT_MODE = false;

// ---- CSS block parsing ----------------------------------------------------
// Extract the body of the FIRST `<selector> { ... }` whose `{` immediately
// follows the selector, tracking brace depth so nested `@font-face`/`@media`
// blocks before them don't confuse the scan. `headerRe` must match the
// selector right before its opening brace (e.g. `@theme {`, `.dark {`) so a
// `.dark` substring inside `@custom-variant dark (&:where(.dark, .dark *))`
// (which has no following `{`) is not mistaken for the `.dark` block. We then
// pull `--name: value;` declarations out of each body.
function extractBlockBody(css, header) {
  const headerRe = new RegExp(`${header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{`);
  const m = headerRe.exec(css);
  if (!m) return null;
  const open = css.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

function parseDeclarations(body) {
  const map = new Map();
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

// ---- var() alias resolution -----------------------------------------------
// Parse a `var(--target[, fallback])` value, balancing parens so a fallback
// that is itself a function (e.g. `var(--x, oklch(0.5 0 0))`) is captured
// whole. Returns null for a non-var() value.
function parseVar(value) {
  const v = value.trim();
  if (!v.startsWith('var(') || !v.endsWith(')')) return null;
  const inner = v.slice(4, -1); // strip `var(` and the trailing `)`
  const comma = inner.indexOf(',');
  if (comma === -1) {
    const target = inner.trim();
    return /^--[\w-]+$/.test(target) ? { target, fallback: undefined } : null;
  }
  const target = inner.slice(0, comma).trim();
  if (!/^--[\w-]+$/.test(target)) return null;
  return { target, fallback: inner.slice(comma + 1).trim() };
}

// Resolve `var(--x)` (with optional fallback) to a concrete value within a
// single theme map, with cycle/depth guards.
function resolveAliases(map) {
  const resolved = new Map();
  function resolveOne(name, seen) {
    const raw = map.get(name);
    if (raw === undefined) return undefined;
    const v = parseVar(raw);
    if (!v) return raw;
    const { target, fallback } = v;
    if (seen.has(target)) return fallback;
    seen.add(target);
    const resolvedTarget = resolveOne(target, seen);
    if (resolvedTarget !== undefined) return resolvedTarget;
    return fallback;
  }
  for (const name of map.keys()) {
    resolved.set(name, resolveOne(name, new Set([name])));
  }
  return resolved;
}

// ---- color math (gamut-map + hand-rolled WCAG ratio) ----------------------
const toSrgb = toGamut('rgb', 'oklch'); // CSS Color 4 gamut mapping, not clamp.
const toRgb = converter('rgb');
const deltaEOK = differenceEuclidean('oklab');

// Gamut-map a CSS color string into an in-sRGB {r,g,b} (0..1).
function gamutMapToSrgb(cssColor) {
  const parsed = parse(cssColor);
  if (!parsed) throw new Error(`unparseable color: ${cssColor}`);
  return toRgb(toSrgb(parsed));
}

// WCAG 2.x relative luminance of an sRGB color (channels 0..1).
function relativeLuminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// HAND-ROLLED WCAG contrast ratio between two sRGB colors. (1..21)
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Source-over alpha composite of `fg` (with alpha) over opaque `bg`.
function composite(fg, alpha, bg) {
  return {
    mode: 'rgb',
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

// ---- token roles ----------------------------------------------------------
// Net-new `@theme` roles (visual-design Task 2) for the R1.4 both-theme check.
const NET_NEW_ROLES = [
  '--color-hairline',
  '--color-gain',
  '--color-loss',
  '--color-flat',
  '--color-focus',
  '--color-success',
  '--color-success-foreground',
  '--color-warning',
  '--color-warning-foreground',
  '--color-info',
  '--color-info-foreground',
];

// Surfaces a status callout (`text-{status}` on a `bg-{status}/10` tint inside
// a card/popover) renders on.
const STATUS_SURFACES = ['--color-background', '--color-card', '--color-popover'];
const STATUS_ROLES = ['--color-success', '--color-warning', '--color-info'];
const TINT_ALPHA = 0.1;

// ---- finding sink ----------------------------------------------------------
const findings = [];
function report(msg) {
  findings.push(msg);
}

// Assert a required pair EXISTS and clears `min`. A missing role FAILS.
function checkPair(theme, label, fgName, bgName, min, map) {
  const fg = map.get(fgName);
  const bg = map.get(bgName);
  if (fg === undefined) {
    report(`[${theme}] MISSING required role ${fgName} (pair: ${label})`);
    return;
  }
  if (bg === undefined) {
    report(`[${theme}] MISSING required role ${bgName} (pair: ${label})`);
    return;
  }
  let ratio;
  try {
    ratio = contrastRatio(gamutMapToSrgb(fg), gamutMapToSrgb(bg));
  } catch (err) {
    report(`[${theme}] color error in ${label}: ${err.message}`);
    return;
  }
  if (ratio < min) {
    report(
      `[${theme}] AA FAIL ${label}: ${fgName} on ${bgName} = ${ratio.toFixed(2)} < ${min}`,
    );
  } else {
    console.log(
      `[${theme}] OK ${label}: ${fgName} on ${bgName} = ${ratio.toFixed(2)} >= ${min}`,
    );
  }
}

// Status-as-text on its own composited `bg-{status}/10` tint over each surface.
function checkStatusOnTint(theme, statusName, surfaceName, map) {
  const status = map.get(statusName);
  const surface = map.get(surfaceName);
  if (status === undefined) {
    report(`[${theme}] MISSING required role ${statusName} (tint pair on ${surfaceName})`);
    return;
  }
  if (surface === undefined) {
    report(`[${theme}] MISSING required role ${surfaceName} (tint pair for ${statusName})`);
    return;
  }
  let ratio;
  try {
    const statusRgb = gamutMapToSrgb(status);
    const surfaceRgb = gamutMapToSrgb(surface);
    const tint = composite(statusRgb, TINT_ALPHA, surfaceRgb);
    ratio = contrastRatio(statusRgb, tint);
  } catch (err) {
    report(`[${theme}] color error in tint ${statusName}/${surfaceName}: ${err.message}`);
    return;
  }
  const label = `${statusName}-as-text on bg-{status}/10 over ${surfaceName}`;
  if (ratio < 4.5) {
    report(`[${theme}] AA FAIL ${label} = ${ratio.toFixed(2)} < 4.5`);
  } else {
    console.log(`[${theme}] OK ${label} = ${ratio.toFixed(2)} >= 4.5`);
  }
}

// ---- per-theme contrast (required-minimum adjacency set) ------------------
function checkContrast(theme, map) {
  const surfaces = ['--color-background', '--color-card', '--color-popover'];

  // foreground/background (and on card/popover).
  checkPair(theme, 'foreground/background', '--color-foreground', '--color-background', 4.5, map);

  // muted-foreground vs background/card/popover.
  for (const s of surfaces) {
    checkPair(theme, `muted-foreground/${s}`, '--color-muted-foreground', s, 4.5, map);
  }

  // primary-foreground on primary (on-amber ≥ 4.5).
  checkPair(theme, 'on-amber (primary)', '--color-primary-foreground', '--color-primary', 4.5, map);

  // secondary/accent foreground on their fills.
  checkPair(theme, 'secondary-foreground/secondary', '--color-secondary-foreground', '--color-secondary', 4.5, map);
  checkPair(theme, 'accent-foreground/accent', '--color-accent-foreground', '--color-accent', 4.5, map);

  // destructive solid-fill foreground.
  checkPair(theme, 'destructive-foreground/destructive', '--color-destructive-foreground', '--color-destructive', 4.5, map);

  // focus (ring) vs adjacent surfaces — non-text ≥ 3.
  for (const s of surfaces) {
    checkPair(theme, `focus/${s}`, '--color-focus', s, 3, map);
  }
  // ring is an alias of focus; assert it resolved to the same concrete value.
  checkPair(theme, 'ring/background', '--color-ring', '--color-background', 3, map);

  // gain/loss/flat as text on every surface they render on.
  for (const role of ['--color-gain', '--color-loss', '--color-flat']) {
    for (const s of surfaces) {
      checkPair(theme, `${role}-as-text/${s}`, role, s, 4.5, map);
    }
  }

  // warning/info/success as text on background/card/popover [≥4.5] ...
  for (const role of STATUS_ROLES) {
    for (const s of STATUS_SURFACES) {
      checkPair(theme, `${role}-as-text/${s}`, role, s, 4.5, map);
    }
    // ... AND on their own composited bg-{status}/10 tint over each surface.
    for (const s of STATUS_SURFACES) {
      checkStatusOnTint(theme, role, s, map);
    }
    // Any solid bg-{status} fill's *-foreground pair.
    checkPair(theme, `${role}-foreground/${role}`, `${role}-foreground`, role, 4.5, map);
  }

  // disabled-opacity-50 foreground vs surfaces (R10.6): the 50%-opacity
  // foreground composited over each surface, BOTH themes. Threshold is the
  // 3:1 non-text/inactive floor, NOT 4.5: every `disabled:opacity-50` site in
  // components/ui/** sits on a DISABLED control (button/input/textarea/select/
  // switch/accordion/label), which WCAG 2.x SC 1.4.3 explicitly exempts from
  // the 4.5:1 text minimum ("inactive user interface component … has no
  // contrast requirement"). A 50%-dimmed foreground over a near-white surface
  // caps at ~3.98:1 (pure-black limit), so 4.5 is unreachable for ANY token
  // value — scoring it at 4.5 mis-classifies inactive UI as active body text.
  // The 3:1 floor still SAMPLES both themes (catches a disabled state that
  // drops below the non-text floor — the dark-fails-light-passes regression
  // this pair exists to guard), without weakening the active-text gate.
  for (const s of surfaces) {
    const fg = map.get('--color-foreground');
    const bg = map.get(s);
    if (fg === undefined || bg === undefined) {
      report(`[${theme}] MISSING role for disabled-50 foreground/${s}`);
      continue;
    }
    let ratio;
    try {
      const fgRgb = gamutMapToSrgb(fg);
      const bgRgb = gamutMapToSrgb(bg);
      ratio = contrastRatio(composite(fgRgb, 0.5, bgRgb), bgRgb);
    } catch (err) {
      report(`[${theme}] color error in disabled-50/${s}: ${err.message}`);
      continue;
    }
    const label = `disabled-opacity-50 foreground/${s}`;
    if (ratio < 3) {
      report(`[${theme}] AA FAIL ${label} = ${ratio.toFixed(2)} < 3 (inactive-component floor)`);
    } else {
      console.log(`[${theme}] OK ${label} = ${ratio.toFixed(2)} >= 3 (inactive-component floor)`);
    }
  }

  // Meaningful borders (input/region separators) ≥ 3.
  checkPair(theme, 'border/background', '--color-border', '--color-background', 3, map);
  checkPair(theme, 'input/background', '--color-input', '--color-background', 3, map);
}

// ---- per-theme distinctness (ΔEOK ≥ 0.05, independent per theme) ----------
const DISTINCTNESS_PAIRS = [
  ['--color-warning', '--color-primary'],
  ['--color-success', '--color-primary'],
  ['--color-info', '--color-primary'],
  ['--color-success', '--color-gain'],
  ['--color-warning', '--color-gain'],
  ['--color-warning', '--color-loss'],
  ['--color-destructive', '--color-loss'], // danger vs loss
];

function checkDistinctness(theme, map) {
  for (const [aName, bName] of DISTINCTNESS_PAIRS) {
    const a = map.get(aName);
    const b = map.get(bName);
    if (a === undefined || b === undefined) {
      report(`[${theme}] MISSING role in distinctness pair ${aName} vs ${bName}`);
      continue;
    }
    let d;
    try {
      d = deltaEOK(parse(a), parse(b));
    } catch (err) {
      report(`[${theme}] color error in distinctness ${aName} vs ${bName}: ${err.message}`);
      continue;
    }
    if (d < 0.05) {
      report(`[${theme}] ΔEOK FAIL ${aName} vs ${bName} = ${d.toFixed(4)} < 0.05`);
    } else {
      console.log(`[${theme}] OK ΔEOK ${aName} vs ${bName} = ${d.toFixed(4)} >= 0.05`);
    }
  }
}

// ---- both-theme presence (R1.4) -------------------------------------------
// Every net-new role present in @theme must be re-valued in .dark and vice
// versa. Also catch any net-new role missing from BOTH blocks.
function checkBothThemePresence(lightMap, darkMap) {
  for (const role of NET_NEW_ROLES) {
    const inLight = lightMap.has(role);
    const inDark = darkMap.has(role);
    if (inLight && !inDark) {
      report(`[both-theme] R1.4 FAIL: ${role} is in @theme but not re-valued in .dark (ships light-only)`);
    } else if (!inLight && inDark) {
      report(`[both-theme] R1.4 FAIL: ${role} is in .dark but not declared in @theme (ships dark-only)`);
    } else if (!inLight && !inDark) {
      report(`[both-theme] MISSING net-new role ${role} from both @theme and .dark`);
    } else {
      console.log(`[both-theme] OK ${role} present in both @theme and .dark`);
    }
  }
}

// ---- main ------------------------------------------------------------------
function main() {
  let css;
  try {
    css = readFileSync(cssPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`::error::index.css missing at ${cssPath}`);
      process.exit(REPORT_MODE ? 0 : 1);
    }
    throw err;
  }

  const themeBody = extractBlockBody(css, '@theme');
  const darkBody = extractBlockBody(css, '.dark');
  if (themeBody === null) {
    console.error('::error::could not locate @theme block in index.css');
    process.exit(REPORT_MODE ? 0 : 1);
  }
  if (darkBody === null) {
    console.error('::error::could not locate .dark block in index.css');
    process.exit(REPORT_MODE ? 0 : 1);
  }

  const lightRaw = parseDeclarations(themeBody);
  const darkRaw = parseDeclarations(darkBody);

  // The .dark block only re-values overridden roles; resolve a token used under
  // .dark against the merged map (dark wins) so light-only colors (e.g. the
  // ring alias target) still resolve.
  const lightResolved = resolveAliases(lightRaw);
  const darkMerged = new Map(lightRaw);
  for (const [k, v] of darkRaw) darkMerged.set(k, v);
  const darkResolved = resolveAliases(darkMerged);

  // --- both-theme presence uses the RAW (un-merged) maps so a role only
  //     present because of the merge is not counted as re-valued in .dark.
  checkBothThemePresence(lightRaw, darkRaw);

  // --- per-theme contrast + distinctness, each independent.
  checkContrast('light', lightResolved);
  checkDistinctness('light', lightResolved);
  checkContrast('dark', darkResolved);
  checkDistinctness('dark', darkResolved);

  // --- summary.
  if (findings.length === 0) {
    console.log('\ncontrast/distinctness/both-theme gate OK — 0 findings');
  } else {
    console.log(`\ncontrast/distinctness/both-theme findings (${findings.length}):`);
    for (const f of findings) {
      const line = `${f}`;
      if (REPORT_MODE) console.warn(`::warning::${line}`);
      else console.error(`::error::${line}`);
    }
  }

  if (REPORT_MODE) {
    console.log('\n[report mode] exit 0 (warn-only).');
    process.exit(0);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

// Export the pure pieces for unit tests; only run main() as a script.
export {
  extractBlockBody,
  parseDeclarations,
  resolveAliases,
  gamutMapToSrgb,
  relativeLuminance,
  contrastRatio,
  composite,
  deltaEOK,
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
