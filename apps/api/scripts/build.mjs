// Production bundle for @tradr/api.
//
// Bundles the server entry (src/index.ts), the CLI (src/cli/tradr.ts) and the
// per-operation import worker (src/features/account-data/import.worker.ts) into
// flat ESM files under dist/. Everything is inlined — @tradr/* workspace code,
// relative source, and all pure-JS dependencies — EXCEPT:
//   - Node builtins (always external)
//   - bcrypt   (native .node addon)
//   - tiktoken (.wasm payload, dynamic import at cap-check.ts:165)
// These two have non-JS payloads esbuild cannot inline, so they stay external
// and are shipped as on-disk node_modules by the Docker build (task 6).
//
// The shared esbuild options and the worker bundle helper live in
// build-import-worker.mjs, so all three entries use exactly the same options.
//
// After bundling we read the metafile and ASSERT the external set equals
// exactly {Node builtins} ∪ {bcrypt, tiktoken} (D7-1). This validates the
// BUNDLE only; runtime on-disk presence of the natives is task 6's concern.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { builtinModules } from 'node:module';

import esbuild from 'esbuild';

import {
  NATIVE_EXTERNALS,
  topLevelPackage,
  common,
  buildImportWorker,
} from './build-import-worker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..');
const outdir = resolve(apiRoot, 'dist');

// Three separate builds so the CLI gets exactly one shebang. src/cli/tradr.ts
// already starts with `#!/usr/bin/env node`, which esbuild preserves on line 1
// — so the CLI needs no banner (a banner would prepend a SECOND, invalid one).
// The server entry and the worker have no shebang in source and are launched via
// `node dist/index.js` / `new Worker(url)`, so they need none either (the worker
// shares `common`, which carries the createRequire banner, via its helper).
const results = await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: { index: resolve(apiRoot, 'src/index.ts') },
    outdir,
  }),
  esbuild.build({
    ...common,
    entryPoints: { tradr: resolve(apiRoot, 'src/cli/tradr.ts') },
    outdir,
  }),
  buildImportWorker({ outdir }),
]);

// --- Assert the external set -------------------------------------------------

const externals = new Set();
for (const result of results) {
  for (const out of Object.values(result.metafile.outputs)) {
    for (const imp of out.imports ?? []) {
      if (imp.external) externals.add(topLevelPackage(imp.path));
    }
  }
}

const builtinSet = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const expected = new Set([...NATIVE_EXTERNALS]);

const unexpected = [...externals].filter((e) => !builtinSet.has(e) && !NATIVE_EXTERNALS.has(e));
const nonBuiltinExternals = new Set([...externals].filter((e) => !builtinSet.has(e)));
const missing = [...expected].filter((e) => !nonBuiltinExternals.has(e));

if (unexpected.length > 0 || missing.length > 0) {
  console.error('External-set assertion FAILED.');
  if (unexpected.length > 0) {
    console.error(`  Unexpected externals: ${unexpected.join(', ')}`);
    console.error('  Only Node builtins, bcrypt, and tiktoken may be external.');
  }
  if (missing.length > 0) {
    console.error(`  Missing expected native externals: ${missing.join(', ')}`);
  }
  process.exit(1);
}

console.log(
  `build:prod OK — dist/index.js + dist/tradr.js + dist/import.worker.js; native externals: ${[
    ...nonBuiltinExternals,
  ]
    .sort()
    .join(', ')}`,
);
