/**
 * Integration tests for `tradr migrate --status` against a real Postgres.
 *
 * These tests follow the repo's real-Postgres pattern (dedicated `max:1`
 * connections, scratch databases for destructive/never-migrated cases) rather
 * than the per-test transaction-rollback harness in `src/test-setup.ts`:
 *   - the never-migrated case needs a DB with NO drizzle table, which the
 *     shared `tradr_test` DB (already migrated by the setup file) cannot offer;
 *   - the cross-session lock case REQUIRES two distinct connections, so a
 *     single shared transaction is unusable;
 *   - advisory locks and `to_regclass` are not transactional in a way the
 *     rollback harness could isolate across connections.
 *
 * The CLI's `gatherStatus(sql)` takes a caller-supplied connection and reads
 * the on-disk journal/post-migration folders from the module constants, so we
 * exercise it directly against each scratch DB.
 *
 * Cases (per design Testing Strategy + Req 6.3, 6.8, 7.5):
 *   (a) never-migrated  -> all standard pending AND drizzle table still NULL
 *                          after a status run (read-only, Req 6.3)
 *   (b) fully migrated  -> exitCode 0 (Req 6.4)
 *   (c) SKIP_POST       -> post track reported pending (Req 7.5)
 *   (d) cross-session   -> hold 7064001 then 7064002 on connection A; status on
 *                          connection B reports held; release -> not held (Req 6.8)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcrypt';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { MIGRATIONS_LOCK_KEY, POST_MIGRATIONS_LOCK_KEY } from '@/db/migrate';
import * as schema from '@/db/schema';

import { gatherStatus, resetPassword } from './tradr';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../db/migrations');

const BASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';
const ADMIN_URL = BASE_URL.replace(/\/[^/]+$/, '/postgres');
const BASE_NO_DB = BASE_URL.replace(/\/[^/]+$/, '');

function client(url: string) {
  return postgres(url, { max: 1, types: { bigint: postgres.BigInt }, onnotice: () => {} });
}

/** Drop+create a scratch DB via the maintenance connection. Returns its URL. */
async function createScratchDb(name: string): Promise<string> {
  const admin = client(ADMIN_URL);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return `${BASE_NO_DB}/${name}`;
}

