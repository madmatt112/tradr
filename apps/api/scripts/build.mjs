// Production bundle for @tradr/api.
//
// Bundles the server entry (src/index.ts) and the CLI (src/cli/tradr.ts) into
// flat ESM files under dist/. Everything is inlined — @tradr/* workspace code,
// relative source, and all pure-JS dependencies — EXCEPT:
//   - Node builtins (always external)
//   - bcrypt   (native .node addon)
//   - tiktoken (.wasm payload, dynamic import at cap-check.ts:165)
// These two have non-JS payloads esbuild cannot inline, so they stay external
// and are shipped as on-disk node_modules by the Docker build (task 6).
//
// After bundling we read the metafile and ASSERT the external set equals
// exactly {Node builtins} ∪ {bcrypt, tiktoken} (D7-1). This validates the
// BUNDLE only; runtime on-disk presence of the natives is task 6's concern.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { builtinModules, isBuiltin } from 'node:module';

import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..');

// The only non-builtin packages allowed to remain external.
const NATIVE_EXTERNALS = new Set(['bcrypt', 'tiktoken']);

// `encoding` is an OPTIONAL, uninstalled dependency of node-fetch@2: it is
// referenced only inside a guarded `try { require("encoding") } catch {}` and
// is genuinely absent from node_modules. Left alone esbuild would mark it
// external (it can't resolve it), polluting the external set. Stub it with an
// empty module so the require returns `{}` and the catch path is never hit —
// matching node-fetch's own optional-dependency contract.
const OPTIONAL_ABSENT = new Set(['encoding']);

// Optional: inject a fake extra external to prove the assert fails (negative
// check). Set BUILD_INJECT_FAKE_EXTERNAL=1 to enable; the run is expected to
// exit non-zero. Never set in CI/Docker.
const injectFake = process.env.BUILD_INJECT_FAKE_EXTERNAL === '1';

/**
 * Resolve a package name to its top-level package for external matching:
 *   'tiktoken/lite' -> 'tiktoken', '@scope/pkg/sub' -> '@scope/pkg'.
 */
function topLevelPackage(name) {
  if (name.startsWith('@')) {
    const parts = name.split('/');
    return parts.slice(0, 2).join('/');
  }
  return name.split('/')[0];
}

/**
 * onResolve plugin: mark a bare import external iff it is a Node builtin OR one
 * of the native packages. Everything else (@tradr/*, relative paths, pure-JS
 * deps) is left to esbuild to inline.
 */
const externalNativesPlugin = {
  name: 'external-natives',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const path = args.path;
      // Relative / absolute imports — always inline.
      if (path.startsWith('.') || path.startsWith('/')) return null;
      if (isBuiltin(path)) return { path, external: true };
      const pkg = topLevelPackage(path);
      if (OPTIONAL_ABSENT.has(pkg)) {
        return { path, namespace: 'optional-absent' };
      }
      if (NATIVE_EXTERNALS.has(pkg)) return { path, external: true };
      if (injectFake && pkg === 'decimal.js') return { path, external: true };
      // Everything else (incl. @tradr/*) is inlined.
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: 'optional-absent' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

// ESM output has no CommonJS `require`. esbuild emits a `__require` shim that
// falls back to `typeof require !== 'undefined' ? require : throw`, so any
// inlined CJS dep doing a dynamic `require('stream')` (e.g. node-fetch@2,
// pulled in transitively via bcrypt's @mapbox/node-pre-gyp) crash-loops at boot
// with `Dynamic require of "stream" is not supported`. The documented esbuild
// fix is to define a real top-level `require` via createRequire; then the
// shim's `typeof require !== 'undefined'` is true and the require resolves.
// This is a SEPARATE top-level binding from esbuild's `__require` helper (no
// collision) and does NOT touch `import.meta.url`, so migrate.ts's __thisDir
// resolution against the bundle dir is preserved.
const esmRequireBanner =
  "import { createRequire as __createRequire } from 'module';" +
  'const require = __createRequire(import.meta.url);';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  metafile: true,
  banner: { js: esmRequireBanner },
  // Resolve the `@/*` path alias declared in tsconfig.json. esbuild preserves
  // import.meta.url for ESM node output, so the bundled migrate.ts __thisDir
  // resolves to the bundle directory (dist/), not the original src path.
  tsconfig: resolve(apiRoot, 'tsconfig.json'),
  plugins: [externalNativesPlugin],
};

// Two separate builds so the CLI gets exactly one shebang. src/cli/tradr.ts
// already starts with `#!/usr/bin/env node`, which esbuild preserves on line 1
// — so the CLI needs no banner (a banner would prepend a SECOND, invalid one).
// The server entry has no shebang in source; it is launched via
// `node dist/index.js`, so it needs none either.
const results = await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: { index: resolve(apiRoot, 'src/index.ts') },
    outdir: resolve(apiRoot, 'dist'),
  }),
  esbuild.build({
    ...common,
    entryPoints: { tradr: resolve(apiRoot, 'src/cli/tradr.ts') },
    outdir: resolve(apiRoot, 'dist'),
  }),
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

const unexpected = [...externals].filter(
  (e) => !builtinSet.has(e) && !NATIVE_EXTERNALS.has(e),
);
const nonBuiltinExternals = new Set(
  [...externals].filter((e) => !builtinSet.has(e)),
);
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
  `build:prod OK — dist/index.js + dist/tradr.js; native externals: ${[
    ...nonBuiltinExternals,
  ]
    .sort()
    .join(', ')}`,
);
