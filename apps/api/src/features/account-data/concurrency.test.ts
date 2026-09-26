import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { zipSync } from 'fflate';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArchiveCounts } from '@tradr/shared';

import type { Database } from '@/db';
import * as dbModule from '@/db';
import * as schema from '@/db/schema';
import { accounts, users } from '@/db/schema';

import { ImportBusyError, ImportTargetNotEmptyError } from './account-data.errors';
import { confirmImport } from './import.service';

// Req 5.3 — two confirms for one committed user, exactly one restores. The guard
// is the import slot plus the in-transaction emptiness re-check: the loser reaches
// its restore transaction, re-checks Req 5.1 after the winner committed and is
// refused (409), or is refused as busy (503) if its lock wait expired. Either
// way it writes nothing.
//
// The single-connection rollback harness turns "concurrent" calls into savepoints
// on one connection where no lock can contend and no row is ever truly committed,
// so this race runs against COMMITTED rows over a dedicated two-connection pool,
// per the email-tokens / accounts concurrency precedent — `dbModule.db` is
// re-pointed at that pool for the duration and restored in `finally`, and every
// committed row is deleted before the test ends.

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';

const TS = '2026-01-02T03:04:05.123456Z';

let dedicatedSql: ReturnType<typeof postgres>;
let dedicatedDb: Database;

beforeAll(() => {
  // max: 2 — one connection per racer; the harness's beforeAll has already
  // migrated the schema on its own connection.
  dedicatedSql = postgres(DATABASE_URL, { max: 2 });
  dedicatedDb = drizzle(dedicatedSql, { schema });
});

afterAll(async () => {
  await dedicatedSql.end();
});

// A minimal but valid single-account archive (one default account), enough to
// trigger the emptiness re-check when a second confirm runs after the first.
function makeArchive(): Uint8Array {
  const counts: ArchiveCounts = {
    brokerages: 0,
    systemBrokerages: 0,
    accounts: 1,
    tags: 0,
    positions: 0,
    fills: 0,
    positionTags: 0,
    positionImages: 0,
    ledgerEntries: 0,
    exchangeRates: 0,
    expenses: 0,
    personas: 0,
    builtinPersonas: 0,
    conversations: 0,
    messages: 0,
    summaries: 0,
    images: 0,
  };
  const manifest = {
    format: 'tradr-account-archive',
    archiveVersion: 1,
    sourceAppVersion: '1.2.3',
    exportedAt: TS,
    counts,
    degradations: [],
  };
  const account = {
    id: randomUUID(),
    name: 'Main',
    currency: 'USD',
    timezone: 'America/New_York',
    brokerage: null,
    startingBalance: '1000.0000',
    defaultRiskPercent: null,
    isDemo: false,
    isDefault: true,
    createdAt: TS,
    updatedAt: TS,
  };
  const prefs = {
    displayCurrency: null,
    timezone: null,
    taxJurisdiction: null,
    theme: 'system',
    buyingPowerBasis: 'cash',
    advisorDefaultPersona: null,
    advisorTradeDataConsent: false,
    writableAccountId: null,
    onboarding: {},
  };
  const enc = new TextEncoder();
  const empty = enc.encode('');
  const files: Record<string, Uint8Array> = {
    'manifest.json': enc.encode(JSON.stringify(manifest)),
    'brokerages.ndjson': empty,
    'system-brokerages.ndjson': empty,
    'accounts.ndjson': enc.encode(`${JSON.stringify(account)}\n`),
    'tags.ndjson': empty,
    'positions.ndjson': empty,
    'fills.ndjson': empty,
    'position-tags.ndjson': empty,
    'position-images.ndjson': empty,
    'ledger-entries.ndjson': empty,
    'exchange-rates.ndjson': empty,
    'expenses.ndjson': empty,
    'personas.ndjson': empty,
    'builtin-personas.ndjson': empty,
    'conversations.ndjson': empty,
    'messages.ndjson': empty,
    'summaries.ndjson': empty,
    'preferences.json': enc.encode(JSON.stringify(prefs)),
    'dashboard-layout.json': enc.encode(JSON.stringify(null)),
  };
  return zipSync(files, { level: 0 });
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('confirmImport concurrency (Req 5.3)', () => {
  it('lets exactly one of two concurrent confirms restore; the other is refused and writes nothing', async () => {
    const [u] = await dedicatedDb
      .insert(users)
      .values({ email: `import-race-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
      .returning({ id: users.id });
    const userId = u.id;

    const bytes = makeArchive();
    const digest = createHash('sha256').update(bytes).digest('hex');

    const harnessDb = dbModule.db;
    (dbModule as Record<string, unknown>).db = dedicatedDb;
    try {
      const settled = await Promise.allSettled([
        confirmImport(userId, streamOf(bytes), digest),
        confirmImport(userId, streamOf(bytes), digest),
      ]);

      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser is refused as target-not-empty (409) or busy (503); never a raw error.
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err instanceof ImportTargetNotEmptyError || err instanceof ImportBusyError).toBe(true);
      expect([409, 503]).toContain((err as { statusCode: number }).statusCode);

      // Exactly one restore committed: one account, not two.
      const rows = await dedicatedDb.select().from(accounts).where(eq(accounts.userId, userId));
      expect(rows).toHaveLength(1);
    } finally {
      (dbModule as Record<string, unknown>).db = harnessDb;
      await dedicatedDb.delete(accounts).where(eq(accounts.userId, userId));
      await dedicatedDb.delete(users).where(eq(users.id, userId));
    }
  });
});