async function dropScratchDb(name: string): Promise<void> {
  const admin = client(ADMIN_URL);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Apply the standard drizzle migrations against the given URL. */
async function applyStandardMigrations(url: string): Promise<void> {
  const sql = client(url);
  try {
    await migrate(drizzle(sql, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }
}

describe('Req 6.3 — never-migrated DB is reported all-pending and stays untouched (read-only)', () => {
  const DB = `tradr_test_cli_never_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('reports every standard + post migration as pending without creating any table', async () => {
    const sql = client(url);
    try {
      // Pre-condition: drizzle table absent.
      const before = await sql<{ reg: string | null }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations')::text AS reg
      `;
      expect(before[0]?.reg).toBeNull();

      const report = await gatherStatus(sql);

      expect(report.standard.tableExists).toBe(false);
      expect(report.standard.applied).toBe(0);
      expect(report.standard.pending.length).toBeGreaterThan(0);
      expect(report.post.tableExists).toBe(false);
      expect(report.post.applied).toBe(0);
      expect(report.post.pending.length).toBeGreaterThan(0);
      expect(report.exitCode).toBe(1);

      // Read-only assertion: the status run MUST NOT have created the drizzle
      // table (the exact failure mode Req 6.3 guards against).
      const after = await sql<{ reg: string | null }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations')::text AS reg
      `;
      expect(after[0]?.reg).toBeNull();

      const afterPost = await sql<{ reg: string | null }[]>`
        SELECT to_regclass('_post_migrations_journal')::text AS reg
      `;
      expect(afterPost[0]?.reg).toBeNull();
    } finally {
      await sql.end();
    }
  });
});

describe('Req 6.4 — a fully migrated DB reports exit 0', () => {
  const DB = `tradr_test_cli_migrated_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    await applyStandardMigrations(url);
    // Stand up the post-migration journal and mark every on-disk file applied
    // so the post track has zero pending (matching a fully-migrated runner).
    const sql = client(url);
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS _post_migrations_journal (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Insert each on-disk post-migration filename so diffPost sees none pending.
      const { readdir } = await import('node:fs/promises');
      const dir = path.resolve(__dirname, '../db/post-migrations');
      const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
      for (const filename of entries) {
        await sql`INSERT INTO _post_migrations_journal (filename) VALUES (${filename}) ON CONFLICT DO NOTHING`;
      }
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('reports both tracks current and exitCode 0', async () => {
    const sql = client(url);
    try {
      const report = await gatherStatus(sql);
      expect(report.standard.tableExists).toBe(true);
      expect(report.standard.pending).toEqual([]);
      expect(report.post.tableExists).toBe(true);
      expect(report.post.pending).toEqual([]);
      expect(report.exitCode).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

describe('Req 7.5 — SKIP_POST_MIGRATIONS leaves the post track reported pending', () => {
  const DB = `tradr_test_cli_skippost_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    // Standard migrations applied (these create the empty
    // _post_migrations_journal table, migration 0004), but post-migrations are
    // skipped — so no post-migration filename is ever journaled. This mirrors
    // the SKIP_POST_MIGRATIONS boot path.
    await applyStandardMigrations(url);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('reports standard current but post pending with a non-zero exit', async () => {
    const sql = client(url);
    try {
      const report = await gatherStatus(sql);
      expect(report.standard.tableExists).toBe(true);
      expect(report.standard.pending).toEqual([]);
      // The journal table exists (standard migration 0004) but is empty because
      // post-migrations were skipped -> every on-disk post-migration is pending.
      expect(report.post.tableExists).toBe(true);
      expect(report.post.applied).toBe(0);
      expect(report.post.pending.length).toBeGreaterThan(0);
      expect(report.exitCode).toBe(1);
    } finally {
      await sql.end();
    }
  });
});

describe('REQ-8 — reset-password directly sets a bcrypt hash that authenticates', () => {
  const DB = `tradr_test_cli_resetpw_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    await applyStandardMigrations(url);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('replaces the hash so the NEW password authenticates and the old one no longer does', async () => {
    const sql = client(url);
    try {
      const email = 'reset-me@example.com';
      const oldHash = await bcrypt.hash('old-password-123', 10);
      await sql`INSERT INTO users (email, password_hash) VALUES (${email}, ${oldHash})`;

      const found = await resetPassword(sql, email, 'brand-new-password');
      expect(found).toBe(true);

      const [row] = await sql<{ password_hash: string }[]>`
        SELECT password_hash FROM users WHERE email = ${email}
      `;
      expect(await bcrypt.compare('brand-new-password', row.password_hash)).toBe(true);
      expect(await bcrypt.compare('old-password-123', row.password_hash)).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it('reports cleanly for an unknown email (no crash, no row updated)', async () => {
    const sql = client(url);
    try {
      const found = await resetPassword(sql, 'nobody@example.com', 'whatever-123');
      expect(found).toBe(false);
    } finally {
      await sql.end();
    }
  });
});

describe('REQ-4.4 / D15 — reset-password atomically invalidates outstanding reset tokens', () => {
  const DB = `tradr_test_cli_resettok_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    await applyStandardMigrations(url);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  /**
   * `email_verified` defaults TRUE (0015's verified-at-creation default), so
   * insert explicitly-unverified users: the interesting REQ-6.5 direction is
   * that the CLI must NOT flip false -> true (a command proves nothing about
   * the mailbox).
   */
  async function insertUnverifiedUser(sql: postgres.Sql, email: string): Promise<string> {
    const oldHash = await bcrypt.hash('old-password-123', 10);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, email_verified)
      VALUES (${email}, ${oldHash}, false) RETURNING id
    `;
    return row.id;
  }

  function insertLiveToken(
    sql: postgres.Sql,
    userId: string,
    purpose: 'password_reset' | 'email_verification',
    tokenHash: string,
  ) {
    return sql`
      INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
      VALUES (${userId}, ${purpose}, ${tokenHash}, now() + interval '1 hour')
    `;
  }

  const RESET_HASH = 'a'.repeat(64);
  const VERIFY_HASH = 'b'.repeat(64);
  const OTHER_RESET_HASH = 'c'.repeat(64);

  it('deletes outstanding reset rows (pre-issued token can no longer complete); verification row and email_verified untouched; password changed', async () => {
    const sql = client(url);
    try {
      const email = 'invalidate-me@example.com';
      const userId = await insertUnverifiedUser(sql, email);
      await insertLiveToken(sql, userId, 'password_reset', RESET_HASH);
      await insertLiveToken(sql, userId, 'email_verification', VERIFY_HASH);

      const found = await resetPassword(sql, email, 'brand-new-password');
      expect(found).toBe(true);

      // All outstanding password_reset rows are gone (REQ-4.4).
      const resetRows = await sql<{ id: string }[]>`
        SELECT id FROM email_tokens WHERE user_id = ${userId} AND purpose = 'password_reset'
      `;
      expect(resetRows).toHaveLength(0);

      // The exact takeover REQ-4.4 guards against: the completion endpoint's
      // atomic consume (consumeEmailToken's statement) now matches zero rows,
      // so the pre-issued live token cannot complete a reset.
      const consumed = await sql<{ user_id: string }[]>`
        UPDATE email_tokens SET consumed_at = now()
        WHERE token_hash = ${RESET_HASH} AND purpose = 'password_reset'
          AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id
      `;
      expect(consumed).toHaveLength(0);

      // email_verification rows are untouched — still live.
      const verifyRows = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM email_tokens
        WHERE user_id = ${userId} AND purpose = 'email_verification'
      `;
      expect(verifyRows).toHaveLength(1);
      expect(verifyRows[0].consumed_at).toBeNull();

      // The CLI does NOT mark verified (REQ-6.5 pinned NO).
      const [user] = await sql<{ email_verified: boolean; password_hash: string }[]>`
        SELECT email_verified, password_hash FROM users WHERE id = ${userId}
      `;
      expect(user.email_verified).toBe(false);

      // Direct-set semantics unchanged: the new password verifies, the old fails.
      expect(await bcrypt.compare('brand-new-password', user.password_hash)).toBe(true);
      expect(await bcrypt.compare('old-password-123', user.password_hash)).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it('returns false for a nonexistent email and deletes nothing', async () => {
    const sql = client(url);
    try {
      const bystanderId = await insertUnverifiedUser(sql, 'bystander@example.com');
      await insertLiveToken(sql, bystanderId, 'password_reset', OTHER_RESET_HASH);

      const found = await resetPassword(sql, 'missing@example.com', 'whatever-123');
      expect(found).toBe(false);

      // The bystander's live reset token survives untouched.
      const rows = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM email_tokens
        WHERE user_id = ${bystanderId} AND purpose = 'password_reset'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].consumed_at).toBeNull();
    } finally {
      await sql.end();
    }
  });
});

describe('Req 6.8 — cross-session advisory-lock detection (connection A holds, connection B observes)', () => {
  const DB = `tradr_test_cli_locks_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    await applyStandardMigrations(url);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('detects each lock held on connection A from a separate connection B, and clears after release', async () => {
    const a = client(url); // migrating session holding the lock(s)
    const b = client(url); // the --status connection observing the cluster

    // These keys are CLUSTER-WIDE: the `migrations` vitest project runs in the
    // same invocation and transiently holds MIGRATIONS_LOCK_KEY /
    // POST_MIGRATIONS_LOCK_KEY in its own beforeAll + lock tests. Poll for the
    // expected cluster state (rather than asserting one instantaneous read) and
    // retry A's own acquisition, so transient external holds — not a regression
    // in the detection logic under test — cannot flake the assertions.
    const acquire = async (key: bigint) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const [row] = await a<{ locked: boolean }[]>`
          SELECT pg_try_advisory_lock(${key}) AS locked
        `;
        if (row?.locked) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const awaitLocks = async (expected: { migrations: boolean; postMigrations: boolean }) => {
      const deadline = Date.now() + 8000;
      let report = await gatherStatus(b);
      while (
        (report.locks.migrations !== expected.migrations ||
          report.locks.postMigrations !== expected.postMigrations) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
        report = await gatherStatus(b);
      }
      return report;
    };

    try {
      // Baseline: neither key held (waits out any transient external hold).
      const baseline = await awaitLocks({ migrations: false, postMigrations: false });
      expect(baseline.locks.migrations).toBe(false);
      expect(baseline.locks.postMigrations).toBe(false);

      // A acquires the migrations lock (session-level).
      expect(await acquire(MIGRATIONS_LOCK_KEY)).toBe(true);

      // B (separate connection) must observe it as held — cluster-visible.
      const heldMigrations = await awaitLocks({ migrations: true, postMigrations: false });
      expect(heldMigrations.locks.migrations).toBe(true);
      expect(heldMigrations.locks.postMigrations).toBe(false);

      // A also acquires the post-migrations lock.
      expect(await acquire(POST_MIGRATIONS_LOCK_KEY)).toBe(true);

      const heldBoth = await awaitLocks({ migrations: true, postMigrations: true });
      expect(heldBoth.locks.migrations).toBe(true);
      expect(heldBoth.locks.postMigrations).toBe(true);

      // Release both on A.
      await a`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`;
      await a`SELECT pg_advisory_unlock(${POST_MIGRATIONS_LOCK_KEY})`;

      // B observes both released (waits out any transient external hold).
      const released = await awaitLocks({ migrations: false, postMigrations: false });
      expect(released.locks.migrations).toBe(false);
      expect(released.locks.postMigrations).toBe(false);
    } finally {
      await a.end();
      await b.end();
    }
  }, 30_000);
});
