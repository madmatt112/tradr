import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { zipSync } from 'fflate';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ArchiveCounts } from '@tradr/shared';

import app from '@/app';
import type { Database } from '@/db';
import * as schema from '@/db/schema';
import { accounts, users } from '@/db/schema';

import { ImportCapacityError, ImportTimedOutError } from './account-data.errors';
import { accountDataSlot } from './account-data.slots';
import type { ImportExecutor } from './import.executor';
import { confirmImport, previewImport } from './import.service';

// This file proves Requirement 1.4 and the clean-exit guarantees (2.2-2.4, 3.2)
// through the REAL worker executor, per design Testing Strategy "Integration,
// worker". `test-setup.ts` globally mocks `./import.executor` so every OTHER
// suite's default executor is the in-thread one (design D9); here `vi.importActual`
// bypasses that mock so `runImportJobInWorker` is the genuine implementation, spawning
// a real `worker_threads` worker that opens its own database connection from the
// inherited `DATABASE_URL` (design C2) — a connection the per-test rolled-back
// transaction (test-setup.ts) is invisible to, so every committed user here goes
// through a dedicated two-connection pool, exactly as `concurrency.test.ts` commits
// its racing users.
//
// Contract — previewImport/confirmImport(userId, body, ...opts) through
// runImportJobInWorker (design Testing Strategy "Integration, worker"; task 9 Prompt
// Success)
//
// | Criterion (task 9 Success)                                                         | Pre-condition                                                                              | Call (seam)                                                                                           | Observable result                                                                                              | Expected-value source |
// | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
// | Test A: health answers while a worker preview holds the thread, and the preview then resolves | a committed user, a valid single-account archive, worker executor, `holdMs: 3000`          | `previewImport(userId, body, { executor: runImportJobInWorker, holdMs: 3000 })`, then mid-flight `app.request('/api/health')` | the health call answers 200 in under 1,000 ms while the preview promise is still pending; the preview then resolves with `counts.accounts === 1` | task 9 Success: "`/api/health` answers 200 within 1,000 ms during a held preview (A) ... and each operation then resolves"; design Testing Strategy |
// | Test B: health answers while a worker confirm holds the thread, and the confirm then resolves  | a committed, empty-target user, a valid single-account archive and its digest, worker executor, `holdMs: 3000` | `confirmImport(userId, body, digest, { executor: runImportJobInWorker, holdMs: 3000 })`, then mid-flight `app.request('/api/health')` | the health call answers 200 in under 1,000 ms while the confirm promise is still pending; the confirm then resolves and commits exactly one account row | task 9 Success: "...and a held confirm (B), and each operation then resolves"; design Testing Strategy |
// | Deadline: a confirm that cannot finish before its deadline times out and leaves nothing behind | a committed, empty-target user, worker executor, `deadlineMs: 500`, `cancelGraceMs: 500`, `holdMs: 3000` | `confirmImport(userId, body, digest, { executor, deadlineMs: 500, cancelGraceMs: 500, holdMs: 3000 })` | rejects `instanceof ImportTimedOutError` (422 `IMPORT_TIMED_OUT`); no `accounts` row for the user; no `tradr-import-*` operation directory left; the import admission is free afterward | task 9 Success: "the deadline test gets 422 `IMPORT_TIMED_OUT`, no row for the user, no directory left and a free admission"; design Testing Strategy "a deadline test ... asserts 422 IMPORT_TIMED_OUT, no row for the user, no tradr-import-* directory left, and a free admission afterwards" |
// | Abandonment: a confirm whose caller disconnects mid-operation leaves the same clean exit        | a committed, empty-target user, worker executor, `holdMs: 3000`, `cancelGraceMs: 500`, the caller's own `AbortController` aborted partway through | `confirmImport(userId, body, digest, { executor, signal, cancelGraceMs: 500, holdMs: 3000 })`, `signal.abort()` fired mid-flight | rejects `instanceof ImportTimedOutError`; no `accounts` row for the user; no `tradr-import-*` operation directory left; the import admission is free afterward | task 9 Success: "the abandonment test gets the same cleanup"; design Testing Strategy "an abandonment test aborts opts.signal mid-read and asserts the same cleanup" |
// | Capacity: a second preview arriving while one is held is refused at once                        | one preview already holding the import admission (worker executor, `holdMs: 3000`)        | `previewImport(otherUserId, otherBody, { executor })` issued while the first is still pending          | rejects `instanceof ImportCapacityError` (503 `IMPORT_CAPACITY_REACHED`) within a few milliseconds, well before the held preview's hold ends | task 9 Success: "a second preview during a held one is refused 503 `IMPORT_CAPACITY_REACHED` at once"; design Testing Strategy "a capacity test holds one preview and asserts that a second is refused 503 at once" |

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';

