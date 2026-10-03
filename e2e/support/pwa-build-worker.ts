/**
 * Child-process builder for the two-build PWA upgrade harness.
 *
 * `buildPair` (e2e/support/pwa-build-server.ts) spawns this script in a
 * short-lived Node/tsx process and awaits its exit. Running the two Vite
 * production builds in-process left esbuild's service process and the builds'
 * retained resources alive for the rest of the single-worker e2e job, which
 * degraded every spec that ran after pwa-upgrade.spec.ts on the 2-core CI runner.
 * A child process reclaims all of it on exit (design C7, Requirement 8.4).
 *
 * argv[2] is the output directory; this builds `<outDir>/a` and `<outDir>/b`.
 * Build B carries a marker folded into every chunk's content hash (and prepended
 * as a banner for a visible trace), so build B's entry and lazy chunks all differ
 * from build A's. The marker is folded through Rollup's `augmentChunkHash` hook,
 * not `output.banner`: a banner is appended after the hash is computed and so
 * leaves `[hash]` unchanged (verified against the installed rollup under vite
 * 6.4.1). The parent asserts the two entry `src` values differ.
 *
 * Vite cannot be imported from the e2e package: `import('vite')` from `e2e/`
 * fails with `ERR_MODULE_NOT_FOUND` because vite is a dependency of apps/web, not
 * of e2e, and pnpm does not hoist it to the workspace root. It is loaded with
 * `createRequire` anchored at `apps/web/package.json` and a dynamic import of the
 * resolved path (Requirement 8.4). Every build targets an `outDir` under the OS
 * temp directory; the server never writes into `apps/web/dist`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('../../apps/web', import.meta.url));
const WEB_PACKAGE_JSON = join(WEB_ROOT, 'package.json');
const WEB_CONFIG_FILE = join(WEB_ROOT, 'vite.config.ts');

// Build B's marker: folded into every chunk's content hash (and prepended as a
// banner for a visible trace), so build B's entry and lazy chunks all differ
// from build A's.
const BUILD_B_MARKER = '/* pwa-upgrade-b */';

// A permissive `build` option bag — the e2e package cannot resolve vite's types
// any more than it can resolve vite itself, so the inline config is typed loosely
// and vite validates it at run time.
type ViteBuild = (inlineConfig: Record<string, unknown>) => Promise<unknown>;

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) {
    throw new Error('pwa-build-worker: missing outDir argument');
  }

  const require = createRequire(WEB_PACKAGE_JSON);
  const vitePath = require.resolve('vite');
  const { build } = (await import(vitePath)) as { build: ViteBuild };

  const buildOne = async (buildOutDir: string, marker?: string): Promise<void> => {
    await build({
      root: WEB_ROOT,
      configFile: WEB_CONFIG_FILE,
      logLevel: 'warn',
      // `augmentChunkHash` folds the marker into every chunk's content hash so the
      // entry and the lazy route chunks all get new hashes; the banner is a
      // visible trace only (it does not affect the hash on its own).
      ...(marker
        ? {
            plugins: [
              {
                name: 'pwa-upgrade-variant',
                augmentChunkHash: () => marker,
              },
            ],
          }
        : {}),
      build: {
        outDir: buildOutDir,
        emptyOutDir: true,
        ...(marker ? { rollupOptions: { output: { banner: marker } } } : {}),
      },
    });
  };

  await buildOne(join(outDir, 'a'));
  await buildOne(join(outDir, 'b'), BUILD_B_MARKER);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
