import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import {
  accountDeletionSchedules,
  accounts,
  advisorConversations,
  advisorMessages,
  advisorPersonas,
  advisorSummaries,
  billingCustomers,
  brokerages,
  dashboardLayouts,
  exchangeRates,
  expenses,
  externalApiKeys,
  feeSchedules,
  fills,
  ledgerEntries,
  positionImages,
  positionTags,
  positions,
  sessions,
  subscriptions,
  tags,
  users,
} from '@/db/schema';
import { ObjectUnreachableError, type ObjectStorage } from '@/lib/object-storage';

import { createExport } from './export.service';

// Design C3 export service, against real tradr_test rolled back by the
// single-connection harness (test-setup.ts). A full surface (all seven ledger
// types, one object-pointer advisor image and one object-pointer position image)
// is seeded, exported through the streaming zip, and read back with task 1's
// fflate reader.

// The fake bucket the current test installs; `getObjectStorage` is swapped for a
// getter that returns it (position-images.storage.test.ts:11-18).
const bucket = vi.hoisted(() => ({ current: null as ObjectStorage | null }));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  return { ...actual, getObjectStorage: () => bucket.current };
});

// --- Secrets that must never reach the archive (Req 2.5) --------------------
const PASSWORD_HASH = `SECRETPWHASH${'x'.repeat(48)}`; // 60 chars, bcrypt-shaped
const SESSION_TOKEN_HASH = 'SECRETSESSIONTOKENHASH0001';
const ENCRYPTED_KEY = 'SECRETENCRYPTEDKEYVALUE';
const STRIPE_MARKER = 'SECRETSTRIPEID';

// --- Seeded object-storage pointers -----------------------------------------
const ADVISOR_KEY = 'advisor/seed/img-advisor';
const POSITION_KEY = 'positions/seed/img-position';
const ADVISOR_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const POSITION_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 9, 8]);
const ADVISOR_IMAGE_ENTRY = 'images/advisor/000001.png';
const POSITION_IMAGE_ENTRY = 'images/positions/000001.jpeg';

const MICRO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

class FakeStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>([
    [ADVISOR_KEY, { bytes: ADVISOR_BYTES, contentType: 'image/png' }],
    [POSITION_KEY, { bytes: POSITION_BYTES, contentType: 'image/jpeg' }],
  ]);

  put(): Promise<void> {
    return Promise.resolve();
  }

  // Overridable per test. Default: serve known keys, treat an unknown key as a
  // genuinely-missing object (404 cause) so the discriminator degrades it.
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const o = this.objects.get(key);
    if (!o) throw new ObjectUnreachableError(`gone: ${key}`, { name: 'NoSuchKey' });
    return Promise.resolve({ bytes: o.bytes, contentType: o.contentType });
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  list(): Promise<Array<{ key: string; lastModified: Date }>> {
    return Promise.resolve([]);
  }
}

let fake: FakeStorage;
beforeEach(() => {
  fake = new FakeStorage();
  bucket.current = fake;
});

interface Seed {
  userId: string;
  email: string;
  accountId: string;
  positionId: string;
  conversationId: string;
  messageId: string;
}

const LEDGER_TYPES = [
  'position_pnl',
  'position_pnl_reversal',
  'balance_adjustment',
  'deposit',
  'withdrawal',
  'deposit_reversal',
  'withdrawal_reversal',
] as const;

