import { createHash, randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import {
  accounts,
  advisorConversations,
  advisorMessages,
  advisorPersonas,
  advisorSummaries,
  brokerages,
  dashboardLayouts,
  exchangeRates,
  expenses,
  feeSchedules,
  fills,
  ledgerEntries,
  positionImages,
  positionTags,
  positions,
  tags,
  users,
} from '@/db/schema';
import { createExport } from '@/features/account-data/export.service';
import { confirmImport } from '@/features/account-data/import.service';
import { findAccountsByUser } from '@/features/accounts/accounts.query';
import { ObjectUnreachableError, type ObjectStorage } from '@/lib/object-storage';

// Req 3.7 and 5.7 — the byte-equal round trip. Seed user A with every archive
// category (tied message `created_at` values, all seven ledger types with a
// reversal group, a demo account, both image homes), export it, import into an
// empty user B, export B, and prove the two archives' payloads are equal under
// one consistent identifier bijection (per-entry multisets, messages as
// per-conversation sequences, every numeric/timestamp/jsonb value equal), with
// manifest metadata excluded. Each account's derived balance, cash and position
// value (`findAccountsByUser`) and each position's latched P&L match across the
// round trip. The second run adds a storage double on the EXPORT side only — the
// decomposition's hosted-to-self-host scenario — where B's images arrive inline.
//
// Runs under the single-connection rollback harness (test-setup.ts): the export's
// read-only snapshot and the import's write transaction are nested savepoints on
// one connection, awaited in turn, so no lock is ever contended.

// getObjectStorage is swapped for a getter over a mutable holder, so one test can
// export A through a fake bucket and then import/export B with none configured.
const bucket = vi.hoisted(() => ({ current: null as ObjectStorage | null }));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  return { ...actual, getObjectStorage: () => bucket.current };
});

const ADVISOR_KEY = 'advisor/seed/img-advisor';
const POSITION_KEY = 'positions/seed/img-position';
const ADVISOR_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const POSITION_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7]);

// A tied instant shared by the three seeded messages, so the archive exercises
// the equal-`created_at` ordering rule (Req 5.5).
const TIED_TS = sql`timestamptz '2026-02-03 04:05:06.654321+00'`;

type Row = Record<string, unknown>;
type ImageMode = 'inline' | 'pointer';

// --- fake object storage (pointer mode, export side) -------------------------

function fakeBucket(): ObjectStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>([
    [ADVISOR_KEY, { bytes: ADVISOR_BYTES, contentType: 'image/png' }],
    [POSITION_KEY, { bytes: POSITION_BYTES, contentType: 'image/png' }],
  ]);
  return {
    put: () => Promise.resolve(),
    get: (key: string) => {
      const o = objects.get(key);
      if (!o) throw new ObjectUnreachableError(`gone: ${key}`, { name: 'NoSuchKey' });
      return Promise.resolve({ bytes: o.bytes, contentType: o.contentType });
    },
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
}

beforeEach(() => {
  bucket.current = null;
});

// --- seed a full-surface user ------------------------------------------------

