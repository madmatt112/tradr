import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArchiveEmptyError, ArchiveInvalidError } from './account-data.errors';
import { validateArchive } from './import-validation.service';

// C5 validator tests. Every archive is built with task 1's fflate writer, spooled to
// a temp file, then validated. The manifest counts are computed from the row arrays
// so a fault is what the test injects, not accounting drift (design C5, Req 4.1-4.5).

const TS = '2026-01-01T00:00:00.000000Z';
const DATE = '2026-01-01';

interface Entry {
  name: string;
  data: Uint8Array | string;
}

function buildZip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(Buffer.from(data));
  });
  for (const e of entries) {
    const store = e.name.startsWith('images/');
    const bytes = typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data;
    const f = store ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: 9 });
    zip.add(f);
    f.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

const NDJSON_ORDER: Array<[keyof Spec, string, string]> = [
  ['brokerages', 'brokerages.ndjson', 'brokerages'],
  ['systemBrokerages', 'system-brokerages.ndjson', 'systemBrokerages'],
  ['accounts', 'accounts.ndjson', 'accounts'],
  ['tags', 'tags.ndjson', 'tags'],
  ['positions', 'positions.ndjson', 'positions'],
  ['fills', 'fills.ndjson', 'fills'],
  ['positionTags', 'position-tags.ndjson', 'positionTags'],
  ['positionImages', 'position-images.ndjson', 'positionImages'],
  ['ledgerEntries', 'ledger-entries.ndjson', 'ledgerEntries'],
  ['exchangeRates', 'exchange-rates.ndjson', 'exchangeRates'],
  ['expenses', 'expenses.ndjson', 'expenses'],
  ['personas', 'personas.ndjson', 'personas'],
  ['builtinPersonas', 'builtin-personas.ndjson', 'builtinPersonas'],
  ['conversations', 'conversations.ndjson', 'conversations'],
  ['messages', 'messages.ndjson', 'messages'],
  ['summaries', 'summaries.ndjson', 'summaries'],
];

interface Spec {
  images?: Array<{ name: string; bytes: Uint8Array }>;
  brokerages?: unknown[];
  systemBrokerages?: unknown[];
  accounts?: unknown[];
  tags?: unknown[];
  positions?: unknown[];
  fills?: unknown[];
  positionTags?: unknown[];
  positionImages?: unknown[];
  ledgerEntries?: unknown[];
  exchangeRates?: unknown[];
  expenses?: unknown[];
  personas?: unknown[];
  builtinPersonas?: unknown[];
  conversations?: unknown[];
  messages?: unknown[];
  summaries?: unknown[];
  preferences?: unknown;
  dashboardLayout?: unknown;
  degradations?: unknown[];
  countsOverride?: Record<string, number>;
  omitManifest?: boolean;
}

function makeArchive(spec: Spec): Buffer {
  const entries: Entry[] = [];
  for (const img of spec.images ?? []) entries.push({ name: img.name, data: img.bytes });

  const counts: Record<string, number> = {
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
    images: spec.images?.length ?? 0,
  };
  Object.assign(counts, spec.countsOverride ?? {});

  if (!spec.omitManifest) {
    entries.push({
      name: 'manifest.json',
      data: JSON.stringify({
        format: 'tradr-account-archive',
        archiveVersion: 1,
        sourceAppVersion: 'test',
        exportedAt: TS,
        counts,
        degradations: spec.degradations ?? [],
      }),
    });
  }

  for (const [key, file] of NDJSON_ORDER) {
    const rows = spec[key] as unknown[] | undefined;
    if (rows && rows.length > 0) {
      entries.push({ name: file, data: rows.map((r) => JSON.stringify(r)).join('\n') + '\n' });
    }
  }

  if ('preferences' in spec) {
    entries.push({ name: 'preferences.json', data: JSON.stringify(spec.preferences) });
  }
  if ('dashboardLayout' in spec) {
    entries.push({ name: 'dashboard-layout.json', data: JSON.stringify(spec.dashboardLayout) });
  }
  return buildZip(entries);
}

// --- Valid row builders ------------------------------------------------------

const rid = (): string => randomUUID();
type Obj = Record<string, unknown>;

