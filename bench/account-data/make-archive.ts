/**
 * Build a valid account-data archive for the 256 MiB memory/time benchmark
 * (spec account-export-import, task 19). Writes an archive that passes the real
 * import reader + validator (apps/api/src/features/account-data/archive-reader.ts,
 * import-validation.service.ts), so `measure.ts` can drive a real preview + confirm.
 *
 * Two archives, matching design.md's "Memory and size envelope" section:
 *
 *   envelope — the ordinary account: 1,000 positions, 3,000 fills, 2,000 ledger
 *              rows (~2 MB of NDJSON, no images). preview + confirm must finish
 *              inside the 300 s proxy budget and under the 192 MiB peak-RSS line.
 *
 *   caps     — the image-heavy stress at the archive caps (ARCHIVE_CAPS): 10,000
 *              images decompressing to ~1.9 GiB, three ~3.9 MiB `messages.ndjson`
 *              lines, and 5,000 covered-through summary references. The image
 *              bytes are highly compressible so the COMPRESSED upload stays well
 *              under `maxUploadBytes` (512 MiB) while the DECOMPRESSED total
 *              approaches `maxDecompressedBytes` (2 GiB) — the no-storage confirm's
 *              per-image `/tmp` staging is what this exercises.
 *
 * The archive is a ZIP written in ARCHIVE_ENTRY_ORDER (image entries first, then
 * `manifest.json`, then the NDJSON payloads, then the two JSON entries), exactly
 * as the export service produces it. Image entries and text payloads are deflated;
 * counts are precomputed so the manifest (written before the payloads) is exact.
 *
 * Run with tsx:
 *   tsx bench/account-data/make-archive.ts envelope [outPath]
 *   tsx bench/account-data/make-archive.ts caps     [outPath]
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { Zip, ZipDeflate } from 'fflate';

import { ARCHIVE_CAPS, ARCHIVE_VERSION, type ArchiveCounts } from '@tradr/shared';

// Fixed instant used for every timestamp/date (no uniqueness constraint keys off
// them). Microsecond-precision UTC, matching ARCHIVE_TIMESTAMP_RE.
const TS = '2026-01-01T00:00:00.000000Z';

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

// A zero counts block; each builder fills only the categories it writes.
function zeroCounts(): ArchiveCounts {
  return {
    brokerages: 0,
    systemBrokerages: 0,
    accounts: 0,
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
}

// Fixed, valid preferences object (ArchivePreferencesSchema). `onboarding: {}`
// parses cleanly under OnboardingStateSchema (every field defaults).
function preferences(): unknown {
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

// --- streaming zip writer ----------------------------------------------------

// A thin bridge over fflate's push-based `Zip`: chunks land in `pending`, and
// `flush()` writes them to the file, awaiting `drain` for backpressure.
class ArchiveWriter {
  private readonly zip: Zip;
  private readonly ws: WriteStream;
  private pending: Uint8Array[] = [];
  private error?: Error;

  constructor(outPath: string) {
    this.ws = createWriteStream(outPath);
    this.zip = new Zip((err, data) => {
      if (err) {
        this.error = err;
        return;
      }
      if (data.length > 0) this.pending.push(data);
    });
  }

  private async flush(): Promise<void> {
    if (this.error) throw this.error;
    for (const chunk of this.pending) {
      if (!this.ws.write(chunk)) {
        await new Promise<void>((resolve) => this.ws.once('drain', resolve));
      }
    }
    this.pending = [];
  }

  // A whole deflated entry pushed in one shot (manifest, preferences, images).
  async putBytes(name: string, bytes: Uint8Array): Promise<void> {
    const entry = new ZipDeflate(name, { level: 6 });
    this.zip.add(entry);
    entry.push(bytes, true);
    await this.flush();
  }

  async putText(name: string, text: string): Promise<void> {
    await this.putBytes(name, encoder.encode(text));
  }

  // A deflated NDJSON entry fed one row at a time, so no whole entry is ever held
  // in memory (the ~3.9 MiB message lines and the 10,000-row image manifest).
  async putNdjson(name: string, rows: Iterable<unknown>): Promise<void> {
    const entry = new ZipDeflate(name, { level: 6 });
    this.zip.add(entry);
    for (const row of rows) {
      entry.push(encoder.encode(`${JSON.stringify(row)}\n`), false);
      await this.flush();
    }
    entry.push(EMPTY, true);
    await this.flush();
  }

  async finish(): Promise<void> {
    this.zip.end();
    await this.flush();
    await new Promise<void>((resolve, reject) => {
      this.ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

// --- envelope archive --------------------------------------------------------

const ENVELOPE_POSITIONS = 1_000;
const ENVELOPE_FILLS = 3_000; // three per position
const ENVELOPE_LEDGER = 2_000;

async function buildEnvelope(w: ArchiveWriter): Promise<void> {
  const accountId = randomUUID();
  const positionIds: string[] = Array.from({ length: ENVELOPE_POSITIONS }, () => randomUUID());

  const counts = zeroCounts();
  counts.accounts = 1;
  counts.positions = ENVELOPE_POSITIONS;
  counts.fills = ENVELOPE_FILLS;
  counts.ledgerEntries = ENVELOPE_LEDGER;

  await w.putText('manifest.json', JSON.stringify(manifest(counts)));

  await w.putNdjson('accounts.ndjson', [account(accountId)]);

  await w.putNdjson(
    'positions.ndjson',
    positionIds.map((id) => position(id, accountId)),
  );

  await w.putNdjson('fills.ndjson', fillRows(positionIds, ENVELOPE_FILLS));

  await w.putNdjson('ledger-entries.ndjson', ledgerRows(accountId, ENVELOPE_LEDGER));

  await w.putText('preferences.json', JSON.stringify(preferences()));
  await w.putText('dashboard-layout.json', JSON.stringify(null));
}

function* fillRows(positionIds: string[], total: number): Generator<unknown> {
  for (let i = 0; i < total; i++) {
    const positionId = positionIds[i % positionIds.length];
    yield {
      id: randomUUID(),
      positionId,
      type: 'entry',
      price: '150.00',
      quantity: '10',
      fees: '0',
      notes: null,
      filledAt: TS,
      createdAt: TS,
    };
  }
}

function* ledgerRows(accountId: string, total: number): Generator<unknown> {
  for (let i = 0; i < total; i++) {
    yield {
      id: randomUUID(),
      accountId,
      positionId: null,
      // `deposit` carries no position_pnl invariant — a plain cash movement.
      entryType: 'deposit',
      direction: 'credit',
      amount: '100.0000',
      currency: 'USD',
      symbol: null,
      occurredAt: TS,
      createdAt: TS,
      groupId: randomUUID(),
      reversesGroupId: null,
    };
  }
}

// --- caps archive ------------------------------------------------------------

const CAPS_POSITIONS = 1_000;
const CAPS_IMAGES_PER_POSITION = 10; // POSITION_IMAGE_MAX_COUNT
const CAPS_IMAGES = CAPS_POSITIONS * CAPS_IMAGES_PER_POSITION; // 10,000 = maxImages
// ~1.86 GiB decompressed across the images, leaving headroom under the 2 GiB
// maxDecompressedBytes cap for the payload entries and the message lines.
const CAPS_IMAGE_BYTES = 190 * 1024;
const CAPS_CONVERSATIONS = 5_000; // one summary each → 5,000 covered-through refs
const CAPS_MESSAGE_LINES = 3;
// A ~3.9 MiB text part keeps the whole message line under maxMessageLineBytes
// (4 MiB) while its structural bytes stay far under maxLineStructureBytes.
const CAPS_MESSAGE_TEXT_BYTES = 3_900_000;

async function buildCaps(w: ArchiveWriter): Promise<void> {
  const accountId = randomUUID();
  const positionIds: string[] = Array.from({ length: CAPS_POSITIONS }, () => randomUUID());
  const conversationIds: string[] = Array.from({ length: CAPS_CONVERSATIONS }, () => randomUUID());

  // One shared, highly compressible image buffer, reused for every entry: the
  // compressed archive stays tiny, the decompressed total approaches 2 GiB.
  const imageBytes = new Uint8Array(CAPS_IMAGE_BYTES);
  for (let i = 0; i < imageBytes.length; i++) imageBytes[i] = i & 0x3f; // repeating, deflates well

  // Image entries first, before the manifest (ARCHIVE_ENTRY_ORDER / reader rule).
  for (let n = 1; n <= CAPS_IMAGES; n++) {
    await w.putBytes(`images/positions/${String(n).padStart(6, '0')}.png`, imageBytes);
  }

  const counts = zeroCounts();
  counts.accounts = 1;
  counts.positions = CAPS_POSITIONS;
  counts.positionImages = CAPS_IMAGES;
  counts.conversations = CAPS_CONVERSATIONS;
  counts.messages = CAPS_MESSAGE_LINES;
  counts.summaries = CAPS_CONVERSATIONS;
  counts.images = CAPS_IMAGES;

  await w.putText('manifest.json', JSON.stringify(manifest(counts)));

  await w.putNdjson('accounts.ndjson', [account(accountId)]);

  await w.putNdjson(
    'positions.ndjson',
    positionIds.map((id) => position(id, accountId)),
  );

  await w.putNdjson('position-images.ndjson', positionImageRows(positionIds));

  await w.putNdjson(
    'conversations.ndjson',
    conversationIds.map((id) => conversation(id)),
  );

  await w.putNdjson('messages.ndjson', messageRows(conversationIds[0], CAPS_MESSAGE_LINES));

  await w.putNdjson('summaries.ndjson', summaryRows(conversationIds));

  await w.putText('preferences.json', JSON.stringify(preferences()));
  await w.putText('dashboard-layout.json', JSON.stringify(null));
}

// One image entry per row; image N belongs to position floor((N-1)/10). Each
// entry is referenced exactly once (the validator's image bijection).
function* positionImageRows(positionIds: string[]): Generator<unknown> {
  for (let n = 1; n <= CAPS_IMAGES; n++) {
    const positionId = positionIds[Math.floor((n - 1) / CAPS_IMAGES_PER_POSITION)];
    yield {
      id: randomUUID(),
      positionId,
      part: {
        type: 'image',
        format: 'png',
        entry: `images/positions/${String(n).padStart(6, '0')}.png`,
      },
      createdAt: TS,
    };
  }
}

function conversation(id: string): unknown {
  return {
    id,
    title: 'Benchmark conversation',
    persona: null,
    providerId: 'openai',
    model: 'gpt-4o',
    createdAt: TS,
    updatedAt: TS,
  };
}

function* messageRows(conversationId: string, total: number): Generator<unknown> {
  const text = 'a'.repeat(CAPS_MESSAGE_TEXT_BYTES);
  for (let i = 0; i < total; i++) {
    yield {
      id: randomUUID(),
      conversationId,
      role: 'user',
      contentParts: [{ type: 'text', text }],
      promptTokens: null,
      completionTokens: null,
      clientMessageId: null,
      createdAt: TS,
    };
  }
}

// One summary per conversation, each with a distinct advisory covered-through id
// (naming no archived message → restored null, retained up to maxCoveredThroughRefs).
function* summaryRows(conversationIds: string[]): Generator<unknown> {
  for (const conversationId of conversationIds) {
    yield {
      id: randomUUID(),
      conversationId,
      prose: 'Benchmark summary.',
      tradeDataFigures: null,
      coveredThroughMessageId: randomUUID(),
      coveredThroughCreatedAt: TS,
      createdAt: TS,
      updatedAt: TS,
    };
  }
}

// --- shared row builders -----------------------------------------------------

function manifest(counts: ArchiveCounts): unknown {
  return {
    format: 'tradr-account-archive',
    archiveVersion: ARCHIVE_VERSION,
    sourceAppVersion: 'bench',
    exportedAt: TS,
    counts,
    degradations: [],
  };
}

function account(id: string): unknown {
  return {
    id,
    name: 'Benchmark Account',
    currency: 'USD',
    timezone: 'UTC',
    brokerage: null,
    startingBalance: '10000',
    defaultRiskPercent: null,
    isDemo: false,
    isDefault: true,
    createdAt: TS,
    updatedAt: TS,
  };
}

function position(id: string, accountId: string): unknown {
  return {
    id,
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

// --- entry point -------------------------------------------------------------

async function main(): Promise<void> {
  const kind = process.argv[2];
  if (kind !== 'envelope' && kind !== 'caps') {
    console.error('usage: tsx make-archive.ts <envelope|caps> [outPath]');
    process.exit(2);
  }
  const outPath = process.argv[3] ?? path.join('/tmp/scratchpad', `account-archive-${kind}.zip`);
  await mkdir(path.dirname(outPath), { recursive: true });

  const started = Date.now();
  const w = new ArchiveWriter(outPath);
  if (kind === 'envelope') await buildEnvelope(w);
  else await buildCaps(w);
  await w.finish();

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    JSON.stringify({
      kind,
      outPath,
      caps: { maxUploadBytes: ARCHIVE_CAPS.maxUploadBytes, maxImages: ARCHIVE_CAPS.maxImages },
      seconds: Number(secs),
    }),
  );
}

void main();
