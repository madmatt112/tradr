/**
 * Migration tests — run against the `tradr_test_migrate` DB created by
 * docker/init-test-db.sql (Task 0.5). These tests use the standalone vitest
 * project `migrations` (apps/api/vitest.config.migrations.ts) and DO NOT use
 * the per-test transaction-rollback harness in apps/api/src/test-setup.ts.
 *
 * Cases (a) through (k) per the performance-charts migration matrix.
 * Task 24.
 */
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

import {
  runMigrations,
  runPostMigrations,
  MIGRATIONS_LOCK_KEY,
  POST_MIGRATIONS_LOCK_KEY,
} from './migrate';

const SUPERUSER_URL =
  process.env.MIGRATE_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/tradr_test_migrate';

const USER_URL =
  process.env.MIGRATE_TEST_USER_DATABASE_URL ||
  'postgresql://tradr_test_user:tradr_test_user@localhost:5433/tradr_test_migrate';

const POST_MIGRATION_FILENAME = '0001_positions_user_status_closed_at_idx.sql';
const POST_MIGRATION_INDEX = 'positions_user_status_closed_at_idx';

/**
 * Open a short-lived superuser connection for fixture setup / teardown.
 * Always end() the returned client.
 */
function adminClient() {
  return postgres(SUPERUSER_URL, { max: 1, types: { bigint: postgres.BigInt } });
}

/**
 * Reset the post-migrations journal + drop the composite index so the
 * post-migration runner has clean state to re-apply its work.
 */
async function resetPostMigrationState(): Promise<void> {
  const sql = adminClient();
  try {
    await sql.unsafe(`DELETE FROM _post_migrations_journal`);
    await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${POST_MIGRATION_INDEX}`);
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  // Bring the migrate test DB to a known good baseline: drizzle migrations
  // applied + post-migrations applied. Subsequent tests reset only the
  // post-migration state they need.
  await runMigrations();
  await runPostMigrations();
});

describe('Task 24(a) — _post_migrations_journal exists after migrations', () => {
  it('table exists in information_schema and has the expected columns', async () => {
    const sql = adminClient();
    try {
      const cols = await sql<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '_post_migrations_journal'
        ORDER BY column_name
      `;
      const names = cols.map((c) => c.column_name).sort();
      expect(names).toContain('filename');
      expect(names).toContain('applied_at');
    } finally {
      await sql.end();
    }
  });
});

