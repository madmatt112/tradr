#!/usr/bin/env node
// Design-lint CI gate (visual-design Task 7; design Component 6 / Req 9.1, 8.1,
// 8.3, 10.5).
//
// A deterministic, no-browser node gate that scans `apps/web/src` (EXCLUDING
// `components/ui/**`, `*.test.*`, `*.stories.*`, and `fixtures/`) for four
// classes of design-system drift, each reported as `file:line`:
//
//   1. RAW-PALETTE-CLASS — a raw Tailwind palette utility (e.g. `text-red-600`).
//      The regex below is the CANONICAL re-sweep command the migration tasks
//      (11-15) reuse, so it MUST match the design's exact character class. After
//      Stage A this returns 0; today it reports the existing hardcoded classes.
//   2. SPACING-LADDER — an off-ladder `p/m/gap/space-*` INTEGER step. The
//      allowed set is 0,1,2,3,4,6,8,12,16. Fractional shadcn half-steps
//      (0.5/1.5/2.5) are NOT integer steps and are never flagged; arbitrary
//      `[Npx]` chart heights / drawer widths are out of the ladder's scope and
//      are not matched here.
//   3. TYPE-SCALE — an arbitrary `text-[…]` font size (drift-prevention; 0 today).
//   4. PRIMITIVE-BYPASS GUARD:
//        (a) `pnlColorClass` import/usage — must be 0 after Stage A (today >0).
//        (b) inline `tabular-nums` / `font-variant-numeric` outside an EXPLICIT
//            exempt allowlist: `components/Numeric.tsx` PLUS the three Recharts
//            files (PerformanceBarChart / EquityCurveChart / UsageChart). This
//            is an EXPLICIT three-path allowlist, NEVER a `*Chart*.tsx` glob
//            (that over-matches ChartChunkStaleBanner / EquityCurveChartSkeleton
//            / PerformanceChartWidget and silently weakens the guard).
//
// ACCEPTED RESIDUAL (documented): a bare, uncolored, non-tabular
// `<span>{value}</span>` money figure is statically indistinguishable from
// non-money text — the Required-states audit + the e2e parity smoke are the
// human/runtime backstop for that residual.
//
// CI-FAILING MODE: prints every finding and EXITS 1 on any finding (Task 19
// flipped REPORT_MODE off once all surfaces were migrated, R9.6).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');

// CI-FAILING MODE — collect findings, print, exit 1 on any finding (Task 19
// flipped REPORT_MODE → false now that all surfaces are migrated, R9.6).
const REPORT_MODE = false;

// ---- regexes ---------------------------------------------------------------
// CANONICAL raw-palette-class regex. This EXACT character class is reused by
// the migration tasks' re-sweep command, so it must not drift. Global so every
// occurrence on a line is reported.
const PALETTE_RE =
  /(text|bg|border|ring|fill|stroke|placeholder|divide|from|via|to|outline|decoration|shadow|accent|caret)-(red|green|emerald|amber|yellow|orange|blue|sky|indigo|violet|purple|pink|rose|gray|grey|slate|zinc|neutral|stone)-[0-9]+/g;

// Spacing utilities subject to the ladder. A leading boundary (start-of-token,
// quote, space, or backtick) keeps us from matching mid-identifier.
const SPACING_RE =
  /(?<![\w-])(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-([0-9]+(?:\.[0-9]+)?)/g;
const ALLOWED_STEPS = new Set([0, 1, 2, 3, 4, 6, 8, 12, 16]);

// Arbitrary `text-[…]` font size (drift-prevention).
const TYPE_RE = /text-\[[^\]]+\]/g;

// Primitive-bypass guard.
const PNL_COLOR_CLASS_RE = /pnlColorClass/g;
const TABULAR_RE = /tabular-nums|font-variant-numeric/g;

// ---- exclusions ------------------------------------------------------------
// `components/ui/**` (shadcn half-steps + 1-2px ring/translate calibration are
// legitimate), tests, stories, and fixtures are never scanned.
function isExcludedDir(name) {
  return name === 'ui' || name === 'fixtures' || name === '__tests__';
}
function isExcludedFile(name) {
  return /\.test\./.test(name) || /\.stories\./.test(name);
}

