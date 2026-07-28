#!/usr/bin/env node
// hosted-platform Task 20 — backup → restore → integrity checker (REQ-10).
//
// Binary pass/fail integrity assertions run against a RESTORED (staging) database
// (REQ-10.1/10.2). Invoked by `scripts/backup-restore-drill.sh` after it restores a
// `pg_dump` into a fresh staging instance; also runnable standalone against any
// already-restored staging DB. Exits 0 when the restore is healthy, non-zero on a
// pending migration, an FK orphan, a row-count mismatch, or an unreachable object.
//
// Assertions:
//   (a) `tradr migrate --status` (the pooler-safe Task-18 status) reports NO pending
//       migrations on the restored DB (REQ-10.2a).
//   (b) A FIXED set of FK-orphan checks (advisor_messages.conversation_id,
//       positions.account_id, ledger_entries.position_id) find zero orphans, plus a
//       seeded row-count check: every core table's restored count equals the source
//       baseline captured before the dump (REQ-10.2b).
//   (c) OBJECT REACHABILITY (REQ-10.3): when object storage is configured, every
//       object referenced by a DETERMINISTICALLY selected set of restored pointer
//       rows (all rows, or the first-N-by-key with a pinned minimum) is reachable via
//       the Task-5 adapter (`getObjectStorage().get(key)`). A zero-pointer DB passes
//       VACUOUSLY. Selection is deterministic so two runs agree.
//
// DB ⇄ BUCKET BACKUP-CONSISTENCY BOUNDARY (REQ-10.4): a `pg_dump` captures the advisor
// image POINTER ROWS but NOT the bucket objects they reference. Object storage is an
// external store; backing it up (and keeping it consistent with the DB pointers) is a
// SEPARATE backup concern — operator/provider posture documented in the hosting
// runbook (REQ-11.1), not something this DB drill provides. The reachability check (c)
// only detects wholesale image loss AT DRILL TIME against the live bucket; it is NOT a
// point-in-time DB+bucket consistency guarantee.
//
// This checker is intentionally dependency-free (Node builtins only) so it runs from
// the repo root without workspace module resolution. All DB reads go through `psql`
// (the drill already depends on the Postgres client tools); `tradr` and the
// object-storage adapter are invoked through the `@tradr/api` workspace.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_MODULE = resolve(REPO_ROOT, 'apps/api/src/lib/object-storage/index.ts');

// --- Fixed integrity contract -----------------------------------------------

/**
 * The FIXED FK-orphan relationships (REQ-10.2b). Each is a child column that must
 * reference an existing parent row. Verified against the installed schema:
 *   advisor_messages.conversation_id → advisor_conversations.id (NOT NULL, advisor.schema.ts:63)
 *   positions.account_id             → accounts.id             (NOT NULL, positions.schema.ts:23)
 *   ledger_entries.position_id       → positions.id            (NULLABLE set-null, accounting.schema.ts:28)
 * The `IS NOT NULL` child guard makes the check correct for the nullable FK too.
 * @typedef {{ child: string, childCol: string, parent: string, parentCol: string }} Relationship
 * @type {Relationship[]}
 */
export const RELATIONSHIPS = [
  {
    child: 'advisor_messages',
    childCol: 'conversation_id',
    parent: 'advisor_conversations',
    parentCol: 'id',
  },
  { child: 'positions', childCol: 'account_id', parent: 'accounts', parentCol: 'id' },
  { child: 'ledger_entries', childCol: 'position_id', parent: 'positions', parentCol: 'id' },
];

/**
 * The FIXED core tables whose restored row counts must equal the source baseline
 * (REQ-10.2b — the "seeded row-count" check). The drill captures each table's count
 * from the source before dumping; a restore that dropped or duplicated rows fails.
 */
export const CORE_TABLES = [
  'users',
  'accounts',
  'positions',
  'fills',
  'ledger_entries',
  'advisor_conversations',
  'advisor_messages',
];

/**
 * Minimum number of pointer rows the deterministic sample must cover when a first-N
 * limit is requested (REQ-10.3 "pinned minimum"). With more pointers than the limit
 * the sample is still at least this many; with fewer, every pointer is checked.
 */
export const PINNED_MIN_SAMPLE = 20;

// --- Pure SQL builders (tested against a real Postgres) ---------------------

