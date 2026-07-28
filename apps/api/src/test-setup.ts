import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Decimal from 'decimal.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

import { POST_MIGRATIONS_DIR } from './db/migrate';
import * as schema from './db/schema';
import { listCloseHooks, unregisterCloseHook } from './features/positions/positions.service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// vi.mock is hoisted — all imports of @/db resolve to this mock
vi.mock('@/db', async () => {
  const actual = await vi.importActual('@/db');
  return { ...actual, db: undefined }; // replaced per-test in beforeEach
});

// eslint-disable-next-line import-x/order
import * as dbModule from '@/db';

// Single-connection pool for test isolation — all queries go through one connection
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';
  sql = postgres(databaseUrl, { max: 1 });

  const migrationDb = drizzle(sql, { schema });

  // Serialize every api test file's migration apply behind a TEST-ONLY advisory
  // lock. Two reasons it must be a dedicated key — NOT the production
  // MIGRATIONS_LOCK_KEY / POST_MIGRATIONS_LOCK_KEY:
  //   1. Concurrency: many files' beforeAll race to CREATE TABLE/TYPE against a
  //      pristine DB; drizzle's raw migrate() takes no lock, so the race throws
  //      "duplicate key pg_type_typname_nsp_index". A shared lock serializes them.
  //   2. Isolation: the production keys are cluster-wide and are also taken by
  //      the `migrations` project and observed by the CLI advisory-lock test.
  //      Borrowing them here would cross-project flake those suites. A distinct
  //      key keeps the api project off the production keys entirely.
  // A plain number (not bigint): the shared test connection has no
  // `types: { bigint }` config, and Postgres resolves the single-arg
  // pg_advisory_lock(bigint) overload from a numeric param.
  const TEST_SETUP_LOCK_KEY = 770641;
  await sql`SELECT pg_advisory_lock(${TEST_SETUP_LOCK_KEY})`;
  try {
    await migrate(migrationDb, {
      migrationsFolder: path.resolve(__dirname, 'db/migrations'),
    });

    // Apply post-migration DDL directly on the shared connection, WITHOUT the
    // production advisory lock or CONCURRENTLY. runPostMigrations() holds the
    // cluster-wide POST_MIGRATIONS_LOCK_KEY and builds the index CONCURRENTLY,
    // whose long, lock-held stall (behind open per-test transactions) is what
    // cross-project flaked the migrate + CLI-lock suites. The test DB only needs
    // the resulting index, so apply each file plainly and idempotently.
    const postFiles = (await readdir(POST_MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const filename of postFiles) {
      const ddl = (await readFile(path.join(POST_MIGRATIONS_DIR, filename), 'utf8')).replace(
        /\bCONCURRENTLY\b/gi,
        '',
      );
      await sql.unsafe(ddl);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${TEST_SETUP_LOCK_KEY})`;
  }
});

// Per-test isolation: wrap each test in a drizzle-managed transaction. Raw
// BEGIN/ROLLBACK is invisible to drizzle's session state, so service-layer
// withTransaction(db, ...) calls would issue a nested BEGIN and COMMIT
// (committing the outer test transaction, leaking data). By making the outer
// context a real drizzle Transaction, nested .transaction() calls dispatch to
// SAVEPOINT correctly.
let endTest: (err: Error) => void;
let txDone: Promise<unknown>;

beforeEach(async () => {
  await new Promise<void>((ready) => {
    const rootDb = drizzle(sql, { schema });
    txDone = rootDb
      .transaction(async (tx) => {
        (dbModule as Record<string, unknown>).db = tx;
        ready();
        await new Promise<never>((_, reject) => {
          endTest = reject;
        });
      })
      .catch(() => {
        /* expected rollback */
      });
  });
});

afterEach(async () => {
  endTest(new Error('__test_rollback__'));
  await txDone;
  (dbModule as Record<string, unknown>).db = undefined;
  // Reset Decimal.js global config so a test that deliberately mutates it
  // (e.g. precision/rounding edge cases) cannot leak settings to sibling tests
  // sharing this worker's module state. Mirrors the registry-clear afterAll
  // below (Task 18 c).
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
});

afterAll(async () => {
  // Cross-file safety net for the closeHooks registry (Task 18 d). If a file
  // throws before its own per-file `afterAll(unregisterCloseHook(...))` runs,
  // the registered hook would otherwise leak into the next file in this
  // worker — silently invalidating Task 15's "empty registry by default"
  // premise. MUST be afterAll (per-file), NOT afterEach: an afterEach would
  // tear down hooks that Tasks 16/17's `beforeAll(bootstrap)` registers,
  // breaking every test after the first in those files.
  for (const name of listCloseHooks()) {
    unregisterCloseHook(name);
  }
  await sql.end();
});
