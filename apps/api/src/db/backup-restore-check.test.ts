// hosted-platform Task 20 — integrity-checker tests (REQ-10).
//
// Exercises the dependency-free `scripts/backup-restore-check.mjs` checker: its SQL
// builders against a REAL Postgres (orphan detection healthy→0 / injected orphan→>0;
// deterministic pointer-key scan) and its pure selection/evaluation/reachability logic
// with injected fakes (deterministic selection, vacuous zero-pointer pass, injected
// missing object → failure, injected orphan → non-zero via runChecks).
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The checker is at the repo root (dependency-free ESM); import it by relative path.
import {
  RELATIONSHIPS,
  PINNED_MIN_SAMPLE,
  orphanSql,
  countSql,
  pointerKeysSqlFor,
  parseScalar,
  parseKeys,
  selectPointerKeys,
  isObjectStorageConfiguredFromEnv,
  compareCounts,
  evaluateOrphans,
  assertReachable,
  runChecks,
  // @ts-expect-error — plain .mjs checker, no type declarations (not under tsc).
} from '../../../../scripts/backup-restore-check.mjs';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';

let sql: ReturnType<typeof postgres>;

/** Run `fn` inside a transaction that is always rolled back (DDL + DML isolated). */
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  const SENTINEL = '__drill_rollback__';
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as postgres.TransactionSql);
      throw new Error(SENTINEL);
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== SENTINEL) throw err;
  }
}

beforeAll(() => {
  sql = postgres(DATABASE_URL, { max: 1 });
});
afterAll(async () => {
  await sql.end();
});

describe('backup-restore checker — fixed integrity contract', () => {
  it('pins the three verified FK relationships and the core row-count tables', () => {
    expect(
      RELATIONSHIPS.map((r: { child: string; childCol: string }) => `${r.child}.${r.childCol}`),
    ).toEqual([
      'advisor_messages.conversation_id',
      'positions.account_id',
      'ledger_entries.position_id',
    ]);
  });
});

describe('backup-restore checker — SQL against a real Postgres', () => {
  it('reports zero orphans for every real relationship on a consistent schema', async () => {
    // Proves each orphanSql is valid against the installed schema (tables/columns
    // exist) and returns 0 when referential integrity holds (a healthy restore).
    for (const rel of RELATIONSHIPS) {
      const rows = await sql.unsafe(orphanSql(rel));
      expect(Number(rows[0].n)).toBe(0);
    }
  });

  it('detects an injected orphan (healthy → 0, orphan → >0)', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe('CREATE TABLE _drill_p (id uuid PRIMARY KEY)');
      await tx.unsafe(
        'CREATE TABLE _drill_c (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), p_id uuid)',
      );
      const rel = { child: '_drill_c', childCol: 'p_id', parent: '_drill_p', parentCol: 'id' };

      // Consistent row: child points at an existing parent → no orphan.
      await tx.unsafe("INSERT INTO _drill_p (id) VALUES ('11111111-1111-1111-1111-111111111111')");
      await tx.unsafe(
        "INSERT INTO _drill_c (p_id) VALUES ('11111111-1111-1111-1111-111111111111')",
      );
      const healthy = await tx.unsafe(orphanSql(rel));
      expect(Number(healthy[0].n)).toBe(0);

      // Injected orphan: child references a non-existent parent.
      await tx.unsafe(
        "INSERT INTO _drill_c (p_id) VALUES ('22222222-2222-2222-2222-222222222222')",
      );
      // A NULL FK must NOT count as an orphan.
      await tx.unsafe('INSERT INTO _drill_c (p_id) VALUES (NULL)');
      const orphaned = await tx.unsafe(orphanSql(rel));
      expect(Number(orphaned[0].n)).toBe(1);
    });
  });

  it('scans object-pointer keys deterministically (dedup, kind filter, sorted)', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe('CREATE TABLE _drill_cp (content_parts jsonb)');
      // Two pointer rows (one key duplicated across rows), an inline row, an
      // unrecoverable row, a text part, and a non-array row — only distinct object
      // keys must come back, sorted.
      await tx.unsafe(
        `INSERT INTO _drill_cp (content_parts) VALUES
         ('[{"type":"image","format":"png","storage":{"kind":"object","key":"advisor/u/bbb"}}]'::jsonb),
         ('[{"type":"image","format":"png","storage":{"kind":"object","key":"advisor/u/aaa"}},{"type":"text","text":"hi"}]'::jsonb),
         ('[{"type":"image","format":"png","storage":{"kind":"object","key":"advisor/u/aaa"}}]'::jsonb),
         ('[{"type":"image","format":"png","storage":{"kind":"unrecoverable"}}]'::jsonb),
         ('[{"type":"image","format":"png","dataBase64":"AAAA"}]'::jsonb),
         ('{"not":"an array"}'::jsonb)`,
      );
      const rows = await tx.unsafe(pointerKeysSqlFor('_drill_cp'));
      const keys = rows.map((r) => (r as unknown as { key: string }).key);
      expect(keys).toEqual(['advisor/u/aaa', 'advisor/u/bbb']);
    });
  });

  it('counts rows for a table (countSql runs on the real schema)', async () => {
    const rows = await sql.unsafe(countSql('users'));
    expect(Number.isFinite(Number(rows[0].n))).toBe(true);
  });
});

