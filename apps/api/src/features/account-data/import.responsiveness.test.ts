import { createHash, randomUUID } from 'node:crypto';

import { serve, type ServerType } from '@hono/node-server';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ArchiveFillSchema,
  type ArchiveAccount,
  type ArchiveCounts,
  type ArchiveFill,
  type ArchivePosition,
  type ArchivePreferences,
} from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

import { confirmImport, previewImport } from './import.service';

// Req 2.5 regression guard (design "Testing Strategy"): a second request on the
// same process completes while a preview is in flight, and another while a
// confirm is in flight. This guards the mechanism (design C4's reader yield
// budget), not the production-size outcome — that is the staging bench
// (Req 10), per design decision D6. Red-first against the pre-C4 base: today
// `readArchive`'s delivery loops hand hundreds of buffered rows to the
// validator/restore in one macrotask with no yield, so `GET /api/health`
// cannot be answered until the whole run drains.
//
// Contract (Req 2.5):
//   Pre-condition: a 2,000-fill archive sharing one 2 KiB note, so a single 8 KiB
//     push inflates hundreds of row events; `ArchiveFillSchema.safeParse` wrapped
//     with a 5 ms busy-wait, red-first against the pre-C4 base.
//   Call through the seam: `previewImport(userId, body)`, then separately
//     `confirmImport(userId, body, digest)`, each run while the real app is
//     served over HTTP on an ephemeral port.
//   Observable result: `fetch('/api/health')` answers 200 within 250 ms while
//     each operation is still in flight, and each operation then resolves with
//     `counts.fills === 2000`.
//   Source of the expected value: design Testing Strategy's "Req 2.5 regression
//     guard" (250 ms bound; the fixture and busy-wait shape).

const TS = '2026-01-02T03:04:05.123456Z';

// The fixture design names: 2,000 fills sharing one 2 KiB note, so the single
// `fills.ndjson` entry's compressed bytes still fit in one 8 KiB reader push
// and inflate into hundreds (here: thousands) of buffered row events.
const FILL_COUNT = 2000;
const NOTE = 'x'.repeat(2048);

interface ArchiveSpec {
  accounts?: ArchiveAccount[];
  positions?: ArchivePosition[];
  fills?: ArchiveFill[];
}

function makeArchive(spec: ArchiveSpec): Uint8Array {
  const counts: ArchiveCounts = {
    brokerages: 0,
    systemBrokerages: 0,
    accounts: spec.accounts?.length ?? 0,
    tags: 0,
    positions: spec.positions?.length ?? 0,
    fills: spec.fills?.length ?? 0,
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
  const prefs: ArchivePreferences = {
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
  const ndjson = (rows?: unknown[]): Uint8Array =>
    enc.encode((rows ?? []).map((r) => JSON.stringify(r)).join('\n') + (rows?.length ? '\n' : ''));

  const files: Record<string, Uint8Array> = {
    'manifest.json': enc.encode(JSON.stringify(manifest)),
    'brokerages.ndjson': ndjson(),
    'system-brokerages.ndjson': ndjson(),
    'accounts.ndjson': ndjson(spec.accounts),
    'tags.ndjson': ndjson(),
    'positions.ndjson': ndjson(spec.positions),
    'fills.ndjson': ndjson(spec.fills),
    'position-tags.ndjson': ndjson(),
    'position-images.ndjson': ndjson(),
    'ledger-entries.ndjson': ndjson(),
    'exchange-rates.ndjson': ndjson(),
    'expenses.ndjson': ndjson(),
    'personas.ndjson': ndjson(),
    'builtin-personas.ndjson': ndjson(),
    'conversations.ndjson': ndjson(),
    'messages.ndjson': ndjson(),
    'summaries.ndjson': ndjson(),
    'preferences.json': enc.encode(JSON.stringify(prefs)),
    'dashboard-layout.json': enc.encode(JSON.stringify(null)),
  };
  // Real deflate (not the import.test.ts suite's level: 0): the scenario this
  // test reproduces depends on a small compressed read inflating many rows.
  return zipSync(files, { level: 9 });
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function acct(): ArchiveAccount {
  return {
    id: randomUUID(),
    name: 'Responsiveness',
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
}

function pos(accountId: string): ArchivePosition {
  return {
    id: randomUUID(),
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    status: 'open',
    notes: null,
    targetPrice: null,
    stopLoss: null,
    openedAt: TS,
    closedAt: null,
    lastFlatAt: null,
    lastFlatNetPnl: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

function manyFills(positionId: string): ArchiveFill[] {
  return Array.from({ length: FILL_COUNT }, () => ({
    id: randomUUID(),
    positionId,
    type: 'entry',
    price: '100.00000000',
    quantity: '1.00000000',
    fees: '0.00000000',
    notes: NOTE,
    filledAt: TS,
    createdAt: TS,
  }));
}

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `import-resp-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return u.id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Wraps the real `ArchiveFillSchema.safeParse` with a 5 ms busy-wait (design's
// fixture), so hundreds of parses run inside one macrotask on the base reader.
function stubSlowFillParse(): void {
  const originalSafeParse = ArchiveFillSchema.safeParse.bind(ArchiveFillSchema);
  vi.spyOn(ArchiveFillSchema, 'safeParse').mockImplementation(((value: unknown) => {
    const start = Date.now();
    while (Date.now() - start < 5) {
      // simulate the validator's per-row CPU cost
    }
    return originalSafeParse(value);
  }) as typeof ArchiveFillSchema.safeParse);
}

// Settles immediately so a slow or rejected op never surfaces as an unhandled
// rejection when the health assertion below throws first (red-first path).
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

async function expectHealthyWithin(budgetMs: number): Promise<void> {
  const start = performance.now();
  const res = await fetch(`${baseUrl}/api/health`);
  const elapsed = performance.now() - start;
  expect(res.status).toBe(200);
  expect(elapsed).toBeLessThan(budgetMs);
}

describe('import responsiveness (design C4 regression guard, Req 2.5)', () => {
  it('answers GET /api/health within 250 ms while previewImport runs, and again while confirmImport runs', async () => {
    const userId = await seedUser();
    const a = acct();
    const p = pos(a.id);
    const bytes = makeArchive({ accounts: [a], positions: [p], fills: manyFills(p.id) });
    const digest = digestOf(bytes);

    stubSlowFillParse();

    const preview = settle(previewImport(userId, bytesToStream(bytes)));
    await delay(300);
    await expectHealthyWithin(250);
    const previewResult = await preview;
    if (!previewResult.ok) throw previewResult.error;
    expect(previewResult.value.counts.fills).toBe(FILL_COUNT);

    vi.restoreAllMocks();
    stubSlowFillParse();

    const confirmed = settle(confirmImport(userId, bytesToStream(bytes), digest));
    await delay(300);
    await expectHealthyWithin(250);
    const confirmResult = await confirmed;
    if (!confirmResult.ok) throw confirmResult.error;
    expect(confirmResult.value.counts.fills).toBe(FILL_COUNT);
  }, 45_000);
});
