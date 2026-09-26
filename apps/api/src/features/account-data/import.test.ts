import { createHash, randomUUID } from 'node:crypto';

import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { zipSync } from 'fflate';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ArchiveAccount,
  ArchiveConversation,
  ArchiveCounts,
  ArchiveDashboardLayout,
  ArchiveMessage,
  ArchivePersona,
  ArchivePosition,
  ArchivePreferences,
  ArchiveSummary,
  ArchiveSystemBrokerageRef,
  ArchiveTag,
} from '@tradr/shared';

import type { Database } from '@/db';
import { db } from '@/db';
import * as dbModule from '@/db';
import * as schema from '@/db/schema';
import {
  accounts,
  advisorConversations,
  advisorImageCounters,
  advisorMessages,
  advisorSummaries,
  advisorTurnCounters,
  brokerages,
  csvImportCounters,
  dashboardLayouts,
  positionImages,
  positions,
  users,
} from '@/db/schema';
import * as configModule from '@/lib/config';
import { ObjectUnreachableError } from '@/lib/object-storage';
import * as objectStorage from '@/lib/object-storage';

import { ArchiveDigestMismatchError, ImportBusyError } from './account-data.errors';
import { confirmImport, previewImport } from './import.service';

// Design C6 import service, against real tradr_test rolled back per test by the
// single-connection harness (test-setup.ts) — `db` is that per-test transaction and
// the service closes over it. The busy-503 case needs true cross-connection lock
// contention, so it runs against committed rows over a dedicated pool.

const TS = '2026-01-02T03:04:05.123456Z';

// --- Archive builder ---------------------------------------------------------

interface ArchiveSpec {
  brokerages?: unknown[];
  systemBrokerages?: ArchiveSystemBrokerageRef[];
  accounts?: ArchiveAccount[];
  tags?: ArchiveTag[];
  positions?: ArchivePosition[];
  fills?: unknown[];
  positionTags?: unknown[];
  positionImages?: unknown[];
  ledgerEntries?: unknown[];
  exchangeRates?: unknown[];
  expenses?: unknown[];
  personas?: ArchivePersona[];
  builtinPersonas?: { id: string }[];
  conversations?: ArchiveConversation[];
  messages?: ArchiveMessage[];
  summaries?: ArchiveSummary[];
  preferences?: ArchivePreferences;
  dashboardLayout?: ArchiveDashboardLayout;
  images?: Record<string, Uint8Array>;
  sourceAppVersion?: string;
  degradations?: Record<string, unknown>[];
}

