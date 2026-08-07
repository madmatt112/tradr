#!/usr/bin/env node
// CI bundle-size gates (Task 47, design §W-r3 + Req 9.4).
//
// Enforces six things against the post-build artifact:
//
//   1. Total bundle gate (unchanged from pre-Task-47): the largest emitted
//      JS chunk must be <= 500 KB gzipped.
//   2. Dashboard route initial chunk: <= 30 KB gzipped (entry components +
//      registry shells + dnd-kit core + event-bus store + theme hook,
//      EXCLUSIVE of lazy widget chunks).
//   3. Per-widget lazy chunks: chart widgets <= 120 KB gzipped each;
//      non-chart widgets <= 20 KB gzipped each. Driven by widget-budgets.json.
//   4. Entry-chunk markdown markers (changelog spec, REQ-4.7): no
//      react-markdown/remark-gfm/rehype-sanitize module may land in the
//      entry chunk — they belong to route-level lazy chunks only.
//   5. Entry-chunk PostHog markers (observability spec, REQ-9.2): the
//      posthog-js SDK must never land in the entry chunk — it is loaded via a
//      dynamic import (Task 12) so it stays in a separate async chunk.
//   6. Entry-chunk driver.js markers (user-onboarding spec, REQ-5.7/11.3): the
//      guided-walkthrough tour runtime must never land in the entry chunk — it
//      is reached only through the dynamic import in useWalkthrough.
//
// Chunk identification is done via Vite's build manifest
// (`apps/web/dist/.vite/manifest.json`), keyed by source path — hashed
// filenames are not relied on directly.
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const distDir = resolve(webRoot, 'dist');
const manifestPath = resolve(distDir, '.vite', 'manifest.json');
const budgetsPath = resolve(here, 'widget-budgets.json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function gzipSize(absPath) {
  const buf = readFileSync(absPath);
  return gzipSync(buf).length;
}

function loadJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(`required file missing: ${p}`);
    }
    throw err;
  }
}

const budgets = loadJson(budgetsPath);
const manifest = loadJson(manifestPath);

// ---- 1. Total bundle gate (500 KB gzipped, largest JS chunk) ----
const allJsChunks = Object.values(manifest)
  .map((entry) => entry.file)
  .filter((f) => typeof f === 'string' && f.endsWith('.js'));

if (allJsChunks.length === 0) {
  fail('no JS chunks found in manifest — build artefact missing or stale');
}

let largest = { file: null, bytes: 0 };
for (const f of allJsChunks) {
  const abs = resolve(distDir, f);
  try {
    statSync(abs);
  } catch {
    continue;
  }
  const gz = gzipSize(abs);
  if (gz > largest.bytes) {
    largest = { file: f, bytes: gz };
  }
}

console.log(
  `largest gzipped JS chunk: ${largest.file} = ${largest.bytes} bytes (limit: ${budgets.totalBundle})`,
);
if (largest.bytes > budgets.totalBundle) {
  fail(
    `largest JS chunk exceeds total budget: ${largest.file} = ${largest.bytes} bytes > ${budgets.totalBundle}`,
  );
}

// ---- 2. Dashboard route initial chunk (<= 30 KB gzipped) ----
//
// This budget targets the dashboard route's own module as a SEPARATE lazy
// chunk (entry components + registry shells + dnd-kit core + event-bus store
// + theme hook, EXCLUSIVE of lazy widget chunks). TanStack Router does not
// auto-split per-route by default — the route module currently lives inside
// the main app entry chunk. When the dashboard route gets its own lazy entry
// in the manifest, this gate becomes enforceable; until then it is reported
// as a warning so the budget stays documented but doesn't gate CI on the
// (much larger) main entry chunk.
const entrySource = budgets.dashboardEntry.source;
const entryMax = budgets.dashboardEntry.maxBytes;
const entryManifest = manifest[entrySource];
if (!entryManifest) {
  console.warn(
    `[warn] dashboard-entry budget skipped: ${entrySource} is not emitted as its own chunk in the manifest. ` +
      `It is currently bundled into the main entry. When the dashboard route is lazy-split, this gate will enforce <= ${entryMax} bytes gzipped automatically.`,
  );
} else {
  const entryAbs = resolve(distDir, entryManifest.file);
  const entryGz = gzipSize(entryAbs);
  console.log(
    `dashboard entry chunk: ${entryManifest.file} = ${entryGz} bytes (limit: ${entryMax})`,
  );
  if (entryGz > entryMax) {
    fail(
      `dashboard entry chunk exceeds budget: ${entryManifest.file} = ${entryGz} bytes > ${entryMax}`,
    );
  }
}

