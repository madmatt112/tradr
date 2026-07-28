/**
 * Unit tests for the pure CLI helpers in `tradr.ts` (no DB / no IO).
 *
 * Covers: standard-track diff (drizzle timestamp semantics), post-track diff
 * (by filename), the `pg_locks` split-key decode builder, and exit-code
 * selection. The real-Postgres behaviours (read-only never-migrated, migrated
 * exit 0, SKIP_POST_MIGRATIONS, cross-session lock detection) live in
 * `tradr.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import {
  diffStandard,
  diffPost,
  decodeLockKey,
  selectExitCode,
  parseResetPasswordArgs,
  generatePassword,
  type JournalEntry,
} from './tradr';

describe('diffStandard', () => {
  const entries: JournalEntry[] = [
    { idx: 0, when: 100, tag: '0000_a' },
    { idx: 1, when: 200, tag: '0001_b' },
    { idx: 2, when: 300, tag: '0002_c' },
  ];

  it('reports all entries pending when the table does not exist', () => {
    const result = diffStandard(entries, null, false);
    expect(result).toEqual({
      applied: 0,
      pending: ['0000_a', '0001_b', '0002_c'],
      tableExists: false,
    });
  });

  it('reports all entries pending when the table exists but is empty (maxCreatedAt null)', () => {
    const result = diffStandard(entries, null, true);
    expect(result.applied).toBe(0);
    expect(result.pending).toEqual(['0000_a', '0001_b', '0002_c']);
    expect(result.tableExists).toBe(true);
  });

  it('treats entries with when > maxCreatedAt as pending (folderMillis semantics)', () => {
    const result = diffStandard(entries, 200, true);
    expect(result.applied).toBe(2);
    expect(result.pending).toEqual(['0002_c']);
  });

  it('reports no pending when maxCreatedAt covers the latest entry', () => {
    const result = diffStandard(entries, 300, true);
    expect(result.applied).toBe(3);
    expect(result.pending).toEqual([]);
  });

  it('uses strict > (an entry equal to maxCreatedAt is applied, not pending)', () => {
    const result = diffStandard(entries, 200, true);
    expect(result.pending).not.toContain('0001_b');
  });

  it('orders pending output by folderMillis regardless of input order', () => {
    const shuffled: JournalEntry[] = [
      { idx: 2, when: 300, tag: '0002_c' },
      { idx: 0, when: 100, tag: '0000_a' },
      { idx: 1, when: 200, tag: '0001_b' },
    ];
    const result = diffStandard(shuffled, null, false);
    expect(result.pending).toEqual(['0000_a', '0001_b', '0002_c']);
  });
});

describe('diffPost', () => {
  it('reports all on-disk .sql files pending when the table does not exist', () => {
    const result = diffPost(['0001_x.sql', '0002_y.sql'], [], false);
    expect(result).toEqual({
      applied: 0,
      pending: ['0001_x.sql', '0002_y.sql'],
      tableExists: false,
    });
  });

  it('reports pending = on-disk minus applied filenames', () => {
    const result = diffPost(['0001_x.sql', '0002_y.sql'], ['0001_x.sql'], true);
    expect(result.applied).toBe(1);
    expect(result.pending).toEqual(['0002_y.sql']);
  });

  it('reports none pending when all on-disk files are applied', () => {
    const result = diffPost(['0001_x.sql'], ['0001_x.sql'], true);
    expect(result.applied).toBe(1);
    expect(result.pending).toEqual([]);
  });

  it('ignores non-.sql files on disk', () => {
    const result = diffPost(['0001_x.sql', 'README.md', '.keep'], [], true);
    expect(result.pending).toEqual(['0001_x.sql']);
  });

  it('sorts pending output lexicographically', () => {
    const result = diffPost(['0002_y.sql', '0001_x.sql'], [], false);
    expect(result.pending).toEqual(['0001_x.sql', '0002_y.sql']);
  });
});

describe('decodeLockKey', () => {
  it('splits the migrations key 7064001 into classid=0, objid=7064001, objsubid=1', () => {
    expect(decodeLockKey(7064001n)).toEqual({ classid: 0, objid: 7064001, objsubid: 1 });
  });

  it('splits the post-migrations key 7064002 into classid=0, objid=7064002, objsubid=1', () => {
    expect(decodeLockKey(7064002n)).toEqual({ classid: 0, objid: 7064002, objsubid: 1 });
  });

  it('splits a key that uses the high 32 bits across classid and objid', () => {
    // (1 << 32) | 5 => classid=1, objid=5
    expect(decodeLockKey((1n << 32n) | 5n)).toEqual({ classid: 1, objid: 5, objsubid: 1 });
  });

  it('masks objid to the low 32 bits', () => {
    expect(decodeLockKey(0xffffffffn)).toEqual({
      classid: 0,
      objid: 0xffffffff,
      objsubid: 1,
    });
  });
});

describe('selectExitCode', () => {
  const clean = { applied: 1, pending: [], tableExists: true };

  it('returns 0 when neither track has pending migrations', () => {
    expect(selectExitCode(clean, clean)).toBe(0);
  });

  it('returns 1 when the standard track has pending migrations', () => {
    expect(selectExitCode({ ...clean, pending: ['0001_b'] }, clean)).toBe(1);
  });

  it('returns 1 when the post track has pending migrations', () => {
    expect(selectExitCode(clean, { ...clean, pending: ['0002_y.sql'] })).toBe(1);
  });

  it('returns 1 when both tracks have pending migrations', () => {
    expect(
      selectExitCode({ ...clean, pending: ['0001_b'] }, { ...clean, pending: ['0002_y.sql'] }),
    ).toBe(1);
  });
});

describe('parseResetPasswordArgs', () => {
  it('parses a bare email with no password (generate path)', () => {
    expect(parseResetPasswordArgs(['user@example.com'])).toEqual({ email: 'user@example.com' });
  });

  it('parses --password <value>', () => {
    expect(parseResetPasswordArgs(['user@example.com', '--password', 'secret123'])).toEqual({
      email: 'user@example.com',
      password: 'secret123',
    });
  });

  it('parses --password=<value>', () => {
    expect(parseResetPasswordArgs(['user@example.com', '--password=secret123'])).toEqual({
      email: 'user@example.com',
      password: 'secret123',
    });
  });

  it('errors when no email is supplied', () => {
    expect(parseResetPasswordArgs([]).error).toBeDefined();
    expect(parseResetPasswordArgs(['--password', 'x']).error).toBeDefined();
  });

  it('errors when --password has no value', () => {
    expect(parseResetPasswordArgs(['user@example.com', '--password']).error).toBeDefined();
  });
});

describe('generatePassword', () => {
  it('returns a non-empty url-safe string and differs each call', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});