// The worker reads the inherited environment to build its own database pool
// (design C2 probe P1); when the harness has not set `DATABASE_URL` for the main
// process, the worker would inherit nothing and fail to connect. Set the harness
// fallback for the duration so the worker's inherited environment matches the
// pool this file itself uses to commit users, and restore whatever was there
// before so no other suite in this process sees a changed environment.
const hadDatabaseUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
const previousDatabaseUrl = process.env.DATABASE_URL;

let dedicatedSql: ReturnType<typeof postgres>;
let dedicatedDb: Database;

// The real worker executor, bypassing test-setup.ts's global mock of this module
// (which swaps the DEFAULT executor for the in-thread one everywhere else).
let runImportJobInWorker: ImportExecutor;

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  dedicatedSql = postgres(DATABASE_URL, { max: 2 });
  dedicatedDb = drizzle(dedicatedSql, { schema });

  const actual = await vi.importActual<typeof import('./import.executor')>('./import.executor');
  runImportJobInWorker = actual.runImportJobInWorker;
});

afterAll(async () => {
  await dedicatedSql.end();
  if (hadDatabaseUrl) process.env.DATABASE_URL = previousDatabaseUrl;
  else delete process.env.DATABASE_URL;
});

const TS = '2026-01-02T03:04:05.123456Z';

