import { createHash, randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate } from 'fflate';
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
  fillLotSelections,
  fillTransferLinks,
  fills,
  ledgerEntries,
  optionSettlementFills,
  optionSettlementRows,
  optionSettlements,
  positionEntryGreeks,
  positionGroups,
  positionImages,
  positionRolls,
  positionTags,
  positions,
  tags,
  tradingRules,
  users,
} from '@/db/schema';
import { createExport } from '@/features/account-data/export.service';
import { confirmImport } from '@/features/account-data/import.service';
import { sumPostedRealizedForPosition } from '@/features/accounting/accounting.query';
import { postFillLedgerEntries } from '@/features/accounting/ledger-hook';
import { findAccountsByUser } from '@/features/accounts/accounts.query';
import { getTaxSummary } from '@/features/expenses/expenses.service';
import { settleLeg, unsettle } from '@/features/positions/option-settlement.service';
import {
  addFillTx,
  createPositionTx,
  openPositionTx,
  replaceFillHook,
  unregisterFillHook,
} from '@/features/positions/positions.service';
import { ObjectUnreachableError, type ObjectStorage } from '@/lib/object-storage';
import { withTransaction } from '@/lib/transaction';

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

  // An account-scoped rule (currency matches the account) and a tag-scoped rule;
  // both scopes are remapped on import and must survive the round trip (Req 5.7).
  await db.insert(tradingRules).values({
    userId,
    type: 'max_position_size',
    params: { amount: '1000', currency: 'USD' },
    weight: 'important',
    accountId: main.id,
    tagId: null,
    dedupKey: `max_position_size|${main.id}|-|{"amount":"1000","currency":"USD"}`,
  });
  await db.insert(tradingRules).values({
    userId,
    type: 'required_fields',
    params: { fields: ['stop_loss'] },
    weight: 'nice_to_have',
    accountId: null,
    tagId: tag.id,
    dedupKey: `required_fields|-|${tag.id}|{"fields":["stop_loss"]}`,
  });

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
  for (const r of rowsOf(p, 'rules.ndjson')) {
    const def = r.definition as Row;
    const scope =
      r.accountId != null
        ? `a:${t.get(r.accountId as string)!}`
        : r.tagId != null
          ? `g:${t.get(r.tagId as string)!}`
          : 'global';
    set(r.id, `rule:${String(def.type)}:${scope}`);
  }
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
  'rules.ndjson',
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
    'rules.ndjson',
    rowsOf(p, 'rules.ndjson').map((r) => ({
      ...r,
      id: tok(t, r.id),
      accountId: nz(r.accountId),
      tagId: nz(r.tagId),
    })),
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

// --- tax-lot archive carry (design C12, AC 9.1-9.3) --------------------------

const LOT_TS = '2026-01-01T00:00:00.000000Z';

async function seedLotUser(prefix: string): Promise<{
  userId: string;
  entry1Id: string;
  entry2Id: string;
  exitId: string;
}> {
  const userId = await seedBareUser(prefix);
  const [acct] = await db
    .insert(accounts)
    .values({ userId, name: 'Main', currency: 'USD', startingBalance: '0' })
    .returning({ id: accounts.id });
  // eslint-disable-next-line no-restricted-syntax -- seed a fixed position for the lot-archive round-trip test
  const [pos] = await db
    .insert(positions)
    .values({ userId, accountId: acct.id, symbol: 'AAPL', side: 'long', assetType: 'stock' })
    .returning({ id: positions.id });
  const [entry1] = await db
    .insert(fills)
    .values({
      positionId: pos.id,
      type: 'entry',
      price: '10',
      quantity: '5',
      fees: '0',
      filledAt: new Date('2026-01-01T00:00:00Z'),
    })
    .returning({ id: fills.id });
  const [entry2] = await db
    .insert(fills)
    .values({
      positionId: pos.id,
      type: 'entry',
      price: '20',
      quantity: '5',
      fees: '0',
      filledAt: new Date('2026-01-05T00:00:00Z'),
    })
    .returning({ id: fills.id });
  const [exitFill] = await db
    .insert(fills)
    .values({
      positionId: pos.id,
      type: 'exit',
      price: '30',
      quantity: '5',
      fees: '0',
      filledAt: new Date('2026-02-01T00:00:00Z'),
    })
    .returning({ id: fills.id });
  // Pick the second, more expensive lot — not the FIFO-natural first one — so
  // losing the selection on round trip would change the realised gain (AC 9.2).
  await db
    .insert(fillLotSelections)
    .values({ exitFillId: exitFill.id, entryFillId: entry2.id, quantity: '5' });
  await db.update(users).set({ taxLotMethod: 'fifo' }).where(eq(users.id, userId));
  return { userId, entry1Id: entry1.id, entry2Id: entry2.id, exitId: exitFill.id };
}