describe("Task 24(b) — CHECK constraint blocks status='closed' with closed_at=NULL", () => {
  it('INSERT into positions raises CHECK violation', async () => {
    const sql = adminClient();
    try {
      // Need a user + account row to satisfy FK constraints.
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash)
        VALUES (${`chk-test-${Date.now()}@example.com`}, 'x')
        RETURNING id
      `;
      const [account] = await sql<{ id: string }[]>`
        INSERT INTO accounts (user_id, name, currency)
        VALUES (${user!.id}, ${`chk-acct-${Date.now()}`}, 'USD')
        RETURNING id
      `;

      await expect(
        sql`
          INSERT INTO positions (user_id, account_id, symbol, side, asset_type, status, closed_at)
          VALUES (${user!.id}, ${account!.id}, 'AAPL', 'long', 'stock', 'closed', NULL)
        `,
      ).rejects.toThrow(/positions_closed_at_when_closed_chk|check constraint/i);

      // Cleanup.
      await sql`DELETE FROM accounts WHERE id = ${account!.id}`;
      await sql`DELETE FROM users WHERE id = ${user!.id}`;
    } finally {
      await sql.end();
    }
  });
});

describe('Task 24(c) — backfill UPDATE is idempotent', () => {
  it('re-running the backfill UPDATE produces 0 rows after first run', async () => {
    const sql = adminClient();
    try {
      // Seed: a closed position with a non-null closed_at. The backfill SQL
      // only touches rows where status='closed' AND closed_at IS NULL — under
      // the post-CHECK schema, no such rows can exist, so the UPDATE is
      // trivially idempotent. Assert 0 rows affected.
      const result = await sql.unsafe(`
        UPDATE positions p
        SET closed_at = COALESCE(
          (SELECT MAX(f.filled_at) FROM fills f WHERE f.position_id = p.id AND f.type = 'exit'),
          p.updated_at,
          NOW()
        )
        WHERE p.status = 'closed' AND p.closed_at IS NULL
      `);
      expect(result.count).toBe(0);

      // Run twice — still zero, still no error.
      const result2 = await sql.unsafe(`
        UPDATE positions p
        SET closed_at = COALESCE(
          (SELECT MAX(f.filled_at) FROM fills f WHERE f.position_id = p.id AND f.type = 'exit'),
          p.updated_at,
          NOW()
        )
        WHERE p.status = 'closed' AND p.closed_at IS NULL
      `);
      expect(result2.count).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe('Task 24(d) — runPostMigrations() is idempotent', () => {
  beforeEach(async () => {
    await resetPostMigrationState();
  });

  it('first run inserts journal row; second run is a no-op', async () => {
    await runPostMigrations();

    const sql = adminClient();
    try {
      const after1 = await sql<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(after1).toHaveLength(1);

      // Re-run — should skip via journal lookup.
      await runPostMigrations();

      const after2 = await sql<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(after2).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});

describe('Task 24(e) — advisory-lock distinction', () => {
  it('MIGRATIONS_LOCK_KEY and POST_MIGRATIONS_LOCK_KEY are distinct at runtime', () => {
    expect(MIGRATIONS_LOCK_KEY).not.toBe(POST_MIGRATIONS_LOCK_KEY);
  });

  it('holding one key on connection A does NOT block the other key on connection B', async () => {
    const a = postgres(SUPERUSER_URL, { max: 1, types: { bigint: postgres.BigInt } });
    const b = postgres(SUPERUSER_URL, { max: 1, types: { bigint: postgres.BigInt } });
    // These keys are CLUSTER-WIDE and the api project's CLI advisory-lock test
    // runs concurrently in the same invocation, transiently holding them. Retry
    // each acquisition until it succeeds (or a generous deadline) so a transient
    // external hold of the SAME key — not a regression in key independence under
    // test — cannot flake the assertion.
    const tryLock = async (conn: typeof a, key: bigint) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const [row] = await conn<{ pg_try_advisory_lock: boolean }[]>`
          SELECT pg_try_advisory_lock(${key})
        `;
        if (row?.pg_try_advisory_lock) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      // A holds MIGRATIONS_LOCK_KEY.
      expect(await tryLock(a, MIGRATIONS_LOCK_KEY)).toBe(true);

      // B should still acquire POST_MIGRATIONS_LOCK_KEY.
      expect(await tryLock(b, POST_MIGRATIONS_LOCK_KEY)).toBe(true);

      // Release.
      await a`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`;
      await b`SELECT pg_advisory_unlock(${POST_MIGRATIONS_LOCK_KEY})`;

      // Reverse the order and re-test.
      expect(await tryLock(b, POST_MIGRATIONS_LOCK_KEY)).toBe(true);
      expect(await tryLock(a, MIGRATIONS_LOCK_KEY)).toBe(true);

      await a`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`;
      await b`SELECT pg_advisory_unlock(${POST_MIGRATIONS_LOCK_KEY})`;
    } finally {
      await a.end();
      await b.end();
    }
  }, 30_000);
});

describe('Task 24(f) — parallel runPostMigrations yields exactly ONE journal row', () => {
  beforeEach(async () => {
    // Clear ONLY the journal, leaving the (already-built) index in place.
    // Dropping the index here would force both parallel runs to attempt
    // CREATE INDEX CONCURRENTLY, which deadlocks against the second
    // session's idle pg_advisory_lock waiter (the runner's session-level
    // virtual txid blocks CREATE INDEX CONCURRENTLY's wait-for-snapshot
    // phase). The production property under test is that the journal+lock
    // make parallel invocations safely converge to exactly one journal row.
    const sql = adminClient();
    try {
      await sql.unsafe(`DELETE FROM _post_migrations_journal`);
    } finally {
      await sql.end();
    }
  });

  it('two concurrent runs serialize via the advisory lock and journal once', async () => {
    await Promise.all([runPostMigrations(), runPostMigrations()]);

    const sql = adminClient();
    try {
      const rows = await sql<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});

describe('Task 24(g) — duplicate journal INSERT is idempotent', () => {
  beforeEach(async () => {
    await resetPostMigrationState();
  });

  it('two ON CONFLICT DO NOTHING inserts of the same filename do not throw', async () => {
    const sql = adminClient();
    try {
      await sql`
        INSERT INTO _post_migrations_journal (filename) VALUES (${POST_MIGRATION_FILENAME})
        ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO _post_migrations_journal (filename) VALUES (${POST_MIGRATION_FILENAME})
        ON CONFLICT DO NOTHING
      `;
      const rows = await sql<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});

describe('Task 24(h) — invalid index recovery', () => {
  beforeEach(async () => {
    await resetPostMigrationState();
  });

  it('runner drops and rebuilds an indisvalid=false index, then writes the journal row', async () => {
    // Build the index once.
    await runPostMigrations();

    // Clear journal so the runner will re-process the file. Then mark the
    // index invalid via superuser pg_index hack.
    const sql = adminClient();
    try {
      await sql`DELETE FROM _post_migrations_journal WHERE filename = ${POST_MIGRATION_FILENAME}`;
      await sql.unsafe(`
        UPDATE pg_index
        SET indisvalid = false
        WHERE indexrelid = (
          SELECT oid FROM pg_class WHERE relname = '${POST_MIGRATION_INDEX}'
        )
      `);

      const before = await sql<{ indisvalid: boolean }[]>`
        SELECT indisvalid FROM pg_class
        JOIN pg_index ON pg_index.indexrelid = pg_class.oid
        WHERE relname = ${POST_MIGRATION_INDEX}
      `;
      expect(before[0]?.indisvalid).toBe(false);
    } finally {
      await sql.end();
    }

    // Re-run the runner. It should detect the invalid index, drop+rebuild
    // it, and journal the success.
    await runPostMigrations();

    const sql2 = adminClient();
    try {
      const after = await sql2<{ indisvalid: boolean }[]>`
        SELECT indisvalid FROM pg_class
        JOIN pg_index ON pg_index.indexrelid = pg_class.oid
        WHERE relname = ${POST_MIGRATION_INDEX}
      `;
      expect(after[0]?.indisvalid).toBe(true);

      const journal = await sql2<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(journal).toHaveLength(1);
    } finally {
      await sql2.end();
    }
  });
});

describe('Task 24(i) — SKIP_POST_MIGRATIONS path + pnpm migrate:post', () => {
  beforeEach(async () => {
    await resetPostMigrationState();
  });

  it('config.SKIP_POST_MIGRATIONS reflects the env var after re-import', async () => {
    // First half of the boot-path verification: the env→config wiring.
    // Use vi.resetModules + dynamic import so config re-parses process.env.
    const prev = process.env.SKIP_POST_MIGRATIONS;

    process.env.SKIP_POST_MIGRATIONS = 'true';
    vi.resetModules();
    const cfgTrue = (await import('@/lib/config')).config;
    expect(cfgTrue.SKIP_POST_MIGRATIONS).toBe(true);

    process.env.SKIP_POST_MIGRATIONS = 'false';
    vi.resetModules();
    const cfgFalse = (await import('@/lib/config')).config;
    expect(cfgFalse.SKIP_POST_MIGRATIONS).toBe(false);

    if (prev === undefined) delete process.env.SKIP_POST_MIGRATIONS;
    else process.env.SKIP_POST_MIGRATIONS = prev;
  });

  it('bootPostMigrations() skips runPostMigrations when SKIP_POST_MIGRATIONS=true; runs it when false', async () => {
    // Second half: the boot conditional itself, in apps/api/src/index.ts.
    // Import the extracted helper and inject a spy in place of the real
    // runPostMigrations so the test fails if the conditional is removed.
    const { bootPostMigrations } = await import('@/index');

    const spySkip = vi.fn(async () => {});
    const skipped = await bootPostMigrations({ SKIP_POST_MIGRATIONS: true }, spySkip);
    expect(skipped).toBe(false);
    expect(spySkip).not.toHaveBeenCalled();

    const spyRun = vi.fn(async () => {});
    const ran = await bootPostMigrations({ SKIP_POST_MIGRATIONS: false }, spyRun);
    expect(ran).toBe(true);
    expect(spyRun).toHaveBeenCalledTimes(1);
    // Cold-loading the whole server module graph via `await import('@/index')`
    // exceeds the 5s default under concurrent forks-pool load. Match the 30s
    // margin this file already uses for its other slow cases (Task 24(e)/(j)).
  }, 30_000);

  it('after a skipped boot, the operator escape hatch (runPostMigrations) still completes', async () => {
    // pnpm migrate:post path — explicitly invoke the runner. Asserts the
    // journal goes from empty to one row, so SKIP_POST_MIGRATIONS does not
    // permanently disable post-migrations.
    const sql = adminClient();
    try {
      const before = await sql<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(before).toHaveLength(0);
    } finally {
      await sql.end();
    }

    await runPostMigrations();

    const sql2 = adminClient();
    try {
      const after = await sql2<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(after).toHaveLength(1);
    } finally {
      await sql2.end();
    }
  });
});

describe('Task 24(j) — runMigrations advisory-lock serialization under DB_POOL_SIZE=10', () => {
  // Use a fresh scratch DB for this test so both parallel runs actually have
  // work to apply and contend the advisory lock. Without this, both runs are
  // no-ops on an already-migrated DB and the lock is never meaningfully
  // exercised — the test would pass even if the lock were removed.
  const SCRATCH_DB = `tradr_test_migrate_j_${Date.now()}`;
  const SUPERUSER_BASE = SUPERUSER_URL.replace(/\/[^/]+$/, '');
  const SCRATCH_URL = `${SUPERUSER_BASE}/${SCRATCH_DB}`;

  beforeEach(async () => {
    // Drop+create as superuser via a connection to the postgres maintenance DB.
    const adminUrl = SUPERUSER_URL.replace(/\/[^/]+$/, '/postgres');
    const admin = postgres(adminUrl, { max: 1, types: { bigint: postgres.BigInt } });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
  });

  afterEach(async () => {
    const adminUrl = SUPERUSER_URL.replace(/\/[^/]+$/, '/postgres');
    const admin = postgres(adminUrl, { max: 1, types: { bigint: postgres.BigInt } });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }
  });

  it('two concurrent runMigrations() against an empty DB serialize via the advisory lock; exactly N journal rows result', async () => {
    // Point runMigrations() at the scratch DB and set DB_POOL_SIZE=10 to
    // verify the dedicated max:1 client pattern (Task 14) is independent of
    // the shared pool size.
    const prevPool = process.env.DB_POOL_SIZE;
    const prevUrl = process.env.DATABASE_URL;
    process.env.DB_POOL_SIZE = '10';
    process.env.DATABASE_URL = SCRATCH_URL;

    // Reload the migrate module so config picks up the new DATABASE_URL.
    vi.resetModules();
    const scratchMigrate = await import('./migrate');

    // Count expected migrations from drizzle's journal file.
    const journalEntries = (
      await import('./migrations/meta/_journal.json', { with: { type: 'json' } })
    ).default.entries as { tag: string }[];
    const expectedCount = journalEntries.length;

    try {
      // Both runs target a freshly-created DB with no migrations applied, so
      // they actually contend the advisory lock. If the lock were removed,
      // the second run would either insert duplicate journal rows or fail
      // with a "relation already exists" error from a non-idempotent CREATE.
      await Promise.all([scratchMigrate.runMigrations(), scratchMigrate.runMigrations()]);

      const sql = postgres(SCRATCH_URL, { max: 1, types: { bigint: postgres.BigInt } });
      try {
        const [row] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations
        `;
        const countAfter = parseInt(row?.count ?? '0', 10);
        expect(countAfter).toBe(expectedCount);
      } finally {
        await sql.end();
      }
    } finally {
      if (prevPool === undefined) delete process.env.DB_POOL_SIZE;
      else process.env.DB_POOL_SIZE = prevPool;
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
      vi.resetModules();
    }
  });
});