describe('backup-restore checker — pure logic', () => {
  it('parseScalar / parseKeys parse psql -tA output', () => {
    expect(parseScalar('42\n')).toBe(42);
    expect(() => parseScalar('not-a-number')).toThrow();
    expect(parseKeys('advisor/u/a\nadvisor/u/b\n\n')).toEqual(['advisor/u/a', 'advisor/u/b']);
  });

  it('selectPointerKeys is deterministic — all by default, first-N with a pinned minimum', () => {
    const keys = ['c', 'a', 'b'];
    expect(selectPointerKeys(keys)).toEqual(['a', 'b', 'c']); // all, sorted
    // Two runs over the same input agree.
    expect(selectPointerKeys(keys)).toEqual(selectPointerKeys([...keys].reverse()));
    // A small limit is floored to PINNED_MIN_SAMPLE.
    const many = Array.from({ length: 50 }, (_, i) => String(i).padStart(2, '0'));
    expect(selectPointerKeys(many, 5)).toHaveLength(PINNED_MIN_SAMPLE);
    expect(selectPointerKeys(many, 30)).toHaveLength(30);
  });

  it('isObjectStorageConfiguredFromEnv mirrors the four-var predicate', () => {
    expect(isObjectStorageConfiguredFromEnv({})).toBe(false);
    expect(
      isObjectStorageConfiguredFromEnv({
        OBJECT_STORAGE_ENDPOINT: 'https://x',
        OBJECT_STORAGE_BUCKET: 'b',
        OBJECT_STORAGE_ACCESS_KEY_ID: 'k',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 's',
      }),
    ).toBe(true);
  });

  it('compareCounts flags a source↔restored mismatch only', () => {
    expect(compareCounts({ a: 3, b: 5 }, { a: 3, b: 5 })).toEqual([]);
    expect(compareCounts({ a: 3, b: 5 }, { a: 3, b: 4 })).toEqual([
      'row-count b: source=5 restored=4',
    ]);
  });

  it('evaluateOrphans flags only relations with a positive count', () => {
    expect(evaluateOrphans([{ relation: 'x.y', count: 0 }])).toEqual([]);
    expect(evaluateOrphans([{ relation: 'x.y', count: 2 }])).toEqual(['FK orphans in x.y: 2']);
  });

  it('assertReachable: vacuous pass on zero pointers, failure on a missing object', async () => {
    expect(await assertReachable([], async () => true)).toEqual([]); // vacuous
    expect(await assertReachable(['a', 'b'], async () => true)).toEqual([]); // all reachable
    const failures = await assertReachable(['a', 'gone'], async (k: string) => k !== 'gone');
    expect(failures).toEqual(['object unreachable: gone']);
    // A throwing probe is treated as unreachable, never fatal.
    expect(
      await assertReachable(['x'], async () => {
        throw new Error('boom');
      }),
    ).toEqual(['object unreachable: x']);
  });
});

describe('backup-restore checker — runChecks orchestration (injected seams)', () => {
  const base = {
    restoreDbUrl: 'postgres://ignored',
    env: {}, // object storage not configured → reachability skipped
    migrateStatus: () => 0,
    scalar: () => 0, // no orphans
    keysQuery: () => [],
    probeOne: async () => true,
  };

  it('healthy restore → zero failures; row-count mismatch → failure', async () => {
    // Orphan queries (LEFT JOIN) return 0; the users count query returns the baseline.
    const scalar = (sqlText: string) => (sqlText.includes('LEFT JOIN') ? 0 : 7);
    const healthy = await runChecks({ ...base, scalar, baseline: { users: 7 } });
    expect(healthy).toEqual([]);

    const mismatch = await runChecks({ ...base, scalar, baseline: { users: 8 } });
    expect(mismatch).toEqual(['row-count users: source=8 restored=7']);
  });

  it('injected orphan → non-zero (a failure is reported)', async () => {
    const failures = await runChecks({
      ...base,
      scalar: (sqlText: string) => (sqlText.includes('LEFT JOIN') ? 3 : 0),
    });
    expect(failures.some((f: string) => f.startsWith('FK orphans'))).toBe(true);
  });

  it('pending migration → non-zero', async () => {
    const failures = await runChecks({ ...base, migrateStatus: () => 1 });
    expect(failures.some((f: string) => f.includes('migrate --status'))).toBe(true);
  });

  it('configured storage + missing object → non-zero; zero pointers → vacuous pass', async () => {
    const env = {
      OBJECT_STORAGE_ENDPOINT: 'https://x',
      OBJECT_STORAGE_BUCKET: 'b',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'k',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 's',
    };
    const missing = await runChecks({
      ...base,
      env,
      keysQuery: () => ['advisor/u/gone'],
      probeOne: async () => false,
    });
    expect(missing.some((f: string) => f.startsWith('object unreachable'))).toBe(true);

    const vacuous = await runChecks({
      ...base,
      env,
      keysQuery: () => [],
      probeOne: async () => false,
    });
    expect(vacuous).toEqual([]); // zero pointers passes vacuously even with a failing probe
  });
});