describe('tax-lot archive carry (design C12, AC 9.1-9.3)', () => {
  it('carries the stored method and lot selection; import restores them against remapped fills and the tax summary matches (AC 9.1, AC 9.2)', async () => {
    const seedA = await seedLotUser('rt-lot-a');
    const bytesA = await exportBytes(seedA.userId);
    const parsedA = parseArchive(bytesA);

    expect(parsedA.preferences.taxLotMethod).toBe('fifo');
    const selectionsA = rowsOf(parsedA, 'lot-selections.ndjson');
    expect(selectionsA).toHaveLength(1);
    expect(selectionsA[0]).toMatchObject({
      exitFillId: seedA.exitId,
      entryFillId: seedA.entry2Id,
      quantity: '5.00000000',
    });

    const userB = await seedBareUser('rt-lot-b');
    await confirmImport(userB, streamOf(bytesA), digestOf(bytesA));

    const bytesB = await exportBytes(userB);
    const parsedB = parseArchive(bytesB);
    expect(parsedB.preferences.taxLotMethod).toBe('fifo');

    const selectionsB = rowsOf(parsedB, 'lot-selections.ndjson');
    expect(selectionsB).toHaveLength(1);
    const fillsB = rowsOf(parsedB, 'fills.ndjson');
    const exitB = fillsB.find((f) => f.type === 'exit');
    const entry2B = fillsB.find((f) => f.price === '20.00000000');

    // Remapped: a fresh id on B, never A's own id, but the relation holds.
    expect(selectionsB[0].exitFillId).toBe(exitB?.id);
    expect(selectionsB[0].entryFillId).toBe(entry2B?.id);
    expect(selectionsB[0].exitFillId).not.toBe(selectionsA[0].exitFillId);
    expect(selectionsB[0].entryFillId).not.toBe(selectionsA[0].entryFillId);
    expect(selectionsB[0].quantity).toBe(selectionsA[0].quantity);

    // AC 9.2 — losing the selection on import would fall back to the natural
    // FIFO lot (entry1, basis 10) and change the realised gain from 50 to 100.
    // Every realised figure must match; the fill/position/account ids are
    // per-user and legitimately differ under the id bijection, so blank them
    // before comparing the two summaries.
    const normalize = (s: Awaited<ReturnType<typeof getTaxSummary>>) => ({
      ...s,
      lotRealisations: s.lotRealisations.map((r) => ({
        ...r,
        accountId: 'X',
        positionId: 'X',
        exitFillId: 'X',
        entryFillId: 'X',
      })),
    });
    const summaryA = await getTaxSummary(seedA.userId, 2026);
    const summaryB = await getTaxSummary(userB, 2026);
    expect(normalize(summaryB)).toEqual(normalize(summaryA));
  });

  it('a version-2 archive imports with no selections and a null method (AC 9.3)', async () => {
    const accountId = randomUUID();
    const positionId = randomUUID();
    const counts = {
      brokerages: 0,
      systemBrokerages: 0,
      accounts: 1,
      tags: 0,
      positions: 1,
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
      archiveVersion: 2,
      sourceAppVersion: 'test',
      exportedAt: LOT_TS,
      counts,
      degradations: [] as unknown[],
    };
    const account = {
      id: accountId,
      name: 'Main',
      currency: 'USD',
      // accounts.timezone is NOT NULL, so a real export carries a zone; the
      // archive account schema requires one too.
      timezone: 'UTC',
      brokerage: null,
      startingBalance: '0.0000',
      defaultRiskPercent: null,
      isDemo: false,
      isDefault: true,
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    const position = {
      id: positionId,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      notes: null,
      targetPrice: null,
      stopLoss: null,
      openedAt: null,
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    // A version-2 preferences payload: no `taxLotMethod` key at all.
    const preferencesV2 = {
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

    function buildV2Archive(): Uint8Array {
      const entries: Array<{ name: string; data: string }> = [
        { name: 'manifest.json', data: JSON.stringify(manifest) },
        { name: 'accounts.ndjson', data: `${JSON.stringify(account)}\n` },
        { name: 'positions.ndjson', data: `${JSON.stringify(position)}\n` },
        { name: 'preferences.json', data: JSON.stringify(preferencesV2) },
        { name: 'dashboard-layout.json', data: 'null' },
      ];
      const out: Uint8Array[] = [];
      const z = new Zip((err, data) => {
        if (err) throw err;
        out.push(data);
      });
      for (const e of entries) {
        const f = new ZipDeflate(e.name, { level: 9 });
        z.add(f);
        f.push(new TextEncoder().encode(e.data), true);
      }
      z.end();
      return concat(out);
    }

    const bytes = buildV2Archive();
    const userB = await seedBareUser('rt-lot-v2');
    // Preset a non-null method so a null result after import proves the write
    // happened, rather than reading a column that was already null.
    await db.update(users).set({ taxLotMethod: 'fifo' }).where(eq(users.id, userB));

    await confirmImport(userB, streamOf(bytes), digestOf(bytes));

    const [row] = await db
      .select({ taxLotMethod: users.taxLotMethod })
      .from(users)
      .where(eq(users.id, userB));
    expect(row.taxLotMethod).toBeNull();

    const selectionRows = await db
      .select({ id: fillLotSelections.id })
      .from(fillLotSelections)
      .innerJoin(fills, eq(fills.id, fillLotSelections.exitFillId))
      .innerJoin(positions, eq(positions.id, fills.positionId))
      .where(eq(positions.userId, userB));
    expect(selectionRows).toHaveLength(0);
  });
});

// Design C8, AC 9.1-9.3 — each account's tax treatment and every transfer
// link travel with the archive and restore against the remapped fills.
async function seedTransferLinkUser(prefix: string): Promise<{
  userId: string;
  exitFillId: string;
  entryFillId: string;
}> {
  const userId = await seedBareUser(prefix);
  await db.update(users).set({ taxJurisdiction: 'CA' }).where(eq(users.id, userId));
  const [acctA] = await db
    .insert(accounts)
    .values({ userId, name: 'Taxable', currency: 'USD', startingBalance: '0' })
    .returning({ id: accounts.id });
  const [acctB] = await db
    .insert(accounts)
    .values({
      userId,
      name: 'Registered',
      currency: 'USD',
      startingBalance: '0',
      taxTreatment: 'registered',
    })
    .returning({ id: accounts.id });
  // eslint-disable-next-line no-restricted-syntax -- seed fixed positions for the transfer-link round-trip test
  const [posA] = await db
    .insert(positions)
    .values({ userId, accountId: acctA.id, symbol: 'XYZ', side: 'long', assetType: 'stock' })
    .returning({ id: positions.id });
  // eslint-disable-next-line no-restricted-syntax -- seed fixed positions for the transfer-link round-trip test
  const [posB] = await db
    .insert(positions)
    .values({ userId, accountId: acctB.id, symbol: 'XYZ', side: 'long', assetType: 'stock' })
    .returning({ id: positions.id });
  await db.insert(fills).values({
    positionId: posA.id,
    type: 'entry',
    price: '10',
    quantity: '100',
    fees: '0',
    filledAt: new Date('2026-01-01T00:00:00Z'),
  });
  const [exitA] = await db
    .insert(fills)
    .values({
      positionId: posA.id,
      type: 'exit',
      price: '50',
      quantity: '100',
      fees: '0',
      filledAt: new Date('2026-02-01T00:00:00Z'),
    })
    .returning({ id: fills.id });
  const [entryB] = await db
    .insert(fills)
    .values({
      positionId: posB.id,
      type: 'entry',
      price: '50',
      quantity: '100',
      fees: '0',
      filledAt: new Date('2026-02-01T00:00:00Z'),
    })
    .returning({ id: fills.id });
  await db.insert(fills).values({
    positionId: posB.id,
    type: 'exit',
    price: '80',
    quantity: '100',
    fees: '0',
    filledAt: new Date('2026-03-01T00:00:00Z'),
  });
  await db.insert(fillTransferLinks).values({
    userId,
    exitFillId: exitA.id,
    entryFillId: entryB.id,
  });
  return { userId, exitFillId: exitA.id, entryFillId: entryB.id };
}

describe('transfer-link archive carry (design C8, AC 9.1-9.3)', () => {
  it(
    "carries each account's tax treatment and every transfer link; import restores them " +
      'against the remapped fills and the tax summary matches (AC 9.1, AC 9.2)',
    async () => {
      const seedA = await seedTransferLinkUser('rt-link-a');
      const bytesA = await exportBytes(seedA.userId);
      const parsedA = parseArchive(bytesA);

      const accountsA = rowsOf(parsedA, 'accounts.ndjson');
      expect(accountsA.find((a) => a.name === 'Taxable')?.taxTreatment).toBe('taxable');
      expect(accountsA.find((a) => a.name === 'Registered')?.taxTreatment).toBe('registered');

      const linksA = rowsOf(parsedA, 'transfer-links.ndjson');
      expect(linksA).toHaveLength(1);
      expect(linksA[0]).toEqual({
        exitFillId: seedA.exitFillId,
        entryFillId: seedA.entryFillId,
      });

      const userB = await seedBareUser('rt-link-b');
      await confirmImport(userB, streamOf(bytesA), digestOf(bytesA));

      const bytesB = await exportBytes(userB);
      const parsedB = parseArchive(bytesB);

      const accountsB = rowsOf(parsedB, 'accounts.ndjson');
      expect(accountsB.find((a) => a.name === 'Taxable')?.taxTreatment).toBe('taxable');
      expect(accountsB.find((a) => a.name === 'Registered')?.taxTreatment).toBe('registered');

      const linksB = rowsOf(parsedB, 'transfer-links.ndjson');
      expect(linksB).toHaveLength(1);
      const fillsB = rowsOf(parsedB, 'fills.ndjson');
      const exitB = fillsB.find((f) => f.type === 'exit' && f.price === '50.00000000');
      const entryB = fillsB.find((f) => f.type === 'entry' && f.price === '50.00000000');

      // Remapped: fresh ids on B, never A's own ids, but the relation holds.
      expect(linksB[0].exitFillId).toBe(exitB?.id);
      expect(linksB[0].entryFillId).toBe(entryB?.id);
      expect(linksB[0].exitFillId).not.toBe(linksA[0].exitFillId);
      expect(linksB[0].entryFillId).not.toBe(linksA[0].entryFillId);

      const normalize = (s: Awaited<ReturnType<typeof getTaxSummary>>) => ({
        ...s,
        acbDispositions: s.acbDispositions.map((r) => ({
          ...r,
          exitFillId: 'X',
          positionId: 'X',
          accountId: 'X',
        })),
      });
      const summaryA = await getTaxSummary(seedA.userId, 2026);
      const summaryB = await getTaxSummary(userB, 2026);
      expect(normalize(summaryB)).toEqual(normalize(summaryA));
    },
  );

  it('a version-3 archive imports with every account taxable and no link (AC 9.3)', async () => {
    const accountId = randomUUID();
    const positionId = randomUUID();
    const counts = {
      brokerages: 0,
      systemBrokerages: 0,
      accounts: 1,
      tags: 0,
      positions: 1,
      fills: 0,
      lotSelections: 0,
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
      archiveVersion: 3,
      sourceAppVersion: 'test',
      exportedAt: LOT_TS,
      counts,
      degradations: [] as unknown[],
    };
    // A version-3 account row: no `taxTreatment` key at all.
    const account = {
      id: accountId,
      name: 'Main',
      currency: 'USD',
      timezone: 'UTC',
      brokerage: null,
      startingBalance: '0.0000',
      defaultRiskPercent: null,
      isDemo: false,
      isDefault: true,
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    const position = {
      id: positionId,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      notes: null,
      targetPrice: null,
      stopLoss: null,
      openedAt: null,
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    const preferencesV3 = {
      displayCurrency: null,
      timezone: null,
      taxJurisdiction: null,
      taxLotMethod: null,
      theme: 'system',
      buyingPowerBasis: 'cash',
      advisorDefaultPersona: null,
      advisorTradeDataConsent: false,
      writableAccountId: null,
      onboarding: {},
    };

    function buildV3Archive(): Uint8Array {
      const entries: Array<{ name: string; data: string }> = [
        { name: 'manifest.json', data: JSON.stringify(manifest) },
        { name: 'accounts.ndjson', data: `${JSON.stringify(account)}\n` },
        { name: 'positions.ndjson', data: `${JSON.stringify(position)}\n` },
        { name: 'preferences.json', data: JSON.stringify(preferencesV3) },
        { name: 'dashboard-layout.json', data: 'null' },
      ];
      const out: Uint8Array[] = [];
      const z = new Zip((err, data) => {
        if (err) throw err;
        out.push(data);
      });
      for (const e of entries) {
        const f = new ZipDeflate(e.name, { level: 9 });
        z.add(f);
        f.push(new TextEncoder().encode(e.data), true);
      }
      z.end();
      return concat(out);
    }

    const bytes = buildV3Archive();
    const userB = await seedBareUser('rt-link-v3');
    await confirmImport(userB, streamOf(bytes), digestOf(bytes));

    const [row] = await db
      .select({ taxTreatment: accounts.taxTreatment })
      .from(accounts)
      .where(eq(accounts.userId, userB));
    expect(row.taxTreatment).toBe('taxable');

    const linkRows = await db
      .select({ id: fillTransferLinks.id })
      .from(fillTransferLinks)
      .where(eq(fillTransferLinks.userId, userB));
    expect(linkRows).toHaveLength(0);
  });
});

async function seedGroupUser(prefix: string): Promise<{
  userId: string;
  groupId: string;
  legAId: string;
  legBId: string;
}> {
  const userId = await seedBareUser(prefix);
  const [acct] = await db
    .insert(accounts)
    .values({ userId, name: 'Main', currency: 'USD', startingBalance: '0' })
    .returning({ id: accounts.id });
  const [group] = await db
    .insert(positionGroups)
    .values({ userId, labelOverride: 'Iron Condor' })
    .returning({ id: positionGroups.id });
  // eslint-disable-next-line no-restricted-syntax -- seed fixed grouped legs for the group round-trip test
  const [legA] = await db
    .insert(positions)
    .values({
      userId,
      accountId: acct.id,
      groupId: group.id,
      symbol: 'XYZ',
      side: 'short',
      assetType: 'stock',
      status: 'closed',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatNetPnl: '125.0000',
    })
    .returning({ id: positions.id });
  // eslint-disable-next-line no-restricted-syntax -- seed fixed grouped legs for the group round-trip test
  const [legB] = await db
    .insert(positions)
    .values({
      userId,
      accountId: acct.id,
      groupId: group.id,
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatNetPnl: '-75.0000',
    })
    .returning({ id: positions.id });
  return { userId, groupId: group.id, legAId: legA.id, legBId: legB.id };
}

describe('position-group archive carry (design C11, AC 9.1-9.2)', () => {
  it(
    "carries a group, its legs' groupId and label override; import restores them " +
      'against remapped ids and the latched figures match (AC 9.1, AC 9.2)',
    async () => {
      const seedA = await seedGroupUser('rt-group-a');
      const bytesA = await exportBytes(seedA.userId);
      const parsedA = parseArchive(bytesA);

      const groupsA = rowsOf(parsedA, 'position-groups.ndjson');
      expect(groupsA).toHaveLength(1);
      expect(groupsA[0].labelOverride).toBe('Iron Condor');

      const legsA = rowsOf(parsedA, 'positions.ndjson');
      expect(legsA.every((p) => p.groupId === seedA.groupId)).toBe(true);

      const userB = await seedBareUser('rt-group-b');
      await confirmImport(userB, streamOf(bytesA), digestOf(bytesA));

      const bytesB = await exportBytes(userB);
      const parsedB = parseArchive(bytesB);

      const groupsB = rowsOf(parsedB, 'position-groups.ndjson');
      expect(groupsB).toHaveLength(1);
      expect(groupsB[0].labelOverride).toBe('Iron Condor');
      // Remapped: a fresh id on B, never A's own group id.
      expect(groupsB[0].id).not.toBe(seedA.groupId);

      const legsB = rowsOf(parsedB, 'positions.ndjson');
      expect(legsB).toHaveLength(2);
      expect(legsB.every((p) => p.groupId === groupsB[0].id)).toBe(true);

      // Latches travel on positions unchanged, so the legs' figures match
      // after import (AC 9.2).
      const pnlA = legsA.map((p) => p.lastFlatNetPnl).sort();
      const pnlB = legsB.map((p) => p.lastFlatNetPnl).sort();
      expect(pnlB).toEqual(pnlA);
    },
  );

  // Design C11, AC 9.3 — a version-4 archive carries no position-groups entry and
  // its positions have no groupId key; import restores each position ungrouped.
  it('a version-4 archive imports its positions ungrouped (AC 9.3)', async () => {
    const accountId = randomUUID();
    const positionId = randomUUID();
    const counts = {
      brokerages: 0,
      systemBrokerages: 0,
      accounts: 1,
      tags: 0,
      positions: 1,
      fills: 0,
      lotSelections: 0,
      transferLinks: 0,
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
      archiveVersion: 4,
      sourceAppVersion: 'test',
      exportedAt: LOT_TS,
      counts,
      degradations: [] as unknown[],
    };
    const account = {
      id: accountId,
      name: 'Main',
      currency: 'USD',
      timezone: 'UTC',
      brokerage: null,
      startingBalance: '0.0000',
      defaultRiskPercent: null,
      isDemo: false,
      isDefault: true,
      taxTreatment: 'taxable',
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    // A version-4 position row: no `groupId` key at all.
    const position = {
      id: positionId,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      notes: null,
      targetPrice: null,
      stopLoss: null,
      openedAt: null,
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    const preferencesV4 = {
      displayCurrency: null,
      timezone: null,
      taxJurisdiction: null,
      taxLotMethod: null,
      theme: 'system',
      buyingPowerBasis: 'cash',
      advisorDefaultPersona: null,
      advisorTradeDataConsent: false,
      writableAccountId: null,
      onboarding: {},
    };

    function buildV4Archive(): Uint8Array {
      const entries: Array<{ name: string; data: string }> = [
        { name: 'manifest.json', data: JSON.stringify(manifest) },
        { name: 'accounts.ndjson', data: `${JSON.stringify(account)}\n` },
        { name: 'positions.ndjson', data: `${JSON.stringify(position)}\n` },
        { name: 'preferences.json', data: JSON.stringify(preferencesV4) },
        { name: 'dashboard-layout.json', data: 'null' },
      ];
      const out: Uint8Array[] = [];
      const z = new Zip((err, data) => {
        if (err) throw err;
        out.push(data);
      });
      for (const e of entries) {
        const f = new ZipDeflate(e.name, { level: 9 });
        z.add(f);
        f.push(new TextEncoder().encode(e.data), true);
      }
      z.end();
      return concat(out);
    }

    const bytes = buildV4Archive();
    const userB = await seedBareUser('rt-group-v4');
    await confirmImport(userB, streamOf(bytes), digestOf(bytes));

    const [row] = await db
      .select({ groupId: positions.groupId })
      .from(positions)
      .where(eq(positions.userId, userB));
    expect(row.groupId).toBeNull();

    const groupRows = await db
      .select({ id: positionGroups.id })
      .from(positionGroups)
      .where(eq(positionGroups.userId, userB));
    expect(groupRows).toHaveLength(0);
  });
});

// --- option-lifecycle archive carry (design C14, AC 11.3) -------------------

const LIFECYCLE_SETTLE_SYMBOL = 'LFC260717C00150000';
const LIFECYCLE_ROLL_FROM_SYMBOL = 'RLF260117C00150000';
const LIFECYCLE_ROLL_TO_SYMBOL = 'RLT260217C00150000';
const LIFECYCLE_NULL_REF_SYMBOL = 'NUL260117C00150000';

async function realizedTotal(positionId: string, userId: string): Promise<string> {
  const { total } = await withTransaction(db, (tx) =>
    sumPostedRealizedForPosition(tx, { userId, positionId }),
  );
  return total.toString();
}

interface LifecycleSeed {
  userId: string;
  settleLegId: string;
  settlementId: string;
  rollFromId: string;
  rollToId: string;
  nullRefSettlementId: string;
}

// Seeds one of each design-C14 category for a fresh user: a real worthless
// settlement (via `settleLeg`, so `unsettle` has a genuine settlement to
// reverse), a roll and its entry Greeks (raw inserts — the export/import path
// is what's under test, not the roll/Greeks services), and a second
// settlement whose row and fill carry the null references a deleted touched
// row or fill leaves behind (design C14, SET NULL).
async function seedLifecycleUser(prefix: string): Promise<LifecycleSeed> {
  const userId = await seedBareUser(prefix);
  const [acct] = await db
    .insert(accounts)
    .values({ userId, name: 'Lifecycle', currency: 'USD', startingBalance: '0' })
    .returning({ id: accounts.id });
  const accountId = acct.id;

  const { legId: settleLegId } = await withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, userId, {
      accountId,
      symbol: LIFECYCLE_SETTLE_SYMBOL,
      side: 'short',
      assetType: 'option',
    });
    await addFillTx(tx, pos!.id, userId, {
      type: 'entry',
      price: '3',
      quantity: '5',
      fees: '0',
      filledAt: '2026-06-01T00:00:00.000Z',
    });
    await openPositionTx(tx, pos!.id, userId, '2026-06-01T00:00:00.000Z');
    return { legId: pos!.id };
  });
  const settlement = await settleLeg(db, userId, settleLegId, { outcome: 'worthless' });

  // eslint-disable-next-line no-restricted-syntax -- seed a fixed roll pair for the C14 archive-carry test
  const [rollFrom] = await db
    .insert(positions)
    .values({
      userId,
      accountId,
      symbol: LIFECYCLE_ROLL_FROM_SYMBOL,
      side: 'short',
      assetType: 'option',
      status: 'closed',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-10T00:00:00Z'),
    })
    .returning({ id: positions.id });
  // eslint-disable-next-line no-restricted-syntax -- seed a fixed roll pair for the C14 archive-carry test
  const [rollTo] = await db
    .insert(positions)
    .values({
      userId,
      accountId,
      symbol: LIFECYCLE_ROLL_TO_SYMBOL,
      side: 'short',
      assetType: 'option',
      status: 'open',
      openedAt: new Date('2026-01-10T00:00:00Z'),
    })
    .returning({ id: positions.id });
  const [rollExitFill] = await db
    .insert(fills)
    .values({
      positionId: rollFrom.id,
      type: 'exit',
      price: '1',
      quantity: '5',
      fees: '0',
      filledAt: new Date('2026-01-10T00:00:00Z'),
    })
    .returning({ id: fills.id });
  const [rollEntryFill] = await db
    .insert(fills)
    .values({
      positionId: rollTo.id,
      type: 'entry',
      price: '2',
      quantity: '5',
      fees: '0',
      filledAt: new Date('2026-01-10T00:00:00Z'),
    })
    .returning({ id: fills.id });
  await db.insert(positionRolls).values({
    userId,
    chainId: randomUUID(),
    fromPositionId: rollFrom.id,
    toPositionId: rollTo.id,
    exitFillId: rollExitFill.id,
    entryFillId: rollEntryFill.id,
    rolledAt: new Date('2026-01-10T00:00:00Z'),
  });

  await db.insert(positionEntryGreeks).values({
    positionId: rollTo.id,
    delta: '0.52',
    gamma: '0.013',
    thetaPerDay: '-0.045',
    vegaPerPct: '0.09',
    rhoPerPct: null,
    source: 'black_scholes',
    volatility: '0.28',
    spot: '160',
    rate: '0.045',
    dividendYield: null,
    capturedAt: new Date('2026-01-10T00:00:00Z'),
  });

  // eslint-disable-next-line no-restricted-syntax -- seed a throwaway leg for the null-reference case
  const [nullRefLeg] = await db
    .insert(positions)
    .values({
      userId,
      accountId,
      symbol: LIFECYCLE_NULL_REF_SYMBOL,
      side: 'short',
      assetType: 'option',
      status: 'closed',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-01T00:00:00Z'),
    })
    .returning({ id: positions.id });
  const [nullRefSettlement] = await db
    .insert(optionSettlements)
    .values({
      userId,
      positionId: nullRefLeg.id,
      outcome: 'worthless',
      quantity: '1',
      premium: '0',
      settledAt: new Date('2026-01-01T00:00:00Z'),
    })
    .returning({ id: optionSettlements.id });
  await db.insert(optionSettlementRows).values({
    settlementId: nullRefSettlement.id,
    positionId: null,
    touch: 'stock_exit',
    closedRow: true,
    priorLastFlatAt: null,
    priorLastFlatNetPnl: null,
  });
  await db.insert(optionSettlementFills).values({
    settlementId: nullRefSettlement.id,
    fillId: null,
    written: false,
  });

  return {
    userId,
    settleLegId,
    settlementId: settlement.settlementId,
    rollFromId: rollFrom.id,
    rollToId: rollTo.id,
    nullRefSettlementId: nullRefSettlement.id,
  };
}

describe('option-lifecycle archive carry (design C14, AC 11.3)', () => {
  it(
    'exports a settlement, a roll and entry Greeks with a null reference carried as null; ' +
      'import restores them with remapped ids, and unsettle on the imported account nets ' +
      'fills and ledger back to the pre-settlement net',
    async () => {
      replaceFillHook('ledger', postFillLedgerEntries);
      try {
        const seedA = await seedLifecycleUser('rt-lifecycle-a');

        const bytesA = await exportBytes(seedA.userId);
        const parsedA = parseArchive(bytesA);

        expect(rowsOf(parsedA, 'option-settlements.ndjson')).toHaveLength(2);
        expect(rowsOf(parsedA, 'option-settlement-rows.ndjson')).toHaveLength(2);
        // The worthless settlement writes two settlement fills — a written exit
        // and a baseline snapshot of the entry (option-settlement.test.ts:584-592)
        // — plus the null-reference settlement's one fill: three in all.
        expect(rowsOf(parsedA, 'option-settlement-fills.ndjson')).toHaveLength(3);
        expect(rowsOf(parsedA, 'position-rolls.ndjson')).toHaveLength(1);
        expect(rowsOf(parsedA, 'entry-greeks.ndjson')).toHaveLength(1);

        // A null row/fill reference (the shape a deleted touched row or fill
        // leaves behind) carries through the export unchanged (design C14).
        const nullRowA = rowsOf(parsedA, 'option-settlement-rows.ndjson').find(
          (r) => r.settlementId === seedA.nullRefSettlementId,
        );
        expect(nullRowA?.positionId).toBeNull();
        const nullFillA = rowsOf(parsedA, 'option-settlement-fills.ndjson').find(
          (r) => r.settlementId === seedA.nullRefSettlementId,
        );
        expect(nullFillA?.fillId).toBeNull();

        const userB = await seedBareUser('rt-lifecycle-b');
        await confirmImport(userB, streamOf(bytesA), digestOf(bytesA));

        // Import restores every row with a fresh, remapped id — never A's own.
        const settlementsB = await db
          .select()
          .from(optionSettlements)
          .where(eq(optionSettlements.userId, userB));
        expect(settlementsB).toHaveLength(2);
        expect(settlementsB.map((r) => r.id)).not.toContain(seedA.settlementId);
        expect(settlementsB.map((r) => r.id)).not.toContain(seedA.nullRefSettlementId);

        const rollsB = await db.select().from(positionRolls).where(eq(positionRolls.userId, userB));
        expect(rollsB).toHaveLength(1);
        expect(rollsB[0]!.fromPositionId).not.toBe(seedA.rollFromId);

        const [rollFromB] = await db
          .select({ id: positions.id })
          .from(positions)
          .where(
            and(eq(positions.userId, userB), eq(positions.symbol, LIFECYCLE_ROLL_FROM_SYMBOL)),
          );
        const [rollToB] = await db
          .select({ id: positions.id })
          .from(positions)
          .where(and(eq(positions.userId, userB), eq(positions.symbol, LIFECYCLE_ROLL_TO_SYMBOL)));
        expect(rollsB[0]!.fromPositionId).toBe(rollFromB!.id);
        expect(rollsB[0]!.toPositionId).toBe(rollToB!.id);

        const [greeksB] = await db
          .select()
          .from(positionEntryGreeks)
          .where(eq(positionEntryGreeks.positionId, rollToB!.id));
        expect(greeksB).toBeDefined();
        expect(greeksB!.source).toBe('black_scholes');

        // The null reference stays null after import too.
        const settleRowB = await db
          .select()
          .from(positions)
          .where(and(eq(positions.userId, userB), eq(positions.symbol, LIFECYCLE_SETTLE_SYMBOL)));
        const legB = settleRowB[0]!;
        const realSettlementB = settlementsB.find((r) => r.positionId === legB.id)!;
        const nullSettlementRowB = settlementsB.find((r) => r.id !== realSettlementB.id)!;

        const [nullRowB] = await db
          .select()
          .from(optionSettlementRows)
          .where(eq(optionSettlementRows.settlementId, nullSettlementRowB.id));
        expect(nullRowB!.positionId).toBeNull();
        const [nullFillB] = await db
          .select()
          .from(optionSettlementFills)
          .where(eq(optionSettlementFills.settlementId, nullSettlementRowB.id));
        expect(nullFillB!.fillId).toBeNull();

        // Unsettle on the imported account: fills and the posted ledger total
        // return to the pre-settlement net (AC 11.3).
        const fillsBefore = await db.select().from(fills).where(eq(fills.positionId, legB.id));
        expect(fillsBefore).toHaveLength(2);
        const realizedBefore = await realizedTotal(legB.id, userB);
        expect(realizedBefore).not.toBe('0');

        await unsettle(db, userB, legB.id, realSettlementB.id);

        const fillsAfter = await db.select().from(fills).where(eq(fills.positionId, legB.id));
        expect(fillsAfter).toHaveLength(1);
        expect(fillsAfter[0]!.type).toBe('entry');

        const legRowAfter = await db.select().from(positions).where(eq(positions.id, legB.id));
        expect(legRowAfter[0]!.status).toBe('open');
        expect(legRowAfter[0]!.closedAt).toBeNull();

        expect(await realizedTotal(legB.id, userB)).toBe('0');
      } finally {
        unregisterFillHook('ledger');
      }
    },
  );

  // Design C14, AC 11.3 — a version-5 archive carries none of the five new
  // entries; import restores the archive's own data and creates none of them.
  it('a version-5 archive still imports (AC 11.3)', async () => {
    const accountId = randomUUID();
    const positionId = randomUUID();
    const counts = {
      brokerages: 0,
      systemBrokerages: 0,
      accounts: 1,
      tags: 0,
      positionGroups: 0,
      positions: 1,
      fills: 0,
      lotSelections: 0,
      transferLinks: 0,
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
      archiveVersion: 5,
      sourceAppVersion: 'test',
      exportedAt: LOT_TS,
      counts,
      degradations: [] as unknown[],
    };
    const account = {
      id: accountId,
      name: 'Main',
      currency: 'USD',
      timezone: 'UTC',
      brokerage: null,
      startingBalance: '0.0000',
      defaultRiskPercent: null,
      isDemo: false,
      isDefault: true,
      taxTreatment: 'taxable',
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    const position = {
      id: positionId,
      accountId,
      groupId: null,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      notes: null,
      targetPrice: null,
      stopLoss: null,
      openedAt: null,
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      createdAt: LOT_TS,
      updatedAt: LOT_TS,
    };
    const preferencesV5 = {
      displayCurrency: null,
      timezone: null,
      taxJurisdiction: null,
      taxLotMethod: null,
      theme: 'system',
      buyingPowerBasis: 'cash',
      advisorDefaultPersona: null,
      advisorTradeDataConsent: false,
      writableAccountId: null,
      onboarding: {},
    };

    function buildV5Archive(): Uint8Array {
      const entries: Array<{ name: string; data: string }> = [
        { name: 'manifest.json', data: JSON.stringify(manifest) },
        { name: 'accounts.ndjson', data: `${JSON.stringify(account)}\n` },
        { name: 'positions.ndjson', data: `${JSON.stringify(position)}\n` },
        { name: 'preferences.json', data: JSON.stringify(preferencesV5) },
        { name: 'dashboard-layout.json', data: 'null' },
      ];
      const out: Uint8Array[] = [];
      const z = new Zip((err, data) => {
        if (err) throw err;
        out.push(data);
      });
      for (const e of entries) {
        const f = new ZipDeflate(e.name, { level: 9 });
        z.add(f);
        f.push(new TextEncoder().encode(e.data), true);
      }
      z.end();
      return concat(out);
    }

    const bytes = buildV5Archive();
    const userB = await seedBareUser('rt-v5-c14');
    await confirmImport(userB, streamOf(bytes), digestOf(bytes));

    const posRows = await db
      .select({ id: positions.id })
      .from(positions)
      .where(eq(positions.userId, userB));
    expect(posRows).toHaveLength(1);

    const settlementRows = await db
      .select()
      .from(optionSettlements)
      .where(eq(optionSettlements.userId, userB));
    expect(settlementRows).toHaveLength(0);

    const rollRows = await db.select().from(positionRolls).where(eq(positionRolls.userId, userB));
    expect(rollRows).toHaveLength(0);
  });
});