// EXPLICIT three-path allowlist for the tabular-nums guard — relative to
// `apps/web/src`, posix-separated. NEVER a `*Chart*.tsx` glob.
const TABULAR_EXEMPT = new Set([
  'components/Numeric.tsx',
  'features/performance/components/PerformanceBarChart.tsx',
  'features/performance/components/EquityCurveChart.tsx',
  'features/admin/components/UsageChart.tsx',
]);

// ---- file walk -------------------------------------------------------------
function isUnderUi(absPath) {
  // Exclude any file inside a `components/ui` directory anywhere in src.
  const rel = relative(srcRoot, absPath).split(sep).join('/');
  return rel === 'components/ui' || rel.startsWith('components/ui/') || rel.includes('/components/ui/');
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (isExcludedDir(entry)) continue;
      walk(abs, out);
    } else if (st.isFile()) {
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(entry)) continue;
      if (isExcludedFile(entry)) continue;
      if (isUnderUi(abs)) continue;
      out.push(abs);
    }
  }
  return out;
}

// ---- core lint -------------------------------------------------------------
// Run every check over the given file contents, returning findings as
// `{ check, file, line, match }`. `relPath` is the posix path relative to
// `apps/web/src`, used for the tabular-nums allowlist.
function lintContent(relPath, content) {
  const findings = [];
  const lines = content.split('\n');
  const tabularExempt = TABULAR_EXEMPT.has(relPath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    PALETTE_RE.lastIndex = 0;
    for (let m; (m = PALETTE_RE.exec(line)); ) {
      findings.push({ check: 'RAW-PALETTE-CLASS', file: relPath, line: lineNo, match: m[0] });
    }

    SPACING_RE.lastIndex = 0;
    for (let m; (m = SPACING_RE.exec(line)); ) {
      const step = m[2];
      // Only INTEGER steps are ladder-checked; fractional half-steps pass.
      if (step.includes('.')) continue;
      if (!ALLOWED_STEPS.has(Number(step))) {
        findings.push({ check: 'SPACING-LADDER', file: relPath, line: lineNo, match: m[0] });
      }
    }

    TYPE_RE.lastIndex = 0;
    for (let m; (m = TYPE_RE.exec(line)); ) {
      findings.push({ check: 'TYPE-SCALE', file: relPath, line: lineNo, match: m[0] });
    }

    PNL_COLOR_CLASS_RE.lastIndex = 0;
    for (let m; (m = PNL_COLOR_CLASS_RE.exec(line)); ) {
      findings.push({ check: 'BYPASS-PNLCOLORCLASS', file: relPath, line: lineNo, match: m[0] });
    }

    if (!tabularExempt) {
      TABULAR_RE.lastIndex = 0;
      for (let m; (m = TABULAR_RE.exec(line)); ) {
        findings.push({ check: 'BYPASS-TABULAR-NUMS', file: relPath, line: lineNo, match: m[0] });
      }
    }
  }

  return findings;
}

// ---- main ------------------------------------------------------------------
function main() {
  let files;
  try {
    files = walk(srcRoot, []);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`::error::src tree missing at ${srcRoot}`);
      process.exit(REPORT_MODE ? 0 : 1);
    }
    throw err;
  }

  const findings = [];
  for (const abs of files) {
    const relPath = relative(srcRoot, abs).split(sep).join('/');
    findings.push(...lintContent(relPath, readFileSync(abs, 'utf8')));
  }

  const byCheck = {};
  for (const f of findings) byCheck[f.check] = (byCheck[f.check] || 0) + 1;

  if (findings.length === 0) {
    console.log('design-lint gate OK — 0 findings');
  } else {
    console.log(`design-lint findings (${findings.length}): ${JSON.stringify(byCheck)}`);
    for (const f of findings) {
      const line = `[${f.check}] ${f.file}:${f.line} — ${f.match}`;
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
export { lintContent, PALETTE_RE, SPACING_RE, TYPE_RE, ALLOWED_STEPS, TABULAR_EXEMPT };

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