function imagePart(mode: ImageMode, which: 'advisor' | 'position'): Row {
  if (mode === 'inline') {
    const bytes = which === 'advisor' ? ADVISOR_BYTES : POSITION_BYTES;
    return { type: 'image', format: 'png', dataBase64: Buffer.from(bytes).toString('base64') };
  }
  const key = which === 'advisor' ? ADVISOR_KEY : POSITION_KEY;
  return { type: 'image', format: 'png', storage: { kind: 'object', key } };
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

async function seedBareUser(prefix: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${prefix}-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return u.id;
}

async function seedUserA(mode: ImageMode): Promise<string> {
  const userId = await seedBareUser('rt-a');

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

  const [main] = await db
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

  // A demo account (Req seed): not default, so the "no default demo" invariant holds.
  await db.insert(accounts).values({
    userId,
    name: 'Demo',
    currency: 'USD',
    startingBalance: '500.00',
    isDemo: true,
    isDefault: false,
  });

  const [tag] = await db
    .insert(tags)
    .values({ userId, name: 'Breakout', category: 'setup', color: '#ffffff' })
    .returning({ id: tags.id });

  // eslint-disable-next-line no-restricted-syntax -- seed a fixed closed position for the round-trip test
  const [pos] = await db
    .insert(positions)
    .values({
      userId,
      accountId: main.id,
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
  await db.insert(positionImages).values({ positionId: pos.id, part: imagePart(mode, 'position') });

  // All seven ledger types, each its own group; the two reversal-of-pnl and
  // deposit/withdrawal reversals point back at an earlier group.
  const g = LEDGER_TYPES.map(() => randomUUID());
  for (let i = 0; i < LEDGER_TYPES.length; i++) {
    const type = LEDGER_TYPES[i];
    const isPnl = type === 'position_pnl' || type === 'position_pnl_reversal';
    await db.insert(ledgerEntries).values({
      userId,
      accountId: main.id,
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
      writableAccountId: main.id,
    })
    .where(eq(users.id, userId));

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

  // Three messages sharing one instant: their archive order is decided by id, and
  // the restore must reproduce that order (Req 5.5). The advisor image rides m1.
  const mk = (parts: Row[]) =>
    db
      .insert(advisorMessages)
      .values({
        conversationId: conv.id,
        role: 'user',
        contentParts: parts,
        promptTokens: null,
        completionTokens: null,
        clientMessageId: null,
        createdAt: TIED_TS,
      })
      .returning({ id: advisorMessages.id });

  await mk([{ type: 'text', text: 'one' }, imagePart(mode, 'advisor')]);
  const [m2] = await mk([{ type: 'text', text: 'two' }]);
  await mk([{ type: 'text', text: 'three' }]);

  await db.insert(advisorSummaries).values({
    conversationId: conv.id,
    prose: 'a summary',
    tradeDataFigures: null,
    coveredThroughMessageId: m2.id,
    coveredThroughCreatedAt: new Date('2026-02-03T04:05:06Z'),
  });

  await db.insert(dashboardLayouts).values({
    userId,
    widgets: [{ id: randomUUID(), type: 'open-positions', x: 0, y: 0, w: 4, h: 4 }],
  });

  return userId;
}

// --- zip reading -------------------------------------------------------------

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

async function exportBytes(userId: string): Promise<Uint8Array> {
  const { stream } = await createExport(userId);
  return collect(stream);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
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

// --- archive parsing ---------------------------------------------------------

interface Parsed {
  rows: Map<string, Row[]>;
  preferences: Row;
  layout: unknown;
  images: Map<string, Uint8Array>;
}

function parseArchive(bytes: Uint8Array): Parsed {
  const entries = inflate(bytes);
  const rows = new Map<string, Row[]>();
  const images = new Map<string, Uint8Array>();
  let preferences: Row = {};
  let layout: unknown = null;
  const decode = (data: Uint8Array): string => new TextDecoder().decode(data);
  for (const [name, data] of entries) {
    if (name.startsWith('images/')) {
      images.set(name, data);
    } else if (name === 'manifest.json') {
      // metadata, excluded from the comparison (Req 3.7)
    } else if (name === 'preferences.json') {
      preferences = JSON.parse(decode(data)) as Row;
    } else if (name === 'dashboard-layout.json') {
      layout = JSON.parse(decode(data));
    } else if (name.endsWith('.ndjson')) {
      rows.set(
        name,
        decode(data)
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Row),
      );
    }
  }
  return { rows, preferences, layout, images };
}

const rowsOf = (p: Parsed, name: string): Row[] => p.rows.get(name) ?? [];

// --- identifier bijection via natural keys (all preserved across the remap) --

// Each entity's own id maps to a content-derived token; the same seed content on
// both sides yields the same token, so applying each archive's own map produces
// canonical payloads that must be identical if the remap was consistent.
function buildIdTokens(p: Parsed): Map<string, string> {
  const t = new Map<string, string>();
  const set = (id: unknown, token: string): void => {
    if (typeof id === 'string') t.set(id, token);
  };

  for (const r of rowsOf(p, 'brokerages.ndjson')) set(r.id, `brokerage:${String(r.name)}`);
  for (const r of rowsOf(p, 'accounts.ndjson')) set(r.id, `account:${String(r.name)}`);
  for (const r of rowsOf(p, 'tags.ndjson')) set(r.id, `tag:${String(r.name)}`);
  for (const r of rowsOf(p, 'personas.ndjson')) set(r.id, `persona:${String(r.name)}`);
  for (const r of rowsOf(p, 'positions.ndjson')) set(r.id, `position:${String(r.symbol)}`);
  for (const r of rowsOf(p, 'conversations.ndjson')) set(r.id, `conversation:${String(r.title)}`);
  for (const r of rowsOf(p, 'exchange-rates.ndjson')) {
    set(
      r.id,
      `rate:${String(r.baseCurrency)}/${String(r.quoteCurrency)}/${String(r.effectiveDate)}`,
    );
  }
  for (const r of rowsOf(p, 'expenses.ndjson')) {
    set(r.id, `expense:${String(r.category)}/${String(r.occurredAt)}/${String(r.description)}`);
  }

  // dependent on the entity tokens above
  for (const r of rowsOf(p, 'fills.ndjson')) {
    set(r.id, `fill:${t.get(r.positionId as string)!}/${String(r.filledAt)}/${String(r.price)}`);
  }
  for (const r of rowsOf(p, 'position-images.ndjson')) {
    set(r.id, `pimg:${t.get(r.positionId as string)!}/${String(r.createdAt)}`);
  }
  for (const r of rowsOf(p, 'ledger-entries.ndjson')) {
    set(r.id, `ledger:${String(r.entryType)}`);
    set(r.groupId, `lgroup:${String(r.entryType)}`);
  }
  const perConversation = new Map<string, number>();
  for (const r of rowsOf(p, 'messages.ndjson')) {
    const cid = r.conversationId as string;
    const index = perConversation.get(cid) ?? 0;
    perConversation.set(cid, index + 1);
    set(r.id, `msg:${t.get(cid)!}:${index}`);
  }
  for (const r of rowsOf(p, 'summaries.ndjson')) {
    set(r.id, `summary:${t.get(r.conversationId as string)!}`);
  }
  return t;
}

function tok(t: Map<string, string>, id: unknown): string {
  const token = t.get(id as string);
  if (token === undefined) throw new Error(`no token for id ${String(id)}`);
  return token;
}

function tokPersona(t: Map<string, string>, ref: unknown): unknown {
  if (ref === null || ref === undefined) return null;
  const o = ref as Record<string, unknown>;
  return 'user' in o ? { user: tok(t, o.user) } : { builtin: o.builtin };
}

function tokBrokerage(t: Map<string, string>, ref: unknown): unknown {
  if (ref === null || ref === undefined) return null;
  const o = ref as Record<string, unknown>;
  return 'user' in o ? { user: tok(t, o.user) } : { system: o.system };
}

interface Canon {
  multiset: Map<string, Row[]>;
  messagesByConversation: Map<string, Row[]>;
  preferences: Row;
  layout: unknown;
  images: Map<string, Uint8Array>;
}

// Every entry compared as an unordered multiset (messages excepted).
const MULTISET_ENTRIES = [
  'brokerages.ndjson',
  'system-brokerages.ndjson',
  'accounts.ndjson',
  'tags.ndjson',
  'positions.ndjson',
  'fills.ndjson',
  'position-tags.ndjson',
  'position-images.ndjson',
  'ledger-entries.ndjson',
  'exchange-rates.ndjson',
  'expenses.ndjson',
  'personas.ndjson',
  'builtin-personas.ndjson',
  'conversations.ndjson',
  'summaries.ndjson',
];

function canonicalize(p: Parsed): Canon {
  const t = buildIdTokens(p);
  const nz = (id: unknown): unknown => (id === null || id === undefined ? null : tok(t, id));
  const m = new Map<string, Row[]>();

  m.set(
    'brokerages.ndjson',
    rowsOf(p, 'brokerages.ndjson').map((r) => ({ ...r, id: tok(t, r.id) })),
  );
  m.set('system-brokerages.ndjson', rowsOf(p, 'system-brokerages.ndjson')); // no identifiers
  m.set(
    'accounts.ndjson',
    rowsOf(p, 'accounts.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      brokerage: tokBrokerage(t, r.brokerage),
    })),
  );
  m.set(
    'tags.ndjson',
    rowsOf(p, 'tags.ndjson').map((r) => ({ ...r, id: tok(t, r.id) })),
  );
  m.set(
    'positions.ndjson',
    rowsOf(p, 'positions.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      accountId: tok(t, r.accountId),
    })),
  );
  m.set(
    'fills.ndjson',
    rowsOf(p, 'fills.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      positionId: tok(t, r.positionId),
    })),
  );
  m.set(
    'position-tags.ndjson',
    rowsOf(p, 'position-tags.ndjson').map((r) => ({
      positionId: tok(t, r.positionId),
      tagId: tok(t, r.tagId),
    })),
  );
  m.set(
    'position-images.ndjson',
    rowsOf(p, 'position-images.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      positionId: tok(t, r.positionId),
    })),
  );
  m.set(
    'ledger-entries.ndjson',
    rowsOf(p, 'ledger-entries.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      accountId: tok(t, r.accountId),
      positionId: nz(r.positionId),
      groupId: tok(t, r.groupId),
      reversesGroupId: nz(r.reversesGroupId),
    })),
  );
  m.set(
    'exchange-rates.ndjson',
    rowsOf(p, 'exchange-rates.ndjson').map((r) => ({ ...r, id: tok(t, r.id) })),
  );
  m.set(
    'expenses.ndjson',
    rowsOf(p, 'expenses.ndjson').map((r) => ({ ...r, id: tok(t, r.id) })),
  );
  m.set(
    'personas.ndjson',
    rowsOf(p, 'personas.ndjson').map((r) => ({ ...r, id: tok(t, r.id) })),
  );
  m.set('builtin-personas.ndjson', rowsOf(p, 'builtin-personas.ndjson')); // platform ids, identity
  m.set(
    'conversations.ndjson',
    rowsOf(p, 'conversations.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      persona: tokPersona(t, r.persona),
    })),
  );
  m.set(
    'summaries.ndjson',
    rowsOf(p, 'summaries.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      conversationId: tok(t, r.conversationId),
      coveredThroughMessageId: nz(r.coveredThroughMessageId),
    })),
  );

  const messagesByConversation = new Map<string, Row[]>();
  for (const r of rowsOf(p, 'messages.ndjson')) {
    const ctok = tok(t, r.conversationId);
    const canon: Row = { ...r, id: tok(t, r.id), conversationId: ctok };
    const list = messagesByConversation.get(ctok) ?? [];
    list.push(canon);
    messagesByConversation.set(ctok, list);
  }

  const preferences: Row = {
    ...p.preferences,
    advisorDefaultPersona: tokPersona(t, p.preferences.advisorDefaultPersona),
    writableAccountId: nz(p.preferences.writableAccountId),
  };
  // Deliberately excluded: the target keeps its own consent value (Req 5.6).
  delete preferences.advisorTradeDataConsent;

  return { multiset: m, messagesByConversation, preferences, layout: p.layout, images: p.images };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function sorted(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function compareCanon(a: Canon, b: Canon): void {
  for (const entry of MULTISET_ENTRIES) {
    expect(sorted(a.multiset.get(entry) ?? [])).toEqual(sorted(b.multiset.get(entry) ?? []));
  }
  expect([...a.messagesByConversation.keys()].sort()).toEqual(
    [...b.messagesByConversation.keys()].sort(),
  );
  for (const conv of a.messagesByConversation.keys()) {
    // Ordered: the per-conversation sequence, tied `created_at` included.
    expect(a.messagesByConversation.get(conv)).toEqual(b.messagesByConversation.get(conv));
  }
  expect(a.preferences).toEqual(b.preferences);
  expect(a.layout).toEqual(b.layout);
  expect([...a.images.keys()].sort()).toEqual([...b.images.keys()].sort());
  for (const key of a.images.keys()) {
    expect([...a.images.get(key)!]).toEqual([...b.images.get(key)!]);
  }
}

// --- derived-value snapshots -------------------------------------------------

async function accountSnapshot(
  userId: string,
): Promise<Record<string, { balance: unknown; cash: unknown; positionValue: unknown }>> {
  const rows = await findAccountsByUser(db, userId);
  const out: Record<string, { balance: unknown; cash: unknown; positionValue: unknown }> = {};
  for (const a of rows) {
    out[a.name] = { balance: a.balance, cash: a.cash, positionValue: a.positionValue };
  }
  return out;
}

async function positionSnapshot(
  userId: string,
): Promise<Array<{ symbol: string; lastFlatAt: string | null; lastFlatNetPnl: string | null }>> {
  const rows = (await db.execute(sql`
    SELECT symbol,
      to_char(last_flat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastFlatAt",
      last_flat_net_pnl::text AS "lastFlatNetPnl"
    FROM positions WHERE user_id = ${userId} ORDER BY symbol
  `)) as unknown as Array<{
    symbol: string;
    lastFlatAt: string | null;
    lastFlatNetPnl: string | null;
  }>;
  return rows;
}

async function runRoundTrip(mode: ImageMode): Promise<{ userB: string }> {
  bucket.current = mode === 'pointer' ? fakeBucket() : null;
  const userA = await seedUserA(mode);
  const bytesA = await exportBytes(userA);
  const accountsA = await accountSnapshot(userA);
  const positionsA = await positionSnapshot(userA);

  // The self-host target: no storage for the import or B's export.
  bucket.current = null;
  const userB = await seedBareUser('rt-b');
  await confirmImport(userB, streamOf(bytesA), digestOf(bytesA));

  const bytesB = await exportBytes(userB);
  const accountsB = await accountSnapshot(userB);
  const positionsB = await positionSnapshot(userB);

  compareCanon(canonicalize(parseArchive(bytesA)), canonicalize(parseArchive(bytesB)));

  // Req 5.7: each account's derived money and each position's latched P&L match.
  expect(accountsB).toEqual(accountsA);
  expect(positionsB).toEqual(positionsA);

  return { userB };
}

describe('account-data round trip (Req 3.7, 5.7)', () => {
  it('A → B → export B is payload-equal under the id bijection (inline images)', async () => {
    await runRoundTrip('inline');
  });

  it('exports A through a storage double, imports into self-hosted B inline (Req 7.1)', async () => {
    const { userB } = await runRoundTrip('pointer');

    // B ran with no storage configured, so its images landed inline, not as pointers.
    const [img] = await db
      .select({ part: positionImages.part })
      .from(positionImages)
      .innerJoin(positions, eq(positions.id, positionImages.positionId))
      .where(eq(positions.userId, userB));
    const part = img.part as Record<string, unknown>;
    expect(typeof part.dataBase64).toBe('string');
    expect('storage' in part).toBe(false);
  });
});
