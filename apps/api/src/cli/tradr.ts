#!/usr/bin/env node
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import postgres from 'postgres';

import {
  MIGRATIONS_DIR,
  MIGRATIONS_LOCK_KEY,
  POST_MIGRATIONS_DIR,
  POST_MIGRATIONS_LOCK_KEY,
} from '@/db/migrate';
import { hashPassword } from '@/features/auth/auth.service';
import { config } from '@/lib/config';

import { runStorageGc, runStorageMigrateToInline } from './storage-maintenance.service';

// Reuse the runner's folder resolution (db/migrate.ts) so the CLI reads the
// exact same on-disk truth in dev (tsx → src/db/...) and in the compiled image
// (esbuild bundles both entries with dist/ as __thisDir → dist/migrations).
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json');

const DRIZZLE_TABLE = 'drizzle.__drizzle_migrations';
const POST_TABLE = '_post_migrations_journal';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no DB/IO).
// ---------------------------------------------------------------------------

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface TrackStatus {
  applied: number;
  pending: string[];
  tableExists: boolean;
}

export interface LockStatus {
  migrations: boolean;
  postMigrations: boolean;
}

export interface StatusReport {
  standard: TrackStatus;
  post: TrackStatus;
  locks: LockStatus;
  exitCode: 0 | 1 | 2;
}

/**
 * Standard-track diff matching the runner's timestamp semantics
 * (drizzle-orm 0.38.4 pg-core/dialect.js:62 applies an entry iff
 * `folderMillis > max(created_at)`, ignoring hash).
 *
 * @param entries  journal entries (`meta/_journal.json`), each with `when` (folderMillis)
 * @param maxCreatedAt  max `created_at` in `drizzle.__drizzle_migrations`, or null when none applied
 * @param tableExists  whether `drizzle.__drizzle_migrations` exists (to_regclass non-null)
 */
export function diffStandard(
  entries: JournalEntry[],
  maxCreatedAt: number | null,
  tableExists: boolean,
): TrackStatus {
  const ordered = [...entries].sort((a, b) => a.when - b.when);
  if (!tableExists || maxCreatedAt === null) {
    return { applied: 0, pending: ordered.map((e) => e.tag), tableExists };
  }
  const pending = ordered.filter((e) => e.when > maxCreatedAt);
  return {
    applied: ordered.length - pending.length,
    pending: pending.map((e) => e.tag),
    tableExists,
  };
}

/**
 * Post-track diff by filename: pending = on-disk `*.sql` − applied filenames.
 */
export function diffPost(
  onDiskFiles: string[],
  appliedFilenames: string[],
  tableExists: boolean,
): TrackStatus {
  const ordered = [...onDiskFiles].filter((f) => f.endsWith('.sql')).sort();
  if (!tableExists) {
    return { applied: 0, pending: ordered, tableExists };
  }
  const applied = new Set(appliedFilenames);
  const pending = ordered.filter((f) => !applied.has(f));
  return { applied: ordered.length - pending.length, pending, tableExists };
}

/**
 * Split a single-argument 64-bit advisory key into the (classid, objid)
 * columns `pg_locks` exposes for the `pg_advisory_lock(bigint)` form.
 * objsubid is always 1 for the single-bigint form.
 */
export function decodeLockKey(key: bigint): { classid: number; objid: number; objsubid: 1 } {
  return {
    classid: Number(key >> 32n),
    objid: Number(key & 0xffffffffn),
    objsubid: 1,
  };
}

/**
 * Exit code selection: 0 current, 1 pending (either track), 2 cannot connect.
 * Connection failure is handled separately (caller passes the report only on
 * a successful connect), so this only distinguishes 0 vs 1.
 */
export function selectExitCode(standard: TrackStatus, post: TrackStatus): 0 | 1 {
  return standard.pending.length > 0 || post.pending.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// IO helpers.
// ---------------------------------------------------------------------------

async function readJournal(): Promise<JournalEntry[]> {
  const raw = await readFile(JOURNAL_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
  return parsed.entries ?? [];
}

async function readPostMigrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(POST_MIGRATIONS_DIR);
    return entries.filter((f) => f.endsWith('.sql'));
  } catch {
    return [];
  }
}

/**
 * Returns true iff the advisory lock for `key` is held by any session.
 * Read-only: queries pg_locks only.
 */
