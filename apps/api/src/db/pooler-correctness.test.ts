/**
 * Pooler-correctness unit tests (Task 18, REQ-9).
 *
 * Pure tests for the three decision helpers — no DB, no mock, no env
 * manipulation: each takes explicit config values so the routing, the fail-loud
 * guard, and the conditional `prepare:false` are asserted directly.
 *   - `resolveMigrationUrl`  — migration connection routing + fail-loud guard
 *   - `poolerDriverOptions`  — app-pool `prepare:false` only when the flag is on
 *   - `statusConnectionArgs` — `tradr migrate --status` pooler-safe routing
 *
 * Plus a driver-level check that the constructed `postgres` client reflects the
 * gate at `sql.options.prepare` (the key must be OMITTED — not `undefined` —
 * when the flag is off, so postgres.js keeps prepared statements on).
 */
import postgres from 'postgres';
import { describe, it, expect } from 'vitest';

import { statusConnectionArgs } from '@/cli/tradr';
import { poolerDriverOptions } from '@/db';
import { resolveMigrationUrl } from '@/db/migrate';

const DIRECT = 'postgresql://direct/db';
const POOLED = 'postgresql://pooled/db';

describe('resolveMigrationUrl — migration routing (REQ-9.1/9.3)', () => {
  it('uses DIRECT_DATABASE_URL when it is set', () => {
    expect(resolveMigrationUrl(DIRECT, POOLED, false)).toBe(DIRECT);
    expect(resolveMigrationUrl(DIRECT, POOLED, true)).toBe(DIRECT);
  });

  it("falls back to DATABASE_URL when DIRECT is unset (today's behavior)", () => {
    expect(resolveMigrationUrl(undefined, POOLED, false)).toBe(POOLED);
  });
});

describe('resolveMigrationUrl — fail-loud guard (REQ-9.5)', () => {
  it('throws when DB_TRANSACTION_POOLER=true and DIRECT is unset', () => {
    expect(() => resolveMigrationUrl(undefined, POOLED, true)).toThrow(/DIRECT_DATABASE_URL/);
  });

  it('does NOT throw when both are unset (self-host parity, REQ-1.2/9.3)', () => {
    expect(() => resolveMigrationUrl(undefined, POOLED, false)).not.toThrow();
  });

  it('does NOT throw when pooler=true and DIRECT is set', () => {
    expect(() => resolveMigrationUrl(DIRECT, POOLED, true)).not.toThrow();
  });
});

describe('poolerDriverOptions — app-pool prepare gate (REQ-9.2)', () => {
  it("omits the prepare key entirely when DB_TRANSACTION_POOLER is off — today's behavior", () => {
    expect(poolerDriverOptions(false)).toEqual({});
    expect('prepare' in poolerDriverOptions(false)).toBe(false);
  });

  it('sets prepare:false ONLY when DB_TRANSACTION_POOLER is on', () => {
    expect(poolerDriverOptions(true)).toEqual({ prepare: false });
  });
});

describe('app-pool driver prepare mode (REQ-9.2/1.2, driver-level)', () => {
  const URL = 'postgresql://user:pass@localhost:5432/db';

  it('flag OFF ⇒ sql.options.prepare === true (key omitted ⇒ prepared statements ON, matching today)', async () => {
    const sql = postgres(URL, { max: 10, ...poolerDriverOptions(false) });
    try {
      expect(sql.options.prepare).toBe(true);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it('flag ON ⇒ sql.options.prepare === false (prepared statements disabled for a transaction pooler)', async () => {
    const sql = postgres(URL, { max: 10, ...poolerDriverOptions(true) });
    try {
      expect(sql.options.prepare).toBe(false);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});

describe('statusConnectionArgs — pooler-safe `tradr migrate --status` (SF-5)', () => {
  it('routes over DIRECT when set, DATABASE_URL when unset', () => {
    expect(statusConnectionArgs(DIRECT, POOLED).url).toBe(DIRECT);
    expect(statusConnectionArgs(undefined, POOLED).url).toBe(POOLED);
  });

  it('always applies prepare:false so the read is pooler-safe', () => {
    expect(statusConnectionArgs(DIRECT, POOLED).prepare).toBe(false);
    expect(statusConnectionArgs(undefined, POOLED).prepare).toBe(false);
  });
});