const brokerage = (o: Obj = {}): Obj => ({
  id: rid(),
  name: `Brk-${rid().slice(0, 8)}`,
  notes: null,
  feeSchedule: null,
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const account = (o: Obj = {}): Obj => ({
  id: rid(),
  name: `Acct-${rid().slice(0, 8)}`,
  currency: 'USD',
  timezone: 'America/New_York',
  brokerage: null,
  startingBalance: '0',
  defaultRiskPercent: null,
  isDemo: false,
  isDefault: false,
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const tag = (o: Obj = {}): Obj => ({
  id: rid(),
  name: `Tag-${rid().slice(0, 8)}`,
  category: 'general',
  color: null,
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const position = (o: Obj = {}): Obj => ({
  id: rid(),
  accountId: rid(),
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
  ...o,
});
const fill = (o: Obj = {}): Obj => ({
  id: rid(),
  positionId: rid(),
  type: 'entry',
  price: '1',
  quantity: '1',
  fees: '0',
  notes: null,
  filledAt: TS,
  createdAt: TS,
  ...o,
});
const ledger = (o: Obj = {}): Obj => ({
  id: rid(),
  accountId: rid(),
  positionId: null,
  entryType: 'balance_adjustment',
  direction: 'credit',
  amount: '0',
  currency: 'USD',
  symbol: null,
  occurredAt: TS,
  createdAt: TS,
  groupId: rid(),
  reversesGroupId: null,
  ...o,
});
const rate = (o: Obj = {}): Obj => ({
  id: rid(),
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: '1.1',
  effectiveDate: DATE,
  createdAt: TS,
  ...o,
});
const expense = (o: Obj = {}): Obj => ({
  id: rid(),
  category: 'other',
  description: 'x',
  amount: '1',
  currency: 'USD',
  occurredAt: DATE,
  notes: null,
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const persona = (o: Obj = {}): Obj => ({
  id: rid(),
  name: 'P',
  description: null,
  systemPrompt: 'sys',
  isDefault: false,
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const conversation = (o: Obj = {}): Obj => ({
  id: rid(),
  title: 'Chat',
  persona: null,
  providerId: 'openai',
  model: 'gpt-4',
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const message = (o: Obj = {}): Obj => ({
  id: rid(),
  conversationId: rid(),
  role: 'user',
  contentParts: [{ type: 'text', text: 'hi' }],
  promptTokens: null,
  completionTokens: null,
  clientMessageId: null,
  createdAt: TS,
  ...o,
});
const summary = (o: Obj = {}): Obj => ({
  id: rid(),
  conversationId: rid(),
  prose: 'sum',
  tradeDataFigures: null,
  coveredThroughMessageId: null,
  coveredThroughCreatedAt: TS,
  createdAt: TS,
  updatedAt: TS,
  ...o,
});
const preferences = (o: Obj = {}): Obj => ({
  displayCurrency: null,
  timezone: null,
  taxJurisdiction: null,
  theme: 'system',
  buyingPowerBasis: 'cash',
  advisorDefaultPersona: null,
  advisorTradeDataConsent: false,
  writableAccountId: null,
  onboarding: {},
  ...o,
});
const unrecoverablePart = { type: 'image', format: 'png', storage: { kind: 'unrecoverable' } };

let dir: string;
let counter = 0;

async function save(buf: Buffer): Promise<string> {
  const p = nodePath.join(dir, `archive-${counter++}.zip`);
  await writeFile(p, buf);
  return p;
}

// A minimal, valid, non-empty archive (one default account).
function validSpec(): Spec {
  return {
    accounts: [account({ isDefault: true })],
    preferences: preferences(),
    dashboardLayout: null,
  };
}

async function faults(spec: Spec, caps?: Parameters<typeof validateArchive>[1]) {
  const err = await validateArchive(await save(makeArchive(spec)), caps).then(
    () => {
      throw new Error('expected validateArchive to reject');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArchiveInvalidError);
  return (err as ArchiveInvalidError).fields ?? [];
}

const has = (
  fields: Array<{ path: string; code: string; message: string }>,
  code: string,
  pathIncludes?: string,
): boolean =>
  fields.some((f) => f.code === code && (pathIncludes ? f.path.includes(pathIncludes) : true));

beforeAll(async () => {
  dir = await mkdtemp(nodePath.join(os.tmpdir(), 'import-validation-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('validateArchive — happy path', () => {
  it('accepts a full archive and returns counts, message counts, covered ids and brokerage names', async () => {
    const brk = brokerage({ name: 'My Broker' });
    const acctA = account({ isDefault: true, brokerage: { user: brk.id } });
    const acctB = account({ brokerage: { system: 'IBKR' } });
    const t = tag();
    const pClosed = position({ accountId: acctA.id, status: 'closed', closedAt: TS });
    const pOpen = position({ accountId: acctA.id, status: 'open' });
    const pu = persona({ isDefault: true });
    const convA = conversation({ persona: { user: pu.id } });
    const convB = conversation({ persona: { builtin: 'default-trading-advisor' } });
    const m1 = message({ conversationId: convA.id, role: 'user' });
    const m2 = message({ conversationId: convA.id, role: 'assistant' });
    const m3 = message({ conversationId: convB.id });
    const imgEntry = 'images/positions/000001.png';

    const result = await validateArchive(
      await save(
        makeArchive({
          images: [{ name: imgEntry, bytes: new Uint8Array([1, 2, 3]) }],
          brokerages: [brk],
          systemBrokerages: [{ name: 'IBKR', feeSchedule: null }],
          accounts: [acctA, acctB],
          tags: [t],
          positions: [pClosed, pOpen],
          fills: [fill({ positionId: pClosed.id })],
          positionTags: [{ positionId: pClosed.id, tagId: t.id }],
          positionImages: [
            {
              id: rid(),
              positionId: pClosed.id,
              part: { type: 'image', format: 'png', entry: imgEntry },
              createdAt: TS,
            },
          ],
          ledgerEntries: [
            ledger({
              accountId: acctA.id,
              positionId: pClosed.id,
              entryType: 'position_pnl',
              amount: '5',
            }),
          ],
          exchangeRates: [rate()],
          expenses: [expense()],
          personas: [pu],
          builtinPersonas: [{ id: 'default-trading-advisor' }],
          conversations: [convA, convB],
          messages: [m1, m2, m3],
          summaries: [summary({ conversationId: convA.id, coveredThroughMessageId: m2.id })],
          preferences: preferences({
            writableAccountId: acctA.id,
            advisorDefaultPersona: { user: pu.id },
          }),
          dashboardLayout: null,
        }),
      ),
    );

    expect(result.counts.accounts).toBe(2);
    expect(result.counts.messages).toBe(3);
    expect(result.counts.images).toBe(1);
    expect(result.manifest.sourceAppVersion).toBe('test');
    expect(result.degradations).toEqual([]);
    expect(result.messageCountsByConversation.get(convA.id as string)).toBe(2);
    expect(result.messageCountsByConversation.get(convB.id as string)).toBe(1);
    expect(result.coveredThroughMessageIds.has(m2.id as string)).toBe(true);
    expect(result.userBrokerageNames).toEqual(['My Broker']);
  });
});

describe('validateArchive — schema and counts', () => {
  it('rejects a row with an unknown field (strict schema)', async () => {
    const f = await faults({ ...validSpec(), accounts: [account({ isDefault: true, extra: 1 })] });
    expect(has(f, 'schema', 'accounts[0]')).toBe(true);
  });

  it('rejects a row-count mismatch against the manifest', async () => {
    const f = await faults({ ...validSpec(), countsOverride: { accounts: 5 } });
    expect(has(f, 'count', 'manifest.counts.accounts')).toBe(true);
  });

  it('rejects an image-count mismatch against the manifest', async () => {
    // Declare one image the archive does not carry.
    const f = await faults({ ...validSpec(), countsOverride: { images: 1 } });
    expect(has(f, 'count', 'manifest.counts.images')).toBe(true);
  });

  it('rejects a missing manifest', async () => {
    const f = await faults({ ...validSpec(), omitManifest: true });
    expect(has(f, 'missing_manifest')).toBe(true);
  });
});

describe('validateArchive — Req 4.3 invariants', () => {
  it('rejects more than one default account', async () => {
    const f = await faults({
      ...validSpec(),
      accounts: [account({ isDefault: true }), account({ isDefault: true })],
    });
    expect(has(f, 'invariant', 'accounts')).toBe(true);
  });

  it('rejects a default demo account', async () => {
    const f = await faults({
      ...validSpec(),
      accounts: [account({ isDefault: true, isDemo: true })],
    });
    expect(has(f, 'invariant', 'accounts')).toBe(true);
  });

  it('rejects more than one default persona', async () => {
    const acct = account({ isDefault: true });
    const f = await faults({
      accounts: [acct],
      personas: [persona({ isDefault: true }), persona({ isDefault: true })],
      preferences: preferences(),
    });
    expect(has(f, 'invariant', 'personas')).toBe(true);
  });

  it('rejects more tags per position than the limit', async () => {
    const acct = account({ isDefault: true });
    const pos = position({ accountId: acct.id });
    const tags = Array.from({ length: 21 }, () => tag());
    const f = await faults({
      accounts: [acct],
      positions: [pos],
      tags,
      positionTags: tags.map((t) => ({ positionId: pos.id, tagId: t.id })),
      preferences: preferences(),
    });
    expect(has(f, 'invariant', 'position-tags')).toBe(true);
  });

  it('rejects more tags per user than the limit', async () => {
    const acct = account({ isDefault: true });
    const tags = Array.from({ length: 201 }, () => tag());
    const f = await faults({ accounts: [acct], tags, preferences: preferences() });
    expect(has(f, 'invariant', 'tags')).toBe(true);
  });

  it('rejects more screenshots per position than the limit', async () => {
    const acct = account({ isDefault: true });
    const pos = position({ accountId: acct.id });
    const images = Array.from({ length: 11 }, () => ({
      id: rid(),
      positionId: pos.id,
      part: unrecoverablePart,
      createdAt: TS,
    }));
    const f = await faults({
      accounts: [acct],
      positions: [pos],
      positionImages: images,
      preferences: preferences(),
    });
    expect(has(f, 'invariant', 'position-images')).toBe(true);
  });

  it('rejects a reverses_group_id that names no group', async () => {
    const acct = account({ isDefault: true });
    const f = await faults({
      accounts: [acct],
      ledgerEntries: [
        ledger({ accountId: acct.id, entryType: 'deposit_reversal', reversesGroupId: rid() }),
      ],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'reversesGroupId')).toBe(true);
  });

  it('rejects more than one un-reversed position_pnl for a position', async () => {
    const acct = account({ isDefault: true });
    const pos = position({ accountId: acct.id, status: 'closed', closedAt: TS });
    const f = await faults({
      accounts: [acct],
      positions: [pos],
      ledgerEntries: [
        ledger({ accountId: acct.id, positionId: pos.id, entryType: 'position_pnl', amount: '1' }),
        ledger({ accountId: acct.id, positionId: pos.id, entryType: 'position_pnl', amount: '2' }),
      ],
      preferences: preferences(),
    });
    expect(has(f, 'invariant', 'ledger-entries')).toBe(true);
  });

  it('rejects an un-reversed position_pnl for a position that is not closed', async () => {
    const acct = account({ isDefault: true });
    const pos = position({ accountId: acct.id, status: 'open' });
    const f = await faults({
      accounts: [acct],
      positions: [pos],
      ledgerEntries: [
        ledger({ accountId: acct.id, positionId: pos.id, entryType: 'position_pnl', amount: '1' }),
      ],
      preferences: preferences(),
    });
    expect(has(f, 'invariant', 'ledger-entries')).toBe(true);
  });

  it('accepts a reversed position_pnl on a non-closed position', async () => {
    const acct = account({ isDefault: true });
    const pos = position({ accountId: acct.id, status: 'open' });
    const group = rid();
    const result = await validateArchive(
      await save(
        makeArchive({
          accounts: [acct],
          positions: [pos],
          ledgerEntries: [
            ledger({
              accountId: acct.id,
              positionId: pos.id,
              entryType: 'position_pnl',
              amount: '1',
              groupId: group,
            }),
            ledger({
              accountId: acct.id,
              positionId: pos.id,
              entryType: 'position_pnl_reversal',
              amount: '1',
              reversesGroupId: group,
            }),
          ],
          preferences: preferences(),
        }),
      ),
    );
    expect(result.counts.ledgerEntries).toBe(2);
  });

  it('rejects a duplicate client_message_id for a role in one conversation', async () => {
    const acct = account({ isDefault: true });
    const conv = conversation();
    const cmid = rid();
    const f = await faults({
      accounts: [acct],
      conversations: [conv],
      messages: [
        message({ conversationId: conv.id, role: 'user', clientMessageId: cmid }),
        message({ conversationId: conv.id, role: 'user', clientMessageId: cmid }),
      ],
      preferences: preferences(),
    });
    expect(has(f, 'invariant', 'messages')).toBe(true);
  });

  it('rejects an object-storage pointer image part (schema)', async () => {
    const acct = account({ isDefault: true });
    const pos = position({ accountId: acct.id });
    const f = await faults({
      accounts: [acct],
      positions: [pos],
      positionImages: [
        {
          id: rid(),
          positionId: pos.id,
          part: { type: 'image', format: 'png', storage: { kind: 'object', key: 'x' } },
          createdAt: TS,
        },
      ],
      preferences: preferences(),
    });
    expect(has(f, 'schema', 'position-images[0]')).toBe(true);
  });
});

describe('validateArchive — references', () => {
  const acct = () => account({ isDefault: true });

  it('rejects a position referencing an unknown account', async () => {
    const f = await faults({
      accounts: [acct()],
      positions: [position({ accountId: rid() })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'accountId')).toBe(true);
  });

  it('rejects a fill referencing an unknown position', async () => {
    const f = await faults({
      accounts: [acct()],
      fills: [fill({ positionId: rid() })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'fills[0].positionId')).toBe(true);
  });

  it('rejects a position-tag referencing an unknown position or tag', async () => {
    const a = acct();
    const pos = position({ accountId: a.id });
    const f = await faults({
      accounts: [a],
      positions: [pos],
      positionTags: [{ positionId: pos.id, tagId: rid() }],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'tagId')).toBe(true);
  });

  it('rejects a position-image referencing an unknown position', async () => {
    const f = await faults({
      accounts: [acct()],
      positionImages: [{ id: rid(), positionId: rid(), part: unrecoverablePart, createdAt: TS }],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'position-images[0].positionId')).toBe(true);
  });

  it('rejects a ledger entry referencing an unknown account', async () => {
    const f = await faults({
      accounts: [acct()],
      ledgerEntries: [ledger({ accountId: rid() })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'ledger-entries[0].accountId')).toBe(true);
  });

  it('rejects a conversation referencing an unknown user persona', async () => {
    const f = await faults({
      accounts: [acct()],
      conversations: [conversation({ persona: { user: rid() } })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'conversations[0].persona')).toBe(true);
  });

  it('rejects a conversation referencing an undeclared builtin persona', async () => {
    const f = await faults({
      accounts: [acct()],
      conversations: [conversation({ persona: { builtin: 'ghost-persona' } })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'conversations[0].persona')).toBe(true);
  });

  it('rejects a message referencing an unknown conversation', async () => {
    const f = await faults({
      accounts: [acct()],
      messages: [message({ conversationId: rid() })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'messages[0].conversationId')).toBe(true);
  });

  it('rejects a summary referencing an unknown conversation', async () => {
    const f = await faults({
      accounts: [acct()],
      summaries: [summary({ conversationId: rid() })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'summaries[0].conversationId')).toBe(true);
  });

  it('rejects an account referencing an unknown user brokerage', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true, brokerage: { user: rid() } })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'accounts[0].brokerage')).toBe(true);
  });

  it('rejects an account naming a system brokerage with no snapshot', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true, brokerage: { system: 'Nowhere' } })],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'accounts[0].brokerage')).toBe(true);
  });

  it('rejects preferences naming an unknown writable account', async () => {
    const f = await faults({
      accounts: [acct()],
      preferences: preferences({ writableAccountId: rid() }),
    });
    expect(has(f, 'reference', 'preferences.writableAccountId')).toBe(true);
  });

  it('rejects preferences naming an unknown default persona', async () => {
    const f = await faults({
      accounts: [acct()],
      preferences: preferences({ advisorDefaultPersona: { user: rid() } }),
    });
    expect(has(f, 'reference', 'preferences.advisorDefaultPersona')).toBe(true);
  });

  it('rejects an image part referencing a missing entry', async () => {
    const a = acct();
    const pos = position({ accountId: a.id });
    const f = await faults({
      accounts: [a],
      positions: [pos],
      positionImages: [
        {
          id: rid(),
          positionId: pos.id,
          part: { type: 'image', format: 'png', entry: 'images/positions/000009.png' },
          createdAt: TS,
        },
      ],
      preferences: preferences(),
    });
    expect(has(f, 'reference', 'part.entry')).toBe(true);
  });

  it('rejects an image entry referenced by no row', async () => {
    const f = await faults({
      ...validSpec(),
      images: [{ name: 'images/advisor/000001.png', bytes: new Uint8Array([9]) }],
    });
    expect(has(f, 'unreferenced_image')).toBe(true);
  });
});

describe('validateArchive — DB-mirror uniques', () => {
  it('rejects a duplicate account id', async () => {
    const id = rid();
    const f = await faults({
      accounts: [account({ id, isDefault: true }), account({ id })],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate_id', 'accounts[1].id')).toBe(true);
  });

  it('rejects a duplicate lower-cased account name', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true, name: 'Main' }), account({ name: 'main' })],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate', 'accounts[1].name')).toBe(true);
  });

  it('rejects a duplicate lower-cased brokerage name', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true })],
      brokerages: [brokerage({ name: 'Broker' }), brokerage({ name: 'broker' })],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate', 'brokerages[1].name')).toBe(true);
  });

  it('rejects a duplicate lower-cased tag name', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true })],
      tags: [tag({ name: 'Win' }), tag({ name: 'win' })],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate', 'tags[1].name')).toBe(true);
  });

  it('rejects a duplicate exchange-rate pair and date', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true })],
      exchangeRates: [rate(), rate()],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate', 'exchange-rates[1]')).toBe(true);
  });

  it('rejects more than one summary per conversation', async () => {
    const a = account({ isDefault: true });
    const conv = conversation();
    const f = await faults({
      accounts: [a],
      conversations: [conv],
      summaries: [summary({ conversationId: conv.id }), summary({ conversationId: conv.id })],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate', 'summaries[1]')).toBe(true);
  });

  it('rejects a duplicate position-tag pair', async () => {
    const a = account({ isDefault: true });
    const pos = position({ accountId: a.id });
    const t = tag();
    const f = await faults({
      accounts: [a],
      positions: [pos],
      tags: [t],
      positionTags: [
        { positionId: pos.id, tagId: t.id },
        { positionId: pos.id, tagId: t.id },
      ],
      preferences: preferences(),
    });
    expect(has(f, 'duplicate', 'position-tags[1]')).toBe(true);
  });
});