async function isLockHeld(sql: postgres.Sql, key: bigint): Promise<boolean> {
  const { classid, objid, objsubid } = decodeLockKey(key);
  const rows = await sql<{ held: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = ${classid}
        AND objid = ${objid}
        AND objsubid = ${objsubid}
    ) AS held
  `;
  return rows[0]?.held ?? false;
}

// ---------------------------------------------------------------------------
// Status gathering (read-only).
// ---------------------------------------------------------------------------

export async function gatherStatus(sql: postgres.Sql): Promise<StatusReport> {
  // Standard track: existence first via to_regclass (NULL when absent — never
  // creates the table, never throws). Only query the table when it exists.
  const stdRegRows = await sql<{ reg: string | null }[]>`
    SELECT to_regclass(${DRIZZLE_TABLE})::text AS reg
  `;
  const standardTableExists = stdRegRows[0]?.reg != null;

  let maxCreatedAt: number | null = null;
  if (standardTableExists) {
    const rows = await sql<{ max_created_at: string | null }[]>`
      SELECT max(created_at)::text AS max_created_at FROM drizzle.__drizzle_migrations
    `;
    const raw = rows[0]?.max_created_at;
    maxCreatedAt = raw == null ? null : Number(raw);
  }
  const journal = await readJournal();
  const standard = diffStandard(journal, maxCreatedAt, standardTableExists);

  // Post track: existence first, then SELECT filename.
  const postRegRows = await sql<{ reg: string | null }[]>`
    SELECT to_regclass(${POST_TABLE})::text AS reg
  `;
  const postTableExists = postRegRows[0]?.reg != null;

  let appliedPost: string[] = [];
  if (postTableExists) {
    const rows = await sql<{ filename: string }[]>`
      SELECT filename FROM _post_migrations_journal
    `;
    appliedPost = rows.map((r) => r.filename);
  }
  const onDiskPost = await readPostMigrationFiles();
  const post = diffPost(onDiskPost, appliedPost, postTableExists);

  const locks: LockStatus = {
    migrations: await isLockHeld(sql, MIGRATIONS_LOCK_KEY),
    postMigrations: await isLockHeld(sql, POST_MIGRATIONS_LOCK_KEY),
  };

  return { standard, post, locks, exitCode: selectExitCode(standard, post) };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function printReport(report: StatusReport): void {
  const { standard, post, locks } = report;

  console.log('Standard migrations (drizzle.__drizzle_migrations):');
  console.log(`  table exists: ${standard.tableExists}`);
  console.log(`  applied: ${standard.applied}`);
  if (standard.pending.length > 0) {
    console.log(`  pending (${standard.pending.length}): ${standard.pending.join(', ')}`);
  } else {
    console.log('  pending: none');
  }

  console.log('Post-migrations (_post_migrations_journal):');
  console.log(`  table exists: ${post.tableExists}`);
  console.log(`  applied: ${post.applied}`);
  if (post.pending.length > 0) {
    console.log(`  pending (${post.pending.length}): ${post.pending.join(', ')}`);
  } else {
    console.log('  pending: none');
  }

  console.log('Advisory locks:');
  console.log(`  migrations (7064001) held: ${locks.migrations}`);
  console.log(`  post-migrations (7064002) held: ${locks.postMigrations}`);

  if (report.exitCode === 0) {
    console.log('Schema is up to date.');
  } else {
    console.log('Schema has PENDING migrations.');
  }
}

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

/**
 * Pooler-safe connection args for `tradr migrate --status` (SF-5, design C7).
 * Prefer `DIRECT_DATABASE_URL` (the non-pooled connection) when configured, and
 * ALWAYS `prepare:false` so the status read is safe even when pointed straight
 * at a transaction pooler — the Task 20 backup drill depends on this. This is a
 * read-only status that never takes the migration advisory lock, so unlike
 * `resolveMigrationUrl` it needs no DIRECT and applies no fail-loud guard.
 */
export function statusConnectionArgs(
  directUrl: string | undefined,
  databaseUrl: string,
): { url: string; prepare: false } {
  return { url: directUrl ?? databaseUrl, prepare: false };
}

export async function runStatus(): Promise<number> {
  const conn = statusConnectionArgs(config.DIRECT_DATABASE_URL, config.DATABASE_URL);
  // Dedicated read-only connection — NOT the shared db/index.ts pool.
  const sql = postgres(conn.url, {
    max: 1,
    prepare: conn.prepare,
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
  try {
    const report = await gatherStatus(sql);
    printReport(report);
    return report.exitCode;
  } catch (err) {
    console.error('Cannot connect to the database.');
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Password recovery (REQ-8, D7): admin-assisted direct-set, no delivery channel.
// ---------------------------------------------------------------------------

export interface ResetPasswordArgs {
  email?: string;
  password?: string;
  error?: string;
}

/**
 * Parse `reset-password <email> [--password <value>]`. Pure (no IO) so the
 * dispatch is unit-testable. An absent `--password` means "generate one".
 */
export function parseResetPasswordArgs(args: string[]): ResetPasswordArgs {
  let email: string | undefined;
  let password: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--password') {
      password = args[i + 1];
      if (password === undefined) return { error: '--password requires a value' };
      i++;
    } else if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
    } else if (!arg.startsWith('-') && email === undefined) {
      email = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!email) return { error: 'An email is required' };
  return { email, password };
}

/** A strong random password for the generated-and-displayed path (REQ-8.1). */
export function generatePassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Directly set `users.password_hash` for `email` to a bcrypt hash of
 * `newPassword`, returning true iff a matching account existed. No token, no
 * email/delivery channel — the operator owns the box (REQ-8.1/8.4). Takes a
 * caller-supplied connection so it is real-Postgres testable (like gatherStatus).
 *
 * ONE transaction (D15): plain SELECT id (deliberately no FOR UPDATE — keeps
 * the lock order clean) → DELETE outstanding `password_reset` tokens → UPDATE
 * password_hash. Atomic, so no window exists in which a live emailed reset
 * token can overwrite the operator's just-set password (REQ-4.4). Lock order
 * email_tokens → users (alphabetical) matches D8's completion transaction — no
 * AB/BA pair. Deliberately does NOT mark the account verified (REQ-6.5 pinned
 * NO — a command proves nothing about the mailbox) and does NOT revoke
 * sessions (pre-existing asymmetry with D8).
 */
export async function resetPassword(
  sql: postgres.Sql,
  email: string,
  newPassword: string,
): Promise<boolean> {
  // Bcrypt is slow by design — hash before the transaction opens to keep it short.
  const passwordHash = await hashPassword(newPassword);
  return sql.begin(async (txRaw) => {
    // postgres.js 3.4 typing quirk: TransactionSql is built via Omit<Sql, ...>,
    // and TypeScript drops call signatures through mapped types — cast back to
    // the callable Sql shape (the backup-restore-check.test.ts precedent).
    const tx = txRaw as unknown as postgres.Sql;
    const users = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${email}
    `;
    const userId = users[0]?.id;
    if (userId === undefined) return false;
    await tx`
      DELETE FROM email_tokens WHERE user_id = ${userId} AND purpose = 'password_reset'
    `;
    const updated = await tx<{ id: string }[]>`
      UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId} RETURNING id
    `;
    return updated.length > 0;
  });
}