// A minimal but valid single-account archive, as `concurrency.test.ts` builds
// (one default account; enough for a real restore and for `assertTargetEmpty`'s
// re-check to matter after a successful confirm).
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createUser(label: string): Promise<string> {
  const [row] = await dedicatedDb
    .insert(users)
    .values({
      email: `import-worker-${label}-${randomUUID()}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning({ id: users.id });
  return row.id;
}

async function deleteUser(userId: string): Promise<void> {
  await dedicatedDb.delete(accounts).where(eq(accounts.userId, userId));
  await dedicatedDb.delete(users).where(eq(users.id, userId));
}

async function accountRowCount(userId: string): Promise<number> {
  const rows = await dedicatedDb.select().from(accounts).where(eq(accounts.userId, userId));
  return rows.length;
}

// The per-operation temp directory `withImportAdmission` makes is named
// `tradr-import-<random>` (design C1/C8); the worker-bundle build cache
// (import.executor.ts's `buildWorkerOnce`, built once per process and never
// removed) is named `tradr-import-worker-<random>` and must be excluded, or the
// very first worker spawn in this file would make every later "no directory
// left" assertion fail on a directory this test never owned. Filtered further
// by creation time so another process's own import cannot make this flaky.
async function leftoverOperationDirs(sinceMs: number): Promise<string[]> {
  const names = await readdir(tmpdir());
  const candidates = names.filter(
    (n) => n.startsWith('tradr-import-') && !n.startsWith('tradr-import-worker-'),
  );
  const owned: string[] = [];
  for (const name of candidates) {
    const full = path.join(tmpdir(), name);
    try {
      const info = await stat(full);
      const createdMs = info.birthtimeMs || info.mtimeMs;
      if (createdMs >= sinceMs) owned.push(full);
    } catch {
      // Removed between readdir and stat by the very cleanup this test is
      // checking for — not a leak.
    }
  }
  return owned;
}

async function expectAdmissionFree(): Promise<void> {
  const release = accountDataSlot('import').tryAcquire();
  expect(release).toBeTruthy();
  release?.();
}

describe('import worker integration (design Testing Strategy "Integration, worker"; Requirement 1.4)', () => {
  it('A: /api/health answers within 1,000 ms while a worker preview holds the thread, which then resolves', async () => {
    const userId = await createUser('preview-health');
    try {
      const bytes = makeArchive();
      const previewPromise = previewImport(userId, streamOf(bytes), {
        executor: runImportJobInWorker,
        holdMs: 3000,
      });

      await sleep(200);
      const healthStart = Date.now();
      const health = await app.request('/api/health');
      const healthElapsed = Date.now() - healthStart;

      expect(health.status).toBe(200);
      expect(healthElapsed).toBeLessThan(1000);

      const preview = await previewPromise;
      expect(preview.counts.accounts).toBe(1);
    } finally {
      await deleteUser(userId);
    }
  }, 30000);

  it('B: /api/health answers within 1,000 ms while a worker confirm holds the thread, which then resolves', async () => {
    const userId = await createUser('confirm-health');
    try {
      const bytes = makeArchive();
      const digest = createHash('sha256').update(bytes).digest('hex');
      const confirmPromise = confirmImport(userId, streamOf(bytes), digest, {
        executor: runImportJobInWorker,
        holdMs: 3000,
      });

      await sleep(200);
      const healthStart = Date.now();
      const health = await app.request('/api/health');
      const healthElapsed = Date.now() - healthStart;

      expect(health.status).toBe(200);
      expect(healthElapsed).toBeLessThan(1000);

      const result = await confirmPromise;
      expect(result.counts.accounts).toBe(1);
      expect(await accountRowCount(userId)).toBe(1);
    } finally {
      await deleteUser(userId);
    }
  }, 30000);
});

describe('import worker integration — deadline, abandonment and capacity (Requirements 2.2-2.4, 3.2)', () => {
  it('deadline: a confirm that cannot finish in time is timed out with no row, no directory and a free admission', async () => {
    const userId = await createUser('confirm-deadline');
    const sinceMs = Date.now() - 1000;
    try {
      const bytes = makeArchive();
      const digest = createHash('sha256').update(bytes).digest('hex');

      await expect(
        confirmImport(userId, streamOf(bytes), digest, {
          executor: runImportJobInWorker,
          deadlineMs: 500,
          cancelGraceMs: 500,
          holdMs: 3000,
        }),
      ).rejects.toBeInstanceOf(ImportTimedOutError);

      expect(await accountRowCount(userId)).toBe(0);
      expect(await leftoverOperationDirs(sinceMs)).toEqual([]);
      await expectAdmissionFree();
    } finally {
      await deleteUser(userId);
    }
  }, 30000);

  it('abandonment: a confirm whose caller disconnects mid-operation is stopped with no row, no directory and a free admission', async () => {
    const userId = await createUser('confirm-abandon');
    const sinceMs = Date.now() - 1000;
    try {
      const bytes = makeArchive();
      const digest = createHash('sha256').update(bytes).digest('hex');
      const controller = new AbortController();

      const confirmPromise = confirmImport(userId, streamOf(bytes), digest, {
        executor: runImportJobInWorker,
        signal: controller.signal,
        cancelGraceMs: 500,
        holdMs: 3000,
      });

      await sleep(200);
      controller.abort();

      await expect(confirmPromise).rejects.toBeInstanceOf(ImportTimedOutError);

      expect(await accountRowCount(userId)).toBe(0);
      expect(await leftoverOperationDirs(sinceMs)).toEqual([]);
      await expectAdmissionFree();
    } finally {
      await deleteUser(userId);
    }
  }, 30000);

  it('capacity: a second preview arriving while one is held is refused 503 IMPORT_CAPACITY_REACHED at once', async () => {
    const heldUserId = await createUser('preview-capacity-held');
    const refusedUserId = await createUser('preview-capacity-refused');
    try {
      const heldBytes = makeArchive();
      const heldPromise = previewImport(heldUserId, streamOf(heldBytes), {
        executor: runImportJobInWorker,
        holdMs: 3000,
      });

      const refusedBytes = makeArchive();
      const refusalStart = Date.now();
      await expect(
        previewImport(refusedUserId, streamOf(refusedBytes), {
          executor: runImportJobInWorker,
        }),
      ).rejects.toBeInstanceOf(ImportCapacityError);
      const refusalElapsed = Date.now() - refusalStart;

      expect(refusalElapsed).toBeLessThan(200);

      const held = await heldPromise;
      expect(held.counts.accounts).toBe(1);
    } finally {
      await deleteUser(heldUserId);
      await deleteUser(refusedUserId);
    }
  }, 30000);
});
