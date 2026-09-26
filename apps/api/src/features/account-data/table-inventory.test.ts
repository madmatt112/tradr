import { is, getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';

import { EXPORTED_TABLES, EXCLUDED_TABLES } from './table-inventory';

// Req 2.4: a table that the schema barrel defines must be classified in exactly
// one of the two lists. This walks every export of `@/db/schema`, keeps the
// values that are `PgTable` instances, and checks each SQL table name against
// the inventory — so adding a table without deciding its archive fate reds here.
const barrelTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table));

describe('account-data table inventory', () => {
  it('classifies every schema-barrel table in exactly one list', () => {
    const exported = new Set<string>(EXPORTED_TABLES);
    const excluded = new Set<string>(EXCLUDED_TABLES);

    for (const name of barrelTables) {
      const inExported = exported.has(name);
      const inExcluded = excluded.has(name);
      // Exactly one list, never both, never neither.
      expect(inExported !== inExcluded, `table "${name}" must be in exactly one list`).toBe(true);
    }
  });

  it('lists no table the barrel does not define', () => {
    const defined = new Set(barrelTables);
    for (const name of [...EXPORTED_TABLES, ...EXCLUDED_TABLES]) {
      expect(defined.has(name), `inventory names "${name}" but the barrel has no such table`).toBe(
        true,
      );
    }
  });

  it('has no duplicate or overlapping entries', () => {
    const all = [...EXPORTED_TABLES, ...EXCLUDED_TABLES];
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers every barrel table (count parity)', () => {
    expect(EXPORTED_TABLES.length + EXCLUDED_TABLES.length).toBe(barrelTables.length);
  });
});