/** Orphan-count SQL for one relationship: rows whose non-null FK has no parent. */
export function orphanSql(rel) {
  return (
    `SELECT count(*)::int AS n FROM ${rel.child} c ` +
    `LEFT JOIN ${rel.parent} p ON c.${rel.childCol} = p.${rel.parentCol} ` +
    `WHERE c.${rel.childCol} IS NOT NULL AND p.${rel.parentCol} IS NULL`
  );
}

/** Row-count SQL for one table. */
export function countSql(table) {
  return `SELECT count(*)::int AS n FROM ${table}`;
}

/**
 * Distinct object-pointer keys from `<table>.content_parts`, in a DETERMINISTIC key
 * order (REQ-10.3). Mirrors the Task-13 gc live-key scan. `jsonb_typeof = 'array'`
 * guards any non-array row; the pointer marker is `{ storage: { kind: 'object', key } }`.
 */
export function pointerKeysSqlFor(table) {
  return (
    `SELECT DISTINCT part->'storage'->>'key' AS key ` +
    `FROM ${table}, jsonb_array_elements(content_parts) AS part ` +
    `WHERE jsonb_typeof(content_parts) = 'array' ` +
    `AND part->'storage'->>'kind' = 'object' AND part->'storage'->>'key' IS NOT NULL ` +
    `ORDER BY key`
  );
}

/** The pointer-key scan over the real `advisor_messages` table. */
export function pointerKeysSql() {
  return pointerKeysSqlFor('advisor_messages');
}

// --- Pure logic (tested with injected fakes) --------------------------------

/** Parse a `psql -tA` scalar (one value, one line) to an integer. */
export function parseScalar(stdout) {
  const line = String(stdout).trim().split('\n')[0] ?? '';
  const n = Number.parseInt(line, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected an integer from psql, got: ${JSON.stringify(line)}`);
  return n;
}

/** Parse a `psql -tA` single-column result into a trimmed, non-empty string array. */
export function parseKeys(stdout) {
  return String(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * DETERMINISTIC pointer-row selection (REQ-10.3). `keys` arrives already sorted by key
 * from `pointerKeysSql`. `limit <= 0` (the default) selects ALL keys; a positive limit
 * selects the first `max(limit, PINNED_MIN_SAMPLE)` by key. Two runs over the same DB
 * therefore agree.
 */
export function selectPointerKeys(keys, limit = 0) {
  const sorted = [...keys].sort();
  if (!limit || limit <= 0) return sorted;
  return sorted.slice(0, Math.max(limit, PINNED_MIN_SAMPLE));
}

/** Mirror of `isObjectStorageConfigured()` over a plain env object (no config import). */
export function isObjectStorageConfiguredFromEnv(env) {
  return Boolean(
    env.OBJECT_STORAGE_ENDPOINT &&
      env.OBJECT_STORAGE_BUCKET &&
      env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  );
}

/** Compare a baseline `{table: count}` against restored counts; return failure strings. */
export function compareCounts(baseline, actual) {
  const failures = [];
  for (const table of Object.keys(baseline)) {
    const want = baseline[table];
    const got = actual[table];
    if (got !== want) failures.push(`row-count ${table}: source=${want} restored=${got}`);
  }
  return failures;
}

/** Turn orphan results (`{relation, count}[]`) into failure strings. */
export function evaluateOrphans(results) {
  return results
    .filter((r) => r.count > 0)
    .map((r) => `FK orphans in ${r.relation}: ${r.count}`);
}

/**
 * Assert every selected object is reachable via the injected `probeOne(key) → Promise`
 * (resolves reachable, rejects/false unreachable). Empty `keys` passes VACUOUSLY
 * (REQ-10.3). Returns failure strings.
 */
export async function assertReachable(keys, probeOne) {
  const failures = [];
  for (const key of keys) {
    let ok = false;
    try {
      ok = (await probeOne(key)) !== false;
    } catch {
      ok = false;
    }
    if (!ok) failures.push(`object unreachable: ${key}`);
  }
  return failures;
}

// --- IO (real implementations used by main) ---------------------------------

/** Run one `psql -tA` query against `dbUrl`, returning trimmed stdout (throws on error). */
function psqlScalar(dbUrl, sqlText) {
  const res = spawnSync('psql', [dbUrl, '-tAX', '-c', sqlText], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`psql failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** Run `tradr migrate --status` against the restored DB; return its exit code. */
function migrateStatusExitCode(restoreDbUrl) {
  const res = spawnSync(
    'pnpm',
    ['--filter', '@tradr/api', 'exec', 'tsx', 'src/cli/tradr.ts', 'migrate', '--status'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'inherit', 'inherit'],
      // Point the pooler-safe status reader at the restored DB; clear DIRECT so it
      // uses DATABASE_URL (statusConnectionArgs prefers DIRECT when set).
      env: { ...process.env, DATABASE_URL: restoreDbUrl, DIRECT_DATABASE_URL: '' },
    },
  );
  return res.status ?? 1;
}

/** Real object-reachability probe: `getObjectStorage().get(key)` via the Task-5 adapter. */
function makeAdapterProbe() {
  const evalScript =
    'const m = await import(process.env.__PROBE_MODULE);' +
    'const s = m.getObjectStorage();' +
    'if (!s) { process.exit(0); }' +
    'await s.get(process.env.__PROBE_KEY);';
  return (key) =>
    new Promise((resolveProbe) => {
      const res = spawnSync('pnpm', ['--filter', '@tradr/api', 'exec', 'tsx', '-e', evalScript], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, __PROBE_MODULE: ADAPTER_MODULE, __PROBE_KEY: key },
      });
      resolveProbe(res.status === 0);
    });
}