export async function runResetPassword(argv: string[]): Promise<number> {
  const parsed = parseResetPasswordArgs(argv);
  if (parsed.error || !parsed.email) {
    console.error(parsed.error ?? 'An email is required');
    console.error('Usage: tradr reset-password <email> [--password <value>]');
    return 2;
  }
  const generated = parsed.password === undefined;
  const newPassword = parsed.password ?? generatePassword();

  // Pooler-safe one-shot connection (SF-4, Task 1's DIRECT_DATABASE_URL): prefer
  // the direct (non-pooled) URL when configured, always prepare:false.
  const sql = postgres(config.DIRECT_DATABASE_URL ?? config.DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const found = await resetPassword(sql, parsed.email, newPassword);
    if (!found) {
      console.error(`No account found for ${parsed.email}.`);
      return 1;
    }
    console.log(`Password reset for ${parsed.email}.`);
    if (generated) {
      console.log(`New password: ${newPassword}`);
    } else {
      console.log('New password set from --password.');
    }
    return 0;
  } catch (err) {
    console.error('Cannot connect to the database.');
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    await sql.end();
  }
}

const USAGE = [
  'Usage:',
  '  tradr migrate --status',
  '  tradr storage migrate-to-inline',
  '  tradr storage gc',
  '  tradr reset-password <email> [--password <value>]',
];

/**
 * Print the usage block.
 *
 * `asError` distinguishes the two callers. An unrecognised command is a failure:
 * usage goes to stderr and the process exits non-zero. An explicit `--help` is a
 * success: it goes to stdout and exits 0, so `tradr --help | less` works and a
 * shell script asking for help does not see a failure.
 */
function usage(asError = true): void {
  const write = asError ? console.error : console.log;
  for (const line of USAGE) write(line);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    usage(false);
    return 0;
  }
  if (args[0] === 'migrate' && args.includes('--status')) {
    return runStatus();
  }
  if (args[0] === 'storage' && args[1] === 'migrate-to-inline') {
    return runStorageMigrateToInline();
  }
  if (args[0] === 'storage' && args[1] === 'gc') {
    return runStorageGc();
  }
  if (args[0] === 'reset-password') {
    return runResetPassword(args.slice(1));
  }
  usage();
  return 2;
}

// Skip auto-run when imported by tests; run main() only as the entry module.
if (config.NODE_ENV !== 'test') {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