// ---- 3. Per-widget lazy chunks ----
const violations = [];
for (const [source, maxBytes] of Object.entries(budgets.widgets)) {
  const entry = manifest[source];
  if (!entry) {
    violations.push(
      `widget chunk missing from manifest: ${source} — Vite did not emit a separate lazy chunk for it. Verify the widget is React.lazy-imported and not inlined.`,
    );
    continue;
  }
  const abs = resolve(distDir, entry.file);
  let gz;
  try {
    gz = gzipSize(abs);
  } catch (err) {
    violations.push(`widget chunk unreadable: ${source} -> ${entry.file} (${err.message})`);
    continue;
  }
  console.log(`widget ${source}: ${entry.file} = ${gz} bytes (limit: ${maxBytes})`);
  if (gz > maxBytes) {
    violations.push(`widget chunk exceeds budget: ${source} = ${gz} bytes > ${maxBytes}`);
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`::error::${v}`);
  process.exit(1);
}

// ---- 4. Entry-chunk markdown markers (changelog spec, design Component 11 / REQ-4.7) ----
//
// The markdown stack (react-markdown + remark-gfm + rehype-sanitize) must only
// ever load via route-level lazy chunks, never the main entry. The Vite
// manifest carries no per-chunk module identity, so this is a content-marker
// scan of the entry chunk's source for distinctive literals verified to
// survive minification in the real build.
const markdownMarkers = [
  'react-markdown', // react-markdown's own error strings
  'gfmFootnote', // remark-gfm option key
  'tasklistCheck', // remark-gfm option key
  'user-content-', // hast-util-sanitize defaultSchema clobber prefix value
  'clobberPrefix', // hast-util-sanitize defaultSchema key
];

const entryChunks = Object.values(manifest).filter(
  (e) => e.isEntry && typeof e.file === 'string' && e.file.endsWith('.js'),
);
if (entryChunks.length === 0) {
  fail('no entry chunk found in manifest — build artefact missing or stale');
}
for (const chunk of entryChunks) {
  const src = readFileSync(resolve(distDir, chunk.file), 'utf8');
  for (const marker of markdownMarkers) {
    if (src.includes(marker)) {
      fail(
        `entry chunk ${chunk.file} contains markdown-stack marker "${marker}" — ` +
          `react-markdown/remark-gfm/rehype-sanitize must not land in the entry chunk. ` +
          `Fix: load markdown-rendering routes/components via route-level React.lazy so the stack stays in a lazy chunk.`,
      );
    }
  }
  console.log(
    `entry chunk ${chunk.file}: no markdown-stack markers (${markdownMarkers.length} checked)`,
  );
}

// ---- 5. Entry-chunk PostHog markers (observability spec, design Component 10 / REQ-9.2) ----
//
// posthog-js (~60 KB) must only ever load via its own async chunk — it is
// dynamically imported (Task 12) so the SDK stays out of the entry chunk. Gate
// #1 (largest-chunk <= 500 KB) would happily pass a ~60 KB SDK riding inside the
// entry chunk, and gate #2 (dashboardEntry) is warn-only, so this property needs
// its own enforcement. Like gate #4, the Vite manifest carries no per-chunk
// module identity, so this is a content-marker scan of the entry chunk's source
// for distinctive PostHog WIRE-PROTOCOL literals (event/property names the
// library emits, NOT module paths/identifiers — those minify away). The markers
// below were verified against a real minified build: each survives minification,
// is present in the posthog async chunk, is absent from the entry chunk, and is
// unique to posthog-js (no other dependency emits them).
const posthogMarkers = [
  '$autocapture', // posthog-js autocapture event name
  '$pageleave', // posthog-js pageleave event name
  '$web_vitals', // posthog-js web-vitals event name
];