/** Run every assertion against the restored DB. Returns the collected failure strings. */
export async function runChecks(opts) {
  const {
    restoreDbUrl,
    baseline = null,
    env = process.env,
    pointerLimit = 0,
    // Injectable seams (real by default; overridden in tests).
    scalar = (sqlText) => parseScalar(psqlScalar(restoreDbUrl, sqlText)),
    keysQuery = () => parseKeys(psqlScalar(restoreDbUrl, pointerKeysSql())),
    migrateStatus = () => migrateStatusExitCode(restoreDbUrl),
    probeOne = makeAdapterProbe(),
  } = opts;

  const failures = [];

  // (a) migration status
  const statusCode = migrateStatus();
  if (statusCode !== 0) failures.push(`tradr migrate --status reported pending/unavailable (exit ${statusCode})`);

  // (b) FK orphans
  const orphanResults = RELATIONSHIPS.map((rel) => ({
    relation: `${rel.child}.${rel.childCol}`,
    count: scalar(orphanSql(rel)),
  }));
  failures.push(...evaluateOrphans(orphanResults));

  // (b) seeded row counts vs source baseline
  if (baseline) {
    const actual = {};
    for (const table of Object.keys(baseline)) actual[table] = scalar(countSql(table));
    failures.push(...compareCounts(baseline, actual));
  } else {
    console.warn('row-count check skipped: no baseline provided (BASELINE_COUNTS unset).');
  }

  // (c) object reachability (only when configured; zero pointers passes vacuously)
  if (isObjectStorageConfiguredFromEnv(env)) {
    const selected = selectPointerKeys(keysQuery(), pointerLimit);
    failures.push(...(await assertReachable(selected, probeOne)));
    console.log(`object reachability: checked ${selected.length} pointer object(s).`);
  } else {
    console.log('object reachability: skipped (object storage not configured).');
  }

  return failures;
}

// --- Entry point ------------------------------------------------------------

async function main() {
  const restoreDbUrl = process.env.RESTORE_DATABASE_URL;
  if (!restoreDbUrl) {
    console.error('RESTORE_DATABASE_URL is required (the restored STAGING database to check).');
    return 2;
  }
  let baseline = null;
  if (process.env.BASELINE_COUNTS) {
    baseline = JSON.parse(readFileSync(process.env.BASELINE_COUNTS, 'utf8'));
  }
  const pointerLimit = Number.parseInt(process.env.POINTER_SAMPLE_LIMIT ?? '0', 10) || 0;

  const failures = await runChecks({ restoreDbUrl, baseline, pointerLimit });

  if (failures.length > 0) {
    console.error('\nBACKUP-RESTORE INTEGRITY: FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log('\nBACKUP-RESTORE INTEGRITY: PASS');
  return 0;
}

// Run only as the entry module; importing for tests has no side effect.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    });
}