function defaultPrefs(): ArchivePreferences {
  return {
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
}

function makeArchive(spec: ArchiveSpec): Uint8Array {
  const images = spec.images ?? {};
  const counts: ArchiveCounts = {
    brokerages: spec.brokerages?.length ?? 0,
    systemBrokerages: spec.systemBrokerages?.length ?? 0,
    accounts: spec.accounts?.length ?? 0,
    tags: spec.tags?.length ?? 0,
    positions: spec.positions?.length ?? 0,
    fills: spec.fills?.length ?? 0,
    positionTags: spec.positionTags?.length ?? 0,
    positionImages: spec.positionImages?.length ?? 0,
    ledgerEntries: spec.ledgerEntries?.length ?? 0,
    exchangeRates: spec.exchangeRates?.length ?? 0,
    expenses: spec.expenses?.length ?? 0,
    personas: spec.personas?.length ?? 0,
    builtinPersonas: spec.builtinPersonas?.length ?? 0,
    conversations: spec.conversations?.length ?? 0,
    messages: spec.messages?.length ?? 0,
    summaries: spec.summaries?.length ?? 0,
    images: Object.keys(images).length,
  };
  const manifest = {
    format: 'tradr-account-archive',
    archiveVersion: 1,
    sourceAppVersion: spec.sourceAppVersion ?? '1.2.3',
    exportedAt: TS,
    counts,
    degradations: spec.degradations ?? [],
  };
  const prefs = spec.preferences ?? defaultPrefs();
  const layout: ArchiveDashboardLayout =
    spec.dashboardLayout === undefined ? null : spec.dashboardLayout;

  const enc = new TextEncoder();
  const ndjson = (rows?: unknown[]): Uint8Array =>
    enc.encode((rows ?? []).map((r) => JSON.stringify(r)).join('\n') + (rows?.length ? '\n' : ''));

  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(images)) files[name] = bytes; // images first
  files['manifest.json'] = enc.encode(JSON.stringify(manifest));
  files['brokerages.ndjson'] = ndjson(spec.brokerages);
  files['system-brokerages.ndjson'] = ndjson(spec.systemBrokerages);
  files['accounts.ndjson'] = ndjson(spec.accounts);
  files['tags.ndjson'] = ndjson(spec.tags);
  files['positions.ndjson'] = ndjson(spec.positions);
  files['fills.ndjson'] = ndjson(spec.fills);
  files['position-tags.ndjson'] = ndjson(spec.positionTags);
  files['position-images.ndjson'] = ndjson(spec.positionImages);
  files['ledger-entries.ndjson'] = ndjson(spec.ledgerEntries);
  files['exchange-rates.ndjson'] = ndjson(spec.exchangeRates);
  files['expenses.ndjson'] = ndjson(spec.expenses);
  files['personas.ndjson'] = ndjson(spec.personas);
  files['builtin-personas.ndjson'] = ndjson(spec.builtinPersonas);
  files['conversations.ndjson'] = ndjson(spec.conversations);
  files['messages.ndjson'] = ndjson(spec.messages);
  files['summaries.ndjson'] = ndjson(spec.summaries);
  files['preferences.json'] = enc.encode(JSON.stringify(prefs));
  files['dashboard-layout.json'] = enc.encode(JSON.stringify(layout));
  return zipSync(files, { level: 0 });
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

// --- Row factories -----------------------------------------------------------

function acct(over: Partial<ArchiveAccount> = {}): ArchiveAccount {
  return {
    id: randomUUID(),
    name: `Acct ${randomUUID().slice(0, 8)}`,
    currency: 'USD',
    timezone: 'America/New_York',
    brokerage: null,
    startingBalance: '1000.0000',
    defaultRiskPercent: null,
    isDemo: false,
    isDefault: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function pos(accountId: string, over: Partial<ArchivePosition> = {}): ArchivePosition {
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
    ...over,
  };
}

function tag(over: Partial<ArchiveTag> = {}): ArchiveTag {
  return {
    id: randomUUID(),
    name: `tag-${randomUUID().slice(0, 8)}`,
    category: 'general',
    color: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function persona(over: Partial<ArchivePersona> = {}): ArchivePersona {
  return {
    id: randomUUID(),
    name: `persona-${randomUUID().slice(0, 8)}`,
    description: null,
    systemPrompt: 'You are helpful.',
    isDefault: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

function conversation(over: Partial<ArchiveConversation> = {}): ArchiveConversation {
  return {
    id: randomUUID(),
    title: 'chat',
    persona: null,
    providerId: 'openai',
    model: 'gpt-4',
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
}

async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `import-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60), ...over })
    .returning({ id: users.id });
  return u.id;
}

async function runConfirm(
  userId: string,
  spec: ArchiveSpec,
  opts?: Parameters<typeof confirmImport>[3],
): Promise<ReturnType<typeof confirmImport>> {
  const bytes = makeArchive(spec);
  return confirmImport(userId, bytesToStream(bytes), digestOf(bytes), opts);
}

// --- previewImport -----------------------------------------------------------

describe('previewImport', () => {
  it('returns counts, source version, export date and the upload digest', async () => {
    const userId = await seedUser();
    const a = acct({ isDefault: true });
    const bytes = makeArchive({ accounts: [a], tags: [tag()] });
    const preview = await previewImport(userId, bytesToStream(bytes));
    expect(preview.counts.accounts).toBe(1);
    expect(preview.counts.tags).toBe(1);
    expect(preview.sourceAppVersion).toBe('1.2.3');
    expect(preview.exportedAt).toBe(TS);
    expect(preview.digest).toBe(digestOf(bytes));
  });

  it('refuses when the target already holds data (409, names the category)', async () => {
    const userId = await seedUser();
    await db.insert(accounts).values({ userId, name: 'existing', currency: 'USD' });
    const bytes = makeArchive({ accounts: [acct({ isDefault: true })] });
    const err = await previewImport(userId, bytesToStream(bytes)).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect((err as { categories?: string[] }).categories).toContain('accounts');
  });
});

// --- confirmImport core ------------------------------------------------------

describe('confirmImport', () => {
  it('rejects a digest that does not match the uploaded bytes (400)', async () => {
    const userId = await seedUser();
    const bytes = makeArchive({ accounts: [acct({ isDefault: true })] });
    const err = await confirmImport(userId, bytesToStream(bytes), 'deadbeef').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ArchiveDigestMismatchError);
    expect((err as { statusCode: number }).statusCode).toBe(400);
  });

  it('restores rows with fresh ids and archived timestamps; overwrites prefs but keeps consent; upserts the layout', async () => {
    const userId = await seedUser({ advisorTradeDataConsent: true, theme: 'system' });
    const a = acct({ isDefault: true, currency: 'EUR' });
    const p = pos(a.id, { symbol: 'MSFT' });
    const widget = { id: randomUUID(), type: 'open-positions', x: 0, y: 0, w: 4, h: 4 };
    const prefs: ArchivePreferences = {
      ...defaultPrefs(),
      displayCurrency: 'GBP',
      theme: 'dark',
      buyingPowerBasis: 'balance',
      advisorTradeDataConsent: false, // archive says false; target's true must win
      writableAccountId: a.id,
    };

    const result = await runConfirm(userId, {
      accounts: [a],
      positions: [p],
      tags: [tag({ name: 'zzz' })],
      preferences: prefs,
      dashboardLayout: { widgets: [widget], createdAt: TS, updatedAt: TS },
    });

    expect(result.counts.accounts).toBe(1);
    expect(result.counts.positions).toBe(1);

    const stored = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(stored).toHaveLength(1);
    expect(stored[0].id).not.toBe(a.id); // fresh identifier (Req 5.4)
    expect(stored[0].name).toBe(a.name);

    // Archived microsecond timestamp survives byte-for-byte (Req 5.5).
    const rows = (await db.execute(sql`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM accounts WHERE user_id = ${userId}
    `)) as unknown as Array<{ createdAt: string }>;
    expect(rows[0].createdAt).toBe(TS);

    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.theme).toBe('dark');
    expect(u.displayCurrency).toBe('GBP');
    expect(u.buyingPowerBasis).toBe('balance');
    expect(u.advisorTradeDataConsent).toBe(true); // kept, not overwritten (Req 5.6)
    expect(u.writableAccountId).toBe(stored[0].id); // remapped to the restored account

    const [layout] = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(layout.widgets).toHaveLength(1);
  });

  it('restores a null-source writableAccountId as null (Req 9.2)', async () => {
    const userId = await seedUser();
    const a = acct({ isDefault: true });
    await runConfirm(userId, {
      accounts: [a],
      preferences: { ...defaultPrefs(), writableAccountId: null },
    });
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.writableAccountId).toBeNull();
  });

  it('deletes the target layout when the archive carries none (D11)', async () => {
    const userId = await seedUser();
    await db.insert(dashboardLayouts).values({ userId });
    await runConfirm(userId, { accounts: [acct({ isDefault: true })], dashboardLayout: null });
    const rows = await db
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('restores over Free-tier caps and writes no gating counter rows (Req 9.1)', async () => {
    vi.spyOn(configModule, 'isFeatureGatingEnabled').mockReturnValue(true);
    const userId = await seedUser();
    // Two accounts exceed the Free cap of one; the restore writes both regardless.
    const result = await runConfirm(userId, {
      accounts: [acct({ isDefault: true }), acct(), acct()],
    });
    expect(result.counts.accounts).toBe(3);
    const stored = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(stored).toHaveLength(3);

    const turn = await db
      .select()
      .from(advisorTurnCounters)
      .where(eq(advisorTurnCounters.userId, userId));
    const image = await db
      .select()
      .from(advisorImageCounters)
      .where(eq(advisorImageCounters.userId, userId));
    const csv = await db
      .select()
      .from(csvImportCounters)
      .where(eq(csvImportCounters.userId, userId));
    expect(turn).toHaveLength(0);
    expect(image).toHaveLength(0);
    expect(csv).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('resolves system brokerages: linked, created, and a collision-renamed copy (Req 6.1)', async () => {
    const userId = await seedUser();
    const linkedName = `Linked ${randomUUID().slice(0, 8)}`;
    const createdName = `Created ${randomUUID().slice(0, 8)}`;
    const [sys] = await db
      .insert(brokerages)
      .values({ userId: null, name: linkedName, isSystem: true })
      .returning({ id: brokerages.id });

    const b1 = {
      id: randomUUID(),
      name: `MyBroker ${randomUUID().slice(0, 8)}`,
      notes: null,
      feeSchedule: null,
      createdAt: TS,
      updatedAt: TS,
    };
    // A user brokerage whose name collides with the created-from-snapshot copy.
    const bCollision = { ...b1, id: randomUUID(), name: createdName };
    const fs = {
      stockPerShareCommission: '1.00000000',
      stockMinPerFill: '1.00000000',
      stockMaxPerFill: '1.00000000',
      optionsPerContractCommission: '1.00000000',
      optionsPerContractExchangeFee: '1.00000000',
      optionsMinPerFill: '1.00000000',
      optionsMaxPerFill: '1.00000000',
    };

    const a1 = acct({ isDefault: true, brokerage: { user: b1.id } });
    const a2 = acct({ brokerage: { system: linkedName } });
    const a3 = acct({ brokerage: { system: createdName } });

    const result = await runConfirm(userId, {
      brokerages: [b1, bCollision],
      systemBrokerages: [
        { name: linkedName, feeSchedule: null },
        { name: createdName, feeSchedule: fs },
      ],
      accounts: [a1, a2, a3],
    });

    const linked = result.resolutions.systemBrokerages.find((r) => r.name === linkedName);
    const created = result.resolutions.systemBrokerages.find((r) => r.name === createdName);
    expect(linked?.outcome).toBe('linked');
    expect(created?.outcome).toBe('created');
    expect(created?.createdName).toBe(`${createdName} (imported)`);

    const stored = await db.select().from(accounts).where(eq(accounts.userId, userId));
    const byName = new Map(stored.map((s) => [s.name, s]));
    expect(byName.get(a2.name)!.brokerageId).toBe(sys.id); // linked to existing system row
    const created3 = byName.get(a3.name)!.brokerageId;
    const [createdBroker] = await db.select().from(brokerages).where(eq(brokerages.id, created3!));
    expect(createdBroker.name).toBe(`${createdName} (imported)`);
    expect(createdBroker.isSystem).toBe(false);
  });

  it('resolves builtin personas: matched kept, missing set to null (Req 6.2)', async () => {
    const userId = await seedUser();
    const p1 = persona();
    const c1 = conversation({ persona: { user: p1.id } });
    const c2 = conversation({ persona: { builtin: 'default-trading-advisor' } });
    const c3 = conversation({ persona: { builtin: 'nonexistent-builtin-xyz' } });

    const result = await runConfirm(userId, {
      personas: [p1],
      builtinPersonas: [{ id: 'default-trading-advisor' }, { id: 'nonexistent-builtin-xyz' }],
      conversations: [c1, c2, c3],
    });

    const matched = result.resolutions.builtinPersonas.find(
      (r) => r.id === 'default-trading-advisor',
    );
    const missing = result.resolutions.builtinPersonas.find(
      (r) => r.id === 'nonexistent-builtin-xyz',
    );
    expect(matched?.outcome).toBe('matched');
    expect(missing?.outcome).toBe('missing');

    const convs = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.userId, userId));
    const byTitle = new Map(convs.map((c) => [c.id, c.personaId]));
    // c2 keeps the builtin id; c3's missing builtin becomes null.
    expect([...byTitle.values()]).toContain('default-trading-advisor');
    expect([...byTitle.values()]).toContain(null);
  });

  it('keeps archived message order under tied timestamps and resolves covered_through (P5, D10)', async () => {
    const userId = await seedUser();
    const c1 = conversation();
    const mk = (text: string): ArchiveMessage => ({
      id: randomUUID(),
      conversationId: c1.id,
      role: 'user',
      contentParts: [{ type: 'text', text }],
      promptTokens: null,
      completionTokens: null,
      clientMessageId: null,
      createdAt: TS,
    });
    const m1 = mk('one');
    const m2 = mk('two');
    const m3 = mk('three');
    const summary: ArchiveSummary = {
      id: randomUUID(),
      conversationId: c1.id,
      prose: 'summary',
      tradeDataFigures: null,
      coveredThroughMessageId: m2.id, // the 2nd message (archive index 1)
      coveredThroughCreatedAt: TS,
      createdAt: TS,
      updatedAt: TS,
    };

    await runConfirm(userId, {
      conversations: [c1],
      messages: [m1, m2, m3],
      summaries: [summary],
    });

    const restoredConvId = (
      await db.select().from(advisorConversations).where(eq(advisorConversations.userId, userId))
    )[0].id;
    const msgs = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, restoredConvId))
      .orderBy(asc(advisorMessages.createdAt), asc(advisorMessages.id));
    expect(msgs).toHaveLength(3);

    const [sum] = await db
      .select()
      .from(advisorSummaries)
      .where(eq(advisorSummaries.conversationId, restoredConvId));
    // The advisory pointer resolves to the message at archive index 1 (P5's
    // sorted-id assignment makes DB order match archive order under ties).
    expect(sum.coveredThroughMessageId).toBe(msgs[1].id);
  });
});

// --- Object storage paths ----------------------------------------------------

describe('confirmImport with object storage', () => {
  const PNG = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function positionImageArchive(): { spec: ArchiveSpec } {
    const a = acct({ isDefault: true });
    const p = pos(a.id);
    const pi = {
      id: randomUUID(),
      positionId: p.id,
      part: { type: 'image', format: 'png', entry: 'images/positions/000001.png' },
      createdAt: TS,
    };
    return {
      spec: {
        accounts: [a],
        positions: [p],
        positionImages: [pi],
        images: { 'images/positions/000001.png': PNG },
      },
    };
  }

  it('restores images inline as dataBase64 when storage is unconfigured (Req 7.1)', async () => {
    vi.spyOn(objectStorage, 'getObjectStorage').mockReturnValue(null);
    const userId = await seedUser();
    const { spec } = positionImageArchive();
    await runConfirm(userId, spec);

    const [img] = await db
      .select({ part: positionImages.part })
      .from(positionImages)
      .innerJoin(positions, eq(positions.id, positionImages.positionId))
      .where(eq(positions.userId, userId));
    const part = img.part as { type: string; dataBase64?: string };
    expect(part.type).toBe('image');
    expect(part.dataBase64).toBe(Buffer.from(PNG).toString('base64'));
  });

  it('writes image bytes unchanged under the user prefix and stores a pointer (Req 7.2)', async () => {
    const puts: Array<{ key: string; bytes: Uint8Array }> = [];
    const fake: objectStorage.ObjectStorage = {
      put: async (key, bytes) => {
        puts.push({ key, bytes: Uint8Array.from(bytes) });
      },
      get: async (key) => ({
        bytes: puts.find((p) => p.key === key)!.bytes,
        contentType: 'image/png',
      }),
      delete: async () => {},
      list: async () => [],
    };
    vi.spyOn(objectStorage, 'getObjectStorage').mockReturnValue(fake);

    const userId = await seedUser();
    const { spec } = positionImageArchive();
    await runConfirm(userId, spec);

    expect(puts).toHaveLength(1);
    expect(puts[0].key.startsWith(`positions/${userId}/`)).toBe(true);
    expect([...puts[0].bytes]).toEqual([...PNG]); // bytes unchanged

    const [img] = await db
      .select({ part: positionImages.part })
      .from(positionImages)
      .innerJoin(positions, eq(positions.id, positionImages.positionId))
      .where(eq(positions.userId, userId));
    const part = img.part as { storage?: { kind: string; key: string } };
    expect(part.storage?.kind).toBe('object');
    expect(part.storage?.key).toBe(puts[0].key);
  });

  it('ends with the 503 and leaves zero rows when an object write fails (Req 7.2)', async () => {
    const fake: objectStorage.ObjectStorage = {
      put: async () => {
        throw new ObjectUnreachableError('down');
      },
      get: async () => ({ bytes: new Uint8Array(), contentType: 'image/png' }),
      delete: async () => {},
      list: async () => [],
    };
    vi.spyOn(objectStorage, 'getObjectStorage').mockReturnValue(fake);

    const userId = await seedUser();
    const { spec } = positionImageArchive();
    const err = await runConfirm(userId, spec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectUnreachableError);
    expect((err as { statusCode: number }).statusCode).toBe(503);

    const acctRows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    const posRows = await db.select().from(positions).where(eq(positions.userId, userId));
    expect(acctRows).toHaveLength(0);
    expect(posRows).toHaveLength(0);
  });
});

// --- Busy 503 under real lock contention (committed data) --------------------

describe('confirmImport lock contention (committed data)', () => {
  const DATABASE_URL =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';
  let dedicatedSql: ReturnType<typeof postgres>;
  let dedicatedDb: Database;

  beforeAll(() => {
    dedicatedSql = postgres(DATABASE_URL, { max: 3 });
    dedicatedDb = drizzle(dedicatedSql, { schema });
  });

  afterAll(async () => {
    await dedicatedSql.end();
  });

  it('maps a lock-wait expiry to the 503 busy error (SQLSTATE 55P03)', async () => {
    const [u] = await dedicatedDb
      .insert(users)
      .values({ email: `busy-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
      .returning({ id: users.id });
    const userId = u.id;

    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    // Connection A takes the per-user account-change row lock and holds it open.
    const holderDone = dedicatedDb
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
        await held;
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    const harnessDb = dbModule.db;
    (dbModule as Record<string, unknown>).db = dedicatedDb;
    try {
      const bytes = makeArchive({ accounts: [acct({ isDefault: true })] });
      const err = await confirmImport(userId, bytesToStream(bytes), digestOf(bytes), {
        lockTimeout: '150ms',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportBusyError);
      expect((err as { statusCode: number }).statusCode).toBe(503);
    } finally {
      (dbModule as Record<string, unknown>).db = harnessDb;
      releaseHolder();
      await holderDone;
      await dedicatedDb.delete(users).where(eq(users.id, userId));
    }
  });
});
