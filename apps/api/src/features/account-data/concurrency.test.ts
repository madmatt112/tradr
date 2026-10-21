import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

import {
  ImportBusyError,
  ImportCapacityError,
  ImportTargetNotEmptyError,
} from './account-data.errors';
import { confirmArchive, confirmImport } from './import.service';

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

// Spooled archive files for the admission-free core race below (design C2's
// confirmArchive takes an already-spooled path, not a body stream).
let coreDir: string;
let coreFileCounter = 0;

beforeAll(async () => {
  coreDir = await mkdtemp(path.join(os.tmpdir(), 'import-concurrency-core-'));
});

async function saveArchive(bytes: Uint8Array): Promise<string> {
  const p = path.join(coreDir, `archive-${coreFileCounter++}.zip`);
  await writeFile(p, bytes);
  return p;
}

/**
 * Contract — confirmArchive(userId, archivePath) concurrency (design C2 task 4;
 * design Testing Strategy "§40 two-transaction race"; task 7 Prompt Success "the
 * core race still restores exactly once and refuses the loser with 409 or
 * IMPORT_BUSY")
 *
 * | Pre-condition | Call (seam) | Observable result | Expected-value source |
 * | --- | --- | --- | --- |
 * | one committed user, two archives each describing one default account for that user, no import admission held (confirmArchive never takes it) | `Promise.allSettled([confirmArchive(userId, pathA), confirmArchive(userId, pathB)])` | exactly one settles fulfilled and one rejected; the rejected reason is `ImportTargetNotEmptyError` (409) or `ImportBusyError` (503); exactly one account row committed | design C2 (confirmArchive: "lockUserForAccountChange", in-tx "assertTargetEmpty", 55P03 → ImportBusyError); task 7 Prompt Success |
 *
 * This is an invariant carried over from task 4 (confirmArchive's own restore
 * semantics are unchanged by task 7): regression guard, not a red test — it
 * already passes before task 7's orchestrator rewrite.
 */
describe('confirmArchive concurrency, admission-free core (design C2, task 7 "two core confirms")', () => {
  it('lets exactly one of two concurrent core confirms restore; the other is refused and writes nothing', async () => {
    const [u] = await dedicatedDb
      .insert(users)
      .values({ email: `import-race-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
      .returning({ id: users.id });
    const userId = u.id;

    const pathA = await saveArchive(makeArchive());
    const pathB = await saveArchive(makeArchive());

    const harnessDb = dbModule.db;
    (dbModule as Record<string, unknown>).db = dedicatedDb;
    try {
      const settled = await Promise.allSettled([
        confirmArchive(userId, pathA),
        confirmArchive(userId, pathB),
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

/**
 * Contract — confirmImport(userId, body, digest) under the per-process import
 * admission (task 2's tryAcquire, wired into confirmImport by task 7 design C8;
 * Requirements 3.1, 3.2)
 *
 * | Pre-condition | Call (seam) | Observable result | Expected-value source |
 * | --- | --- | --- | --- |
 * | two different committed users, each with their own valid single-account archive, no import admission held | `Promise.allSettled([confirmImport(userA, bodyA, digestA), confirmImport(userB, bodyB, digestB)])` | exactly one settles fulfilled and one rejected; the rejected reason is `instanceof ImportCapacityError` (503, code `IMPORT_CAPACITY_REACHED`); exactly one account row committed across both users | design C8 Sequence ("tryAcquire (C1) or throw ImportCapacityError" before any body byte); task 7 Prompt Success ("two concurrent confirmImport calls restore once and refuse the other with 503 IMPORT_CAPACITY_REACHED before any transaction") |
 *
 * Two different users prove the bound is process-wide, not account-scoped
 * (Requirement 3.2): a same-user race would also be refused by the in-transaction
 * emptiness re-check, which would not distinguish the two causes.
 */
describe('confirmImport concurrency, process-wide admission (design C8, Requirements 3.1, 3.2)', () => {
  it('lets one of two concurrent confirmImport calls restore; the other is refused 503 IMPORT_CAPACITY_REACHED before any transaction', async () => {
    const [ua] = await dedicatedDb
      .insert(users)
      .values({
        email: `import-capacity-a-${randomUUID()}@example.com`,
        passwordHash: 'x'.repeat(60),
      })
      .returning({ id: users.id });
    const [ub] = await dedicatedDb
      .insert(users)
      .values({
        email: `import-capacity-b-${randomUUID()}@example.com`,
        passwordHash: 'x'.repeat(60),
      })
      .returning({ id: users.id });

    const bytesA = makeArchive();
    const digestA = createHash('sha256').update(bytesA).digest('hex');
    const bytesB = makeArchive();
    const digestB = createHash('sha256').update(bytesB).digest('hex');

    const harnessDb = dbModule.db;
    (dbModule as Record<string, unknown>).db = dedicatedDb;
    try {
      const settled = await Promise.allSettled([
        confirmImport(ua.id, streamOf(bytesA), digestA),
        confirmImport(ub.id, streamOf(bytesB), digestB),
      ]);

      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ImportCapacityError);
      expect((err as { statusCode: number }).statusCode).toBe(503);
      expect((err as { code: string }).code).toBe('IMPORT_CAPACITY_REACHED');

      // Exactly one restore committed across the two users: the loser never
      // reached its transaction.
      const rowsA = await dedicatedDb.select().from(accounts).where(eq(accounts.userId, ua.id));
      const rowsB = await dedicatedDb.select().from(accounts).where(eq(accounts.userId, ub.id));
      expect(rowsA.length + rowsB.length).toBe(1);
    } finally {
      (dbModule as Record<string, unknown>).db = harnessDb;
      await dedicatedDb.delete(accounts).where(eq(accounts.userId, ua.id));
      await dedicatedDb.delete(accounts).where(eq(accounts.userId, ub.id));
      await dedicatedDb.delete(users).where(eq(users.id, ua.id));
      await dedicatedDb.delete(users).where(eq(users.id, ub.id));
    }
  });
});