describe('validateArchive — preferences, layout and emptiness', () => {
  it('rejects preferences whose onboarding fails OnboardingStateSchema', async () => {
    const f = await faults({
      accounts: [account({ isDefault: true })],
      preferences: preferences({ onboarding: { status: 'nonsense' } }),
    });
    expect(has(f, 'schema', 'preferences.onboarding')).toBe(true);
  });

  it('drops an unparseable dashboard layout as a degradation, keeping the archive', async () => {
    const result = await validateArchive(
      await save(
        makeArchive({
          accounts: [account({ isDefault: true })],
          preferences: preferences(),
          dashboardLayout: {
            widgets: [{ id: 'not-a-uuid', type: 'mystery', x: 0, y: 0, w: 1, h: 1 }],
            createdAt: TS,
            updatedAt: TS,
          },
        }),
      ),
    );
    expect(result.degradations).toContainEqual({ reason: 'dashboard_layout_unparseable' });
  });

  it('keeps a valid dashboard layout with no degradation', async () => {
    const result = await validateArchive(
      await save(
        makeArchive({
          accounts: [account({ isDefault: true })],
          preferences: preferences(),
          dashboardLayout: { widgets: [], createdAt: TS, updatedAt: TS },
        }),
      ),
    );
    expect(result.degradations).toEqual([]);
  });

  it('refuses an archive with no row in any blocking category', async () => {
    await expect(
      validateArchive(
        await save(makeArchive({ preferences: preferences(), dashboardLayout: null })),
      ),
    ).rejects.toBeInstanceOf(ArchiveEmptyError);
  });
});