async function seedFull(): Promise<Seed> {
  const [u] = await db
    .insert(users)
    .values({ email: `export-${randomUUID()}@example.com`, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id, email: users.email });
  const userId = u.id;

  const [bUser] = await db
    .insert(brokerages)
    .values({ userId, name: 'My Broker', notes: 'personal', isSystem: false })
    .returning({ id: brokerages.id });
  await db.insert(feeSchedules).values({
    brokerageId: bUser.id,
    stockPerShareCommission: '0.01',
    stockMinPerFill: '1',
    stockMaxPerFill: '5',
    optionsPerContractCommission: '0.65',
    optionsPerContractExchangeFee: '0.02',
    optionsMinPerFill: '0',
    optionsMaxPerFill: '10',
  });

  const [acct] = await db
    .insert(accounts)
    .values({
      userId,
      name: 'Main',
      currency: 'USD',
      timezone: 'America/New_York',
      brokerageId: bUser.id,
      startingBalance: '1234.56',
      defaultRiskPercent: '2.5',
      isDemo: false,
      isDefault: true,
    })
    .returning({ id: accounts.id });

  const [tag] = await db
    .insert(tags)
    .values({ userId, name: 'Breakout', category: 'setup', color: '#ffffff' })
    .returning({ id: tags.id });

  // eslint-disable-next-line no-restricted-syntax -- seed a fixed closed position for the export reader test
  const [pos] = await db
    .insert(positions)
    .values({
      userId,
      accountId: acct.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      targetPrice: '1.5',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatNetPnl: '123.45',
      createdAt: sql`timestamptz '2026-01-02 03:04:05.123456+00'`,
    })
    .returning({ id: positions.id });

  await db.insert(fills).values({
    positionId: pos.id,
    type: 'entry',
    price: '0.5',
    quantity: '10',
    fees: '0.01',
    filledAt: new Date('2026-01-01T12:00:00Z'),
  });
  await db.insert(positionTags).values({ positionId: pos.id, tagId: tag.id });
  await db.insert(positionImages).values({
    positionId: pos.id,
    part: { type: 'image', format: 'jpeg', storage: { kind: 'object', key: POSITION_KEY } },
  });

  // All seven ledger entry types, each its own group (Req 2.1).
  const g = LEDGER_TYPES.map(() => randomUUID());
  for (let i = 0; i < LEDGER_TYPES.length; i++) {
    const type = LEDGER_TYPES[i];
    const isPnl = type === 'position_pnl' || type === 'position_pnl_reversal';
    await db.insert(ledgerEntries).values({
      userId,
      accountId: acct.id,
      positionId: isPnl ? pos.id : null,
      entryType: type,
      direction: 'credit',
      amount: '10',
      currency: 'USD',
      symbol: isPnl ? 'AAPL' : null,
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      groupId: g[i],
      reversesGroupId: type.endsWith('_reversal') ? g[i - 1] : null,
    });
  }

  await db.insert(exchangeRates).values({
    userId,
    baseCurrency: 'USD',
    quoteCurrency: 'CAD',
    rate: '1.35',
    effectiveDate: '2026-01-03',
  });
  await db.insert(expenses).values({
    userId,
    category: 'data_subscription',
    description: 'Data feed',
    amount: '5',
    currency: 'USD',
    occurredAt: '2026-01-04',
  });

  const personaId = randomUUID();
  await db.insert(advisorPersonas).values({
    id: personaId,
    userId,
    name: 'My Coach',
    systemPrompt: 'be helpful',
    isBuiltin: false,
    isDefault: false,
  });

  await db
    .update(users)
    .set({
      displayCurrency: 'USD',
      timezone: 'America/New_York',
      taxJurisdiction: 'US',
      theme: 'dark',
      buyingPowerBasis: 'balance',
      advisorDefaultPersonaId: personaId,
      advisorTradeDataConsent: true,
      writableAccountId: acct.id,
    })
    .where(sql`id = ${userId}`);

  const [conv] = await db
    .insert(advisorConversations)
    .values({
      userId,
      title: 'Chat',
      personaId: 'default-trading-advisor',
      providerId: 'openai',
      model: 'gpt-4',
    })
    .returning({ id: advisorConversations.id });

  const [msg] = await db
    .insert(advisorMessages)
    .values({
      conversationId: conv.id,
      role: 'user',
      contentParts: [
        { type: 'text', text: 'look at this' },
        { type: 'image', format: 'png', storage: { kind: 'object', key: ADVISOR_KEY } },
      ],
      promptTokens: 5,
      completionTokens: null,
      clientMessageId: randomUUID(),
      createdAt: sql`timestamptz '2026-02-03 04:05:06.654321+00'`,
    })
    .returning({ id: advisorMessages.id });

  await db.insert(advisorSummaries).values({
    conversationId: conv.id,
    prose: 'a summary',
    tradeDataFigures: null,
    coveredThroughMessageId: msg.id,
    coveredThroughCreatedAt: new Date('2026-02-03T04:05:06Z'),
  });

  await db
    .insert(dashboardLayouts)
    .values({ userId, widgets: [{ type: 'stats-summary', id: 'pnl', x: 0, y: 0, w: 4, h: 2 }] });

  return {
    userId,
    email: u.email,
    accountId: acct.id,
    positionId: pos.id,
    conversationId: conv.id,
    messageId: msg.id,
  };
}

