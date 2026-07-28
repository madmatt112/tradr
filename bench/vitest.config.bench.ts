import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.resolve(__dirname, '../apps/api/src');

// Standalone vitest config for the performance benchmark harness.
// Deliberately does NOT use `apps/api/src/test-setup.ts` — that file wraps
// every test in a drizzle transaction that rolls back, which is incompatible
// with the seed-once / measure-many pattern this bench needs.
//
// `root: bench/` so vite/vitest resolves bare imports against
// `bench/node_modules` (drizzle-orm, postgres, @tradr/shared, vitest), and
// each package then resolves its nested deps (date-fns-tz, decimal.js, zod)
// from its own node_modules. The `bench` workspace entry in
// pnpm-workspace.yaml is what wires up the symlinks.
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@': apiSrc,
    },
  },
  test: {
    setupFiles: [],
    include: ['*.bench.ts'],
    // Single thread — keeps shared in-memory state coherent and avoids two
    // workers racing to seed the same DB.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Bench seeds 10k positions then runs ~50 iterations across 6 presets +
    // sub-benches. Comfortably under 5min on a dev box; allow 10.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 60_000,
    env: {
      DATABASE_URL:
        process.env.MIGRATE_TEST_DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5433/tradr_test_migrate',
      SESSION_SECRET: 'bench-secret-that-is-at-least-32-characters-long',
      NODE_ENV: 'test',
      PORT: '3199',
      TRUSTED_PROXIES: '127.0.0.1',
      WEEK_START_DAY: '0',
      // Pin the process timezone so the inlined preset resolver (which uses
      // Date.UTC arithmetic) and any timezone-sensitive seed math run in a
      // deterministic environment regardless of the host's TZ.
      TZ: 'UTC',
    },
  },
});
