import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { zipSync } from 'fflate';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArchiveCounts } from '@tradr/shared';

import type { Database } from '@/db';
import { db } from '@/db';
import * as dbModule from '@/db';
import * as schema from '@/db/schema';
import { accounts, users } from '@/db/schema';

import { ImportCapacityError } from './account-data.errors';
import { confirmImport, previewImport } from './import.service';

// Req 4.1, 4.2 — two confirms for one committed user: the import slot's
// non-queueing admission (design C2) refuses the second at once with 503
// IMPORT_CAPACITY_REACHED, before it ever reaches validation or the restore
// transaction (confirmImport stops using the queueing `acquire`, design C3).
// Exactly one restore commits.
//
// The single-connection rollback harness turns "concurrent" calls into savepoints
// on one connection, so this still runs the winner's restore against COMMITTED
// rows over a dedicated two-connection pool to prove the commit really landed —
// `dbModule.db` is re-pointed at that pool for the duration and restored in
// `finally`, and every committed row is deleted before the test ends.

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

// For the admission tests below, the loser never reaches the database (it is
// refused before `mkdtemp`), so the regular per-test rollback transaction `db`
// is enough — no dedicated committed-rows pool is needed.
async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `import-admit-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return u.id;
}

describe('confirmImport concurrency (Req 4.1, 4.2)', () => {
  it('lets exactly one of two concurrent confirms for the same user restore; the other is refused at once with 503 IMPORT_CAPACITY_REACHED', async () => {
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

      // The loser never reaches validation or the transaction: the import slot's
      // non-queueing admission refuses it at once.
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ImportCapacityError);
      expect((err as { statusCode: number }).statusCode).toBe(503);
      expect((err as { code?: string }).code).toBe('IMPORT_CAPACITY_REACHED');

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

describe('previewImport admission (Req 4.1, 4.2)', () => {
  it('refuses the second of two concurrent previews at once with 503 IMPORT_CAPACITY_REACHED', async () => {
    const userId = await seedUser();

    const settled = await Promise.allSettled([
      previewImport(userId, streamOf(makeArchive())),
      previewImport(userId, streamOf(makeArchive())),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ImportCapacityError);
    expect((err as { statusCode: number }).statusCode).toBe(503);
    expect((err as { code?: string }).code).toBe('IMPORT_CAPACITY_REACHED');
  });
});

describe('confirmImport admission across users (Req 4.1, 4.2)', () => {
  it('refuses a second confirm for a different user while one is admitted; exactly one restore commits', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    const bytes1 = makeArchive();
    const bytes2 = makeArchive();
    const digest1 = createHash('sha256').update(bytes1).digest('hex');
    const digest2 = createHash('sha256').update(bytes2).digest('hex');

    const settled = await Promise.allSettled([
      confirmImport(u1, streamOf(bytes1), digest1),
      confirmImport(u2, streamOf(bytes2), digest2),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ImportCapacityError);
    expect((err as { statusCode: number }).statusCode).toBe(503);

    const rows1 = await db.select().from(accounts).where(eq(accounts.userId, u1));
    const rows2 = await db.select().from(accounts).where(eq(accounts.userId, u2));
    expect(rows1.length + rows2.length).toBe(1);
  });
});

describe('import admission across preview and confirm (Req 4.1, 4.2)', () => {
  it('refuses whichever of a preview and a confirm for the same user arrives second', async () => {
    const userId = await seedUser();
    const bytes = makeArchive();
    const digest = createHash('sha256').update(bytes).digest('hex');

    const settled = await Promise.allSettled([
      previewImport(userId, streamOf(bytes)),
      confirmImport(userId, streamOf(bytes), digest),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ImportCapacityError);
    expect((err as { statusCode: number }).statusCode).toBe(503);
  });
});