// Seed the excluded secret-bearing tables (Req 2.5), never exported.
async function seedSecrets(userId: string): Promise<void> {
  await db.insert(sessions).values({
    userId,
    tokenHash: SESSION_TOKEN_HASH,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.insert(externalApiKeys).values({
    userId,
    provider: 'openai',
    encryptedKey: ENCRYPTED_KEY,
    keyVersion: 1,
    keyHintTail: 'tail1234',
  });
  await db.insert(billingCustomers).values({ userId, stripeCustomerId: `cus_${STRIPE_MARKER}` });
  await db.insert(subscriptions).values({
    userId,
    stripeCustomerId: `cus_${STRIPE_MARKER}`,
    stripeSubscriptionId: `sub_${STRIPE_MARKER}`,
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    stripeCreatedAt: new Date(),
    lastEventCreated: new Date(),
  });
}

// --- zip reading (task 1's fflate reader) -----------------------------------

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

function inflate(archive: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const unzip = new Unzip((file) => {
    const parts: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) throw err;
      parts.push(data.slice());
      if (final) out.set(file.name, concat(parts));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  for (let offset = 0; offset < archive.length; offset += 65536) {
    const end = Math.min(offset + 65536, archive.length);
    unzip.push(archive.subarray(offset, end), end >= archive.length);
  }
  return out;
}

function decode(entries: Map<string, Uint8Array>, name: string): string {
  const bytes = entries.get(name);
  if (!bytes) throw new Error(`missing entry ${name}`);
  return new TextDecoder().decode(bytes);
}

function ndjson(entries: Map<string, Uint8Array>, name: string): Record<string, unknown>[] {
  return decode(entries, name)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function exportEntries(userId: string): Promise<Map<string, Uint8Array>> {
  const { stream } = await createExport(userId);
  return inflate(await collect(stream));
}

describe('createExport', () => {
  it('streams a full-surface archive with all seven ledger types and image entries', async () => {
    const seed = await seedFull();
    const entries = await exportEntries(seed.userId);

    const manifest = JSON.parse(decode(entries, 'manifest.json')) as {
      format: string;
      archiveVersion: number;
      sourceAppVersion: string;
      exportedAt: string;
      counts: Record<string, number>;
      degradations: unknown[];
    };
    expect(manifest.format).toBe('tradr-account-archive');
    expect(manifest.archiveVersion).toBe(1);
    expect(manifest.sourceAppVersion).toBe('unknown'); // APP_VERSION unset in tests
    expect(manifest.exportedAt).toMatch(MICRO_TS_RE);
    expect(manifest.degradations).toEqual([]);
    expect(manifest.counts).toMatchObject({
      accounts: 1,
      positions: 1,
      fills: 1,
      ledgerEntries: 7,
      messages: 1,
      positionImages: 1,
      images: 2,
    });

    // Every fixed payload entry is present, image entries lead the container.
    for (const name of [
      'brokerages.ndjson',
      'accounts.ndjson',
      'positions.ndjson',
      'ledger-entries.ndjson',
      'preferences.json',
      'dashboard-layout.json',
    ]) {
      expect(entries.has(name)).toBe(true);
    }

    const ledgerTypes = ndjson(entries, 'ledger-entries.ndjson').map((r) => r.entryType);
    expect(new Set(ledgerTypes)).toEqual(new Set(LEDGER_TYPES));

    // Image bytes carried verbatim, parts rewritten to entry references.
    expect(entries.get(ADVISOR_IMAGE_ENTRY)).toEqual(ADVISOR_BYTES);
    expect(entries.get(POSITION_IMAGE_ENTRY)).toEqual(POSITION_BYTES);

    const [message] = ndjson(entries, 'messages.ndjson');
    expect(message.contentParts).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', format: 'png', entry: ADVISOR_IMAGE_ENTRY },
    ]);

    const [image] = ndjson(entries, 'position-images.ndjson');
    expect(image.part).toEqual({ type: 'image', format: 'jpeg', entry: POSITION_IMAGE_ENTRY });
  });

  it('never writes a secret into the archive (Req 2.5)', async () => {
    const seed = await seedFull();
    await seedSecrets(seed.userId);
    const entries = await exportEntries(seed.userId);

    let haystack = '';
    for (const bytes of entries.values()) haystack += new TextDecoder().decode(bytes);

    expect(haystack).not.toContain('SECRETPWHASH');
    expect(haystack).not.toContain(SESSION_TOKEN_HASH);
    expect(haystack).not.toContain(ENCRYPTED_KEY);
    expect(haystack).not.toContain(STRIPE_MARKER);
  });

  it('marks a missing image unrecoverable and records a manifest degradation', async () => {
    const seed = await seedFull();
    fake.objects.delete(POSITION_KEY); // now a 404 on get
    const entries = await exportEntries(seed.userId);

    const manifest = JSON.parse(decode(entries, 'manifest.json')) as {
      counts: Record<string, number>;
      degradations: Array<Record<string, unknown>>;
    };
    expect(manifest.counts.images).toBe(1); // only the advisor image
    expect(manifest.degradations).toEqual([
      {
        entry: 'position-images.ndjson',
        rowId: expect.any(String),
        partIndex: 0,
        reason: 'object_missing',
      },
    ]);
    expect(entries.has(POSITION_IMAGE_ENTRY)).toBe(false);

    const [image] = ndjson(entries, 'position-images.ndjson');
    expect(image.part).toEqual({
      type: 'image',
      format: 'jpeg',
      storage: { kind: 'unrecoverable' },
    });
  });

  it('fails with 503 when storage is unreachable before the first chunk', async () => {
    const seed = await seedFull();
    fake.get = () => {
      throw new ObjectUnreachableError('storage down'); // no cause → outage, not missing
    };
    await expect(createExport(seed.userId)).rejects.toBeInstanceOf(ObjectUnreachableError);
  });

  it('errors the stream when storage fails after the first chunk', async () => {
    const seed = await seedFull();
    // Serve the advisor image (first fetch → first chunk), then fail the position
    // image, so the failure lands after the response has started.
    fake.get = (key: string) => {
      if (key === ADVISOR_KEY)
        return Promise.resolve({ bytes: ADVISOR_BYTES, contentType: 'image/png' });
      throw new ObjectUnreachableError('storage down');
    };
    const { stream } = await createExport(seed.userId);
    await expect(collect(stream)).rejects.toBeInstanceOf(ObjectUnreachableError);
  });

  it('still exports while a deletion is scheduled (Req 1.8)', async () => {
    const seed = await seedFull();
    await db.insert(accountDeletionSchedules).values({
      userId: seed.userId,
      state: 'scheduled',
      dueAt: new Date(Date.now() + 86_400_000),
    });
    const entries = await exportEntries(seed.userId);
    expect(entries.has('manifest.json')).toBe(true);
    expect(ndjson(entries, 'accounts.ndjson')).toHaveLength(1);
  });

  it('names the download tradr-export-<UTC date>.zip (C9)', async () => {
    const seed = await seedFull();
    const { stream, filename } = await createExport(seed.userId);
    expect(filename).toMatch(/^tradr-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const today = new Date().toISOString().slice(0, 10);
    expect(filename).toBe(`tradr-export-${today}.zip`);
    await collect(stream); // drain to release the slot
  });
});
