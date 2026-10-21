// Shared esbuild configuration for the @tradr/api production bundle, plus the
// helper that bundles the per-operation import worker (design C7).
//
// build.mjs owns the orchestration — it runs the server, CLI and worker builds
// and asserts the external set. This module owns the esbuild options they all
// share, so the worker is bundled with EXACTLY the options the server and CLI
// use (ESM, node22, the createRequire banner, the tsconfig `@/` alias, builtins
// plus bcrypt and tiktoken external), not a copy that could drift. It has no
// top-level side effects, so build.mjs can import these options without kicking
// off a build.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isBuiltin } from 'node:module';

import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..');

// The only non-builtin packages allowed to remain external.
export const NATIVE_EXTERNALS = new Set(['bcrypt', 'tiktoken']);

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
export function topLevelPackage(name) {
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

export const common = {
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

/**
 * Bundle the import worker entry to `outdir/import.worker.js` with the shared
 * options (design C7). The worker has no shebang in source and is launched via
 * `new Worker(url)`, so it needs no banner adjustment. Returns the esbuild
 * result so the caller can fold its metafile into the external-set assertion.
 */
export async function buildImportWorker({ outdir }) {
  return esbuild.build({
    ...common,
    entryPoints: {
      'import.worker': resolve(apiRoot, 'src/features/account-data/import.worker.ts'),
    },
    outdir,
  });
}