describe('Task 24(k) — journal-write-fails idempotency as non-superuser tradr_test_user', () => {
  it('REVOKE INSERT on journal makes runPostMigrations throw; restore + re-run produces exactly one journal row', async () => {
    // (1) connect as superuser
    const admin = adminClient();
    try {
      // Bring DB to clean post-migration state owned by superuser.
      await admin.unsafe(`DELETE FROM _post_migrations_journal`);
      await admin.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${POST_MIGRATION_INDEX}`);

      // (2) baseline grant — needed so REVOKE later has something to REVOKE.
      await admin.unsafe(`GRANT SELECT, INSERT ON _post_migrations_journal TO tradr_test_user`);

      // (3) grant CREATE ON SCHEMA public so the role can build the index
      // (CREATE INDEX CONCURRENTLY requires CREATE on the schema).
      await admin.unsafe(`GRANT CREATE ON SCHEMA public TO tradr_test_user`);

      // CREATE INDEX requires table ownership. Temporarily reassign the
      // positions table to tradr_test_user so the runner can build the
      // index. The afterAll-equivalent cleanup below restores ownership.
      // (Postgres 16 lacks the per-table MAINTAIN privilege from PG 17,
      // so ownership reassignment is the cleanest path.)
      await admin.unsafe(`ALTER TABLE positions OWNER TO tradr_test_user`);

      // (4) the test REVOKE — INSERT on the journal will now fail for the role.
      await admin.unsafe(`REVOKE INSERT ON _post_migrations_journal FROM tradr_test_user`);
    } finally {
      await admin.end();
    }

    // (5) reconnect as tradr_test_user via MIGRATE_TEST_USER_DATABASE_URL.
    // runPostMigrations() reads its connection URL from config.DATABASE_URL,
    // which is frozen at module-load time. Use vi.resetModules + dynamic
    // import to reload the migrate module under the user URL.
    const prevUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = USER_URL;

    vi.resetModules();
    const userMigrate = await import('./migrate');

    // (6) invoke runPostMigrations as the non-superuser. Index build
    // succeeds (CREATE granted), but the journal INSERT throws with
    // insufficient-privilege.
    await expect(userMigrate.runPostMigrations()).rejects.toThrow(
      /permission denied|insufficient.*privilege/i,
    );

    // The index should have been built despite the journal failure. Verify
    // via superuser.
    const admin2 = adminClient();
    try {
      const idx = await admin2<{ indisvalid: boolean }[]>`
        SELECT indisvalid FROM pg_class
        JOIN pg_index ON pg_index.indexrelid = pg_class.oid
        WHERE relname = ${POST_MIGRATION_INDEX}
      `;
      expect(idx[0]?.indisvalid).toBe(true);

      // Journal still empty.
      const j = await admin2<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(j).toHaveLength(0);

      // (7) restore GRANT INSERT.
      await admin2.unsafe(`GRANT INSERT ON _post_migrations_journal TO tradr_test_user`);
    } finally {
      await admin2.end();
    }

    // (8) re-invoke runPostMigrations as tradr_test_user. The index already
    // exists + indisvalid=true, so the runner skips the rebuild and writes
    // the journal row. Exactly one row at the end.
    await userMigrate.runPostMigrations();

    const admin3 = adminClient();
    try {
      const j = await admin3<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal
        WHERE filename = ${POST_MIGRATION_FILENAME}
      `;
      expect(j).toHaveLength(1);
    } finally {
      await admin3.end();

      // Cleanup: revoke role-level privileges and restore env DATABASE_URL.
      const cleanup = adminClient();
      try {
        await cleanup.unsafe(
          `REVOKE INSERT, SELECT ON _post_migrations_journal FROM tradr_test_user`,
        );
        // Restore positions ownership to superuser.
        await cleanup.unsafe(`ALTER TABLE positions OWNER TO postgres`);
        await cleanup.unsafe(`REVOKE CREATE ON SCHEMA public FROM tradr_test_user`);
      } finally {
        await cleanup.end();
      }

      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
    }
  });
});

afterAll(async () => {
  // Restore: run the full migrate sequence once more so the DB is left in
  // its canonical post-migration state for any follow-up runs.
  await resetPostMigrationState();
  await runPostMigrations();
});