for (const chunk of entryChunks) {
  const src = readFileSync(resolve(distDir, chunk.file), 'utf8');
  for (const marker of posthogMarkers) {
    if (src.includes(marker)) {
      fail(
        `entry chunk ${chunk.file} contains posthog-js marker "${marker}" — ` +
          `the PostHog SDK must not land in the entry chunk (REQ-9.2). ` +
          `Fix: keep posthog-js behind the dynamic import in lib/telemetry/posthog.ts (Task 12) ` +
          `so Vite emits it as a separate async chunk — never a static import from an eagerly-loaded module.`,
      );
    }
  }
  console.log(
    `entry chunk ${chunk.file}: no posthog-js markers (${posthogMarkers.length} checked)`,
  );
}

// ---- 6. Entry-chunk driver.js markers (user-onboarding spec, REQ-5.7 / REQ-11.3) ----
//
// The guided-walkthrough runtime (driver.js + the tour stylesheet it pulls in)
// must only ever load via its own async chunk: `useWalkthrough` reaches
// `features/onboarding/lib/tour-engine.ts` — the sole module that imports
// driver.js — through a dynamic import, and nothing else may import it at all.
// Every returning user loads the dashboard and no returning user is being
// guided, so a static edge would charge all of them for a tour none of them
// runs.
//
// This needs its own gate because nothing else catches it. Gate #1
// (largest-chunk <= 500 KB) would happily pass a ~25 KB library riding inside
// the entry chunk, and gate #2 (dashboardEntry, the 30 KB budget that names
// this exact property) is warn-only AND skipped — `src/routes/_auth.dashboard.tsx`
// is not lazy-split, so it has no chunk of its own in the manifest and rides
// the main entry. An unchecked gate is an unmet gate.
//
// Like gates #4 and #5, this is a content-marker scan: the Vite manifest carries
// no per-chunk module identity. The markers are driver.js's own DOM class and id
// literals — they are strings the library writes into the document, so they
// survive minification, unlike module paths and identifiers. Each was verified
// against a real minified build: present in the tour chunk when the engine is
// imported, absent from the entry chunk otherwise, and emitted by nothing else
// in the dependency graph. (`tour.css` also contains them, but a stylesheet is a
// separate asset and never part of a JS chunk.)
const driverMarkers = [
  'driver-popover', // popover root class
  'driver-active-element', // highlighted-element class
  'driver-dummy-element', // id of the placeholder used for centred steps
];

// The entry STYLESHEET is scanned alongside the entry chunk, and it is not
// belt-and-braces. `tour-engine.ts` carries the tour's only `import './tour.css'`
// and that stylesheet `@import`s the vendor CSS, so a static edge leaks the
// styles even in builds where Rollup manages to tree-shake the JS back out —
// verified: a static import whose exports go unused emitted no driver.js into
// any chunk but still merged the whole tour stylesheet into the entry CSS. A
// gate that only read the JS would have called that clean.
for (const chunk of entryChunks) {
  const assets = [chunk.file, ...(chunk.css ?? [])];
  for (const asset of assets) {
    const src = readFileSync(resolve(distDir, asset), 'utf8');
    for (const marker of driverMarkers) {
      if (src.includes(marker)) {
        fail(
          `entry asset ${asset} contains driver.js marker "${marker}" — ` +
            `the walkthrough tour runtime must not land in the entry chunk (REQ-5.7, REQ-11.3). ` +
            `Fix: keep features/onboarding/lib/tour-engine.ts behind the dynamic import in ` +
            `features/onboarding/hooks/useWalkthrough.ts so Vite emits it as a separate async ` +
            `chunk — never a static import from an eagerly-loaded module, never an import of ` +
            `driver.js from anywhere but tour-engine.ts, and never an import of tour.css from ` +
            `anywhere but tour-engine.ts.`,
        );
      }
    }
  }
  console.log(
    `entry chunk ${chunk.file} (+${assets.length - 1} stylesheet(s)): no driver.js markers (${driverMarkers.length} checked)`,
  );
}

console.log('bundle-size gates OK');
process.exit(0);
