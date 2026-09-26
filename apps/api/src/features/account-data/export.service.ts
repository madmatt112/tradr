import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

import {
  ARCHIVE_CAPS,
  ARCHIVE_ENTRY_ORDER,
  ARCHIVE_VERSION,
  type ArchiveCaps,
  type ArchiveCounts,
  type ArchiveManifest,
} from '@tradr/shared';

import { db } from '@/db';
import { config } from '@/lib/config';
import { isMissingObject } from '@/lib/image-serving';
import { dispatchEmail } from '@/lib/mailer';
import { getObjectStorage, ObjectUnreachableError, type ObjectStorage } from '@/lib/object-storage';
import { captureServerEvent } from '@/lib/posthog';

import { accountDataSlot } from './account-data.slots';
import { spoolAccountData, type SpoolCounts, type SpoolSummary } from './export.query';

// Design C3 — the streaming export service (Req 1). Stage 1 (task 6's
// `spoolAccountData`) reads every category inside one repeatable-read, read-only
// snapshot and spools NDJSON/JSON to a temp directory; the snapshot then closes.
// Stage 2 assembles the zip in a pull-based `ReadableStream`, fetching object
// bytes one at a time, so neither the snapshot nor the whole archive (nor all
// images) is ever held across I/O (Performance NFR, 256 MB machine).
//
// Two passes over the spooled image files:
//   Pass A walks `messages.ndjson` (advisor images) then `position-images.ndjson`
//     (position images), writing each recoverable image as a STORED zip entry
//     named `images/{advisor|positions}/NNNNNN.{format}` (numbered from 000001
//     per directory) — a pointer is fetched with `storage.get`, an inline part is
//     base64-decoded, and an already-`unrecoverable` part is skipped. A get whose
//     object is genuinely missing (`isMissingObject`) becomes an unrecoverable
//     part plus an `object_missing` manifest degradation; any other get failure is
//     an `ObjectUnreachableError` (503) — thrown before the first chunk exists so
//     the route returns 503, or erroring the stream after it (Req 1.5, 1.6).
//   Pass B writes `manifest.json`, then the payload entries in
//     `ARCHIVE_ENTRY_ORDER`, rewriting each image part in the two image files to
//     an `{ entry }` reference (or the unrecoverable marker) by Pass A's numbering.
//
// The images come first in the container (before the manifest) so the manifest can
// carry the final image count and the degradations Pass A discovered.

const EMPTY = new Uint8Array(0);

// The two image files, read once by Pass A (for the entries) and once by Pass B
// (to rewrite the parts). `messages.ndjson` carries `contentParts` arrays;
// `position-images.ndjson` carries one `part` per row.
const MESSAGES_ENTRY = 'messages.ndjson';
const POSITION_IMAGES_ENTRY = 'position-images.ndjson';

type PartResolution = { entry: string } | { unrecoverable: true };

interface ExportContext {
  dir: string;
  caps: ArchiveCaps;
  storage: ObjectStorage | null;
  sink: ZipSink;
  // Keyed `msg:<messageId>:<partIndex>` and `pimg:<imageId>`; Pass A fills it and
  // Pass B reads it. Every image part encountered gets exactly one entry.
  resolutions: Map<string, PartResolution>;
  degradations: ArchiveManifest['degradations'];
  counters: { advisor: number; positions: number };
  spoolCounts: SpoolCounts;
  exportedAt: Date;
}

// --- fflate zip sink ---------------------------------------------------------

// A thin bridge from fflate's push-based streaming `Zip` writer to a pull-based
// generator: each synchronous `add`/`push`/`end` fills `out`, which `drain()`
// yields one chunk at a time so the caller controls backpressure. Empty chunks
// are dropped so a drained chunk is always real (the primer relies on this).
class ZipSink {
  readonly zip: Zip;
  private readonly out: Uint8Array[] = [];
  private error: Error | undefined;

  constructor() {
    this.zip = new Zip((err, data) => {
      if (err) {
        this.error = err;
        return;
      }
      if (data.length > 0) this.out.push(data);
    });
  }

  *drain(): Generator<Uint8Array> {
    if (this.error) throw this.error;
    while (this.out.length > 0) yield this.out.shift()!;
  }

  // A stored (uncompressed) entry written whole — used for image bytes.
  stored(name: string, bytes: Uint8Array): void {
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    entry.push(bytes, true);
  }

  // A deflated entry the caller feeds in chunks — used for the text payloads.
  deflate(name: string): ZipDeflate {
    const entry = new ZipDeflate(name, { level: 6 });
    this.zip.add(entry);
    return entry;
  }

  end(): void {
    this.zip.end();
  }
}

// --- image parts -------------------------------------------------------------

type ImageClass =
  | { kind: 'inline'; format: string; dataBase64: string }
  | { kind: 'pointer'; format: string; key: string }
  | { kind: 'unrecoverable'; format: string };

// Classify a raw stored content part (advisor.ts `StoredContentPart`). Returns
// null for anything that is not an image part (text, tool_call, tool_result).
function classifyImagePart(part: unknown): ImageClass | null {
  if (typeof part !== 'object' || part === null) return null;
  const p = part as Record<string, unknown>;
  if (p.type !== 'image' || typeof p.format !== 'string') return null;
  if (typeof p.dataBase64 === 'string') {
    return { kind: 'inline', format: p.format, dataBase64: p.dataBase64 };
  }
  const storage = p.storage;
  if (typeof storage === 'object' && storage !== null) {
    const s = storage as Record<string, unknown>;
    if (s.kind === 'object' && typeof s.key === 'string') {
      return { kind: 'pointer', format: p.format, key: s.key };
    }
    if (s.kind === 'unrecoverable') return { kind: 'unrecoverable', format: p.format };
  }
  return null;
}

// --- Pass A: image entries ---------------------------------------------------

interface SpoolPart {
  part: unknown;
  key: string;
  partIndex: number;
}

function partsOf(kind: 'advisor' | 'positions', row: Record<string, unknown>): SpoolPart[] {
  const rowId = row.id as string;
  if (kind === 'positions') {
    return [{ part: row.part, key: `pimg:${rowId}`, partIndex: 0 }];
  }
  const parts = Array.isArray(row.contentParts) ? row.contentParts : [];
  return parts.map((part, partIndex) => ({ part, key: `msg:${rowId}:${partIndex}`, partIndex }));
}

async function* walkImageSpool(
  ctx: ExportContext,
  kind: 'advisor' | 'positions',
): AsyncGenerator<Uint8Array> {
  const fileName = kind === 'advisor' ? MESSAGES_ENTRY : POSITION_IMAGES_ENTRY;
  const input = createReadStream(path.join(ctx.dir, fileName), { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      const rowId = row.id as string;
      for (const { part, key, partIndex } of partsOf(kind, row)) {
        const cls = classifyImagePart(part);
        if (!cls) continue;
        if (cls.kind === 'unrecoverable') {
          ctx.resolutions.set(key, { unrecoverable: true });
          continue;
        }

        let bytes: Uint8Array;
        if (cls.kind === 'inline') {
          bytes = Buffer.from(cls.dataBase64, 'base64');
        } else if (!ctx.storage) {
          // A pointer with no storage configured cannot be recovered; record it
          // as a missing-object degradation rather than failing the whole export.
          ctx.resolutions.set(key, { unrecoverable: true });
          ctx.degradations.push({ entry: fileName, rowId, partIndex, reason: 'object_missing' });
          continue;
        } else {
          try {
            bytes = (await ctx.storage.get(cls.key)).bytes;
          } catch (err) {
            const cause = err instanceof ObjectUnreachableError ? err.cause : err;
            if (isMissingObject(cause)) {
              ctx.resolutions.set(key, { unrecoverable: true });
              ctx.degradations.push({
                entry: fileName,
                rowId,
                partIndex,
                reason: 'object_missing',
              });
              continue;
            }
            // A genuine outage (Req 1.5). Before the first chunk this rejects
            // `createExport` (503); after it, it errors the stream (Req 1.6).
            throw err instanceof ObjectUnreachableError
              ? err
              : new ObjectUnreachableError('Object storage is unreachable during export', err);
          }
        }

        // Defensive per-image bound (the 256 MB envelope caps images at 8 MiB and
        // the import reader rejects a larger entry); an over-cap image degrades to
        // unrecoverable rather than producing an unimportable archive.
        if (bytes.length > ctx.caps.maxImageBytes) {
          ctx.resolutions.set(key, { unrecoverable: true });
          continue;
        }

        ctx.counters[kind] += 1;
        const entry = `images/${kind}/${String(ctx.counters[kind]).padStart(6, '0')}.${cls.format}`;
        ctx.sink.stored(entry, bytes);
        ctx.resolutions.set(key, { entry });
        for (const chunk of ctx.sink.drain()) yield chunk;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

// --- manifest ----------------------------------------------------------------

// `toISOString()` renders milliseconds (`.SSSZ`); the archive timestamp format is
// microsecond (`.US"Z"`, six digits), so pad the extra three zeros.
function formatExportInstant(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

async function* writeManifest(ctx: ExportContext): AsyncGenerator<Uint8Array> {
  const manifest: ArchiveManifest = {
    format: 'tradr-account-archive',
    archiveVersion: ARCHIVE_VERSION,
    sourceAppVersion: config.APP_VERSION ?? 'unknown',
    exportedAt: formatExportInstant(ctx.exportedAt),
    counts: { ...ctx.spoolCounts, images: ctx.counters.advisor + ctx.counters.positions },
    degradations: ctx.degradations,
  };
  const entry = ctx.sink.deflate('manifest.json');
  entry.push(new TextEncoder().encode(JSON.stringify(manifest)), true);
  for (const chunk of ctx.sink.drain()) yield chunk;
}

// --- Pass B: payload entries -------------------------------------------------

function rewritePart(ctx: ExportContext, part: unknown, key: string): unknown {
  const cls = classifyImagePart(part);
  if (!cls) return part;
  const res = ctx.resolutions.get(key);
  if (res && 'entry' in res) return { type: 'image', format: cls.format, entry: res.entry };
  return { type: 'image', format: cls.format, storage: { kind: 'unrecoverable' } };
}

function rewriteMessageLine(ctx: ExportContext, line: string): string {
  const row = JSON.parse(line) as Record<string, unknown>;
  if (Array.isArray(row.contentParts)) {
    row.contentParts = row.contentParts.map((part, i) =>
      rewritePart(ctx, part, `msg:${row.id as string}:${i}`),
    );
  }
  return JSON.stringify(row);
}

function rewritePositionImageLine(ctx: ExportContext, line: string): string {
  const row = JSON.parse(line) as Record<string, unknown>;
  row.part = rewritePart(ctx, row.part, `pimg:${row.id as string}`);
  return JSON.stringify(row);
}

// Stream a spooled file straight into a deflated entry (no rewriting).
async function* copyEntry(ctx: ExportContext, name: string): AsyncGenerator<Uint8Array> {
  const entry = ctx.sink.deflate(name);
  const input = createReadStream(path.join(ctx.dir, name));
  try {
    for await (const chunk of input) {
      entry.push(chunk as Uint8Array, false);
      for (const c of ctx.sink.drain()) yield c;
    }
    entry.push(EMPTY, true);
    for (const c of ctx.sink.drain()) yield c;
  } finally {
    input.destroy();
  }
}

// Stream a spooled NDJSON file into a deflated entry, rewriting each line's image
// parts to their archive references (`messages.ndjson`, `position-images.ndjson`).
async function* rewriteEntry(
  ctx: ExportContext,
  name: string,
  rewriteLine: (line: string) => string,
): AsyncGenerator<Uint8Array> {
  const entry = ctx.sink.deflate(name);
  const input = createReadStream(path.join(ctx.dir, name), { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const encoder = new TextEncoder();
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      entry.push(encoder.encode(`${rewriteLine(line)}\n`), false);
      for (const c of ctx.sink.drain()) yield c;
    }
    entry.push(EMPTY, true);
    for (const c of ctx.sink.drain()) yield c;
  } finally {
    rl.close();
    input.destroy();
  }
}

// --- orchestrator ------------------------------------------------------------

async function* produceArchive(ctx: ExportContext): AsyncGenerator<Uint8Array> {
  // Pass A first: image entries precede the manifest and payloads.
  yield* walkImageSpool(ctx, 'advisor');
  yield* walkImageSpool(ctx, 'positions');
  yield* writeManifest(ctx);
  // Pass B: the payload entries in order (ARCHIVE_ENTRY_ORDER[0] is manifest.json).
  for (const name of ARCHIVE_ENTRY_ORDER.slice(1)) {
    if (name === MESSAGES_ENTRY) {
      yield* rewriteEntry(ctx, name, (line) => rewriteMessageLine(ctx, line));
    } else if (name === POSITION_IMAGES_ENTRY) {
      yield* rewriteEntry(ctx, name, (line) => rewritePositionImageLine(ctx, line));
    } else {
      yield* copyEntry(ctx, name);
    }
  }
  ctx.sink.end();
  for (const chunk of ctx.sink.drain()) yield chunk;
}

/**
 * Build a whole-account export archive (design C3). Acquires the per-process
 * export slot, spools stage 1 inside a repeatable-read read-only transaction, and
 * returns a pull-based `ReadableStream` of the zip plus its download filename.
 *
 * The returned promise resolves once the first chunk exists — i.e. once the
 * response is about to start. An object-storage outage while producing that first
 * chunk rejects the promise with `ObjectUnreachableError` (503) and sends nothing;
 * an outage afterwards errors the stream so the partial download fails import
 * validation (Req 1.5, 1.6). On a normal close the export email and the
 * `account_exported` event are sent; on any close the temp directory is deleted
 * and the slot released.
 */
export async function createExport(
  userId: string,
  opts?: { caps?: Partial<ArchiveCaps> },
): Promise<{ stream: ReadableStream<Uint8Array>; filename: string }> {
  const startedAt = Date.now();
  const caps: ArchiveCaps = { ...ARCHIVE_CAPS, ...opts?.caps };
  const release = await accountDataSlot('export').acquire();

  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tradr-export-'));
  } catch (err) {
    release();
    throw err;
  }

  let spool: SpoolSummary;
  try {
    // Stage 1: one consistent snapshot (Req 1.3), closed before any object I/O.
    spool = await db.transaction((tx) => spoolAccountData(tx, userId, dir), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
    throw err;
  }

  const exportedAt = new Date();
  const ctx: ExportContext = {
    dir,
    caps,
    storage: getObjectStorage(),
    sink: new ZipSink(),
    resolutions: new Map(),
    degradations: [],
    counters: { advisor: 0, positions: 0 },
    spoolCounts: spool.counts,
    exportedAt,
  };
  const gen = produceArchive(ctx);

  let terminated = false;
  const cleanup = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  };

  const sendCompletion = (): void => {
    // Req 1.9 / 10.6: a token-free notice, only sent when email is configured
    // (dispatchEmail no-ops otherwise).
    dispatchEmail(spool.email, { kind: 'data_export', exportedAt });
    // Req 10.7: one server event with flat per-category counts and the duration,
    // no personal data.
    const counts: ArchiveCounts = {
      ...spool.counts,
      images: ctx.counters.advisor + ctx.counters.positions,
    };
    const properties: Record<string, number> = { durationMs: Date.now() - startedAt };
    for (const [key, value] of Object.entries(counts)) properties[`count_${key}`] = value;
    captureServerEvent('account_exported', { distinctId: userId, properties });
  };

  // Prime the first chunk before returning the stream: this runs Pass A up to the
  // first written image (or, with no images, the manifest). A storage outage here
  // rejects — before the response starts — so the route returns 503.
  let primed: IteratorResult<Uint8Array>;
  try {
    primed = await gen.next();
  } catch (err) {
    await cleanup();
    throw err;
  }
  let pending = primed.done ? undefined : primed.value;
  let exhausted = primed.done === true;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending !== undefined) {
        const chunk = pending;
        pending = undefined;
        controller.enqueue(chunk);
        return;
      }
      if (exhausted) {
        controller.close();
        sendCompletion();
        await cleanup();
        return;
      }
      try {
        const { value, done } = await gen.next();
        if (done) {
          exhausted = true;
          controller.close();
          sendCompletion();
          await cleanup();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // After the first chunk this errors the stream (Req 1.6): the client sees
        // a failed download and the partial file fails import validation.
        controller.error(err);
        await cleanup();
      }
    },
    async cancel() {
      try {
        await gen.return(undefined);
      } catch {
        /* best-effort generator teardown */
      }
      await cleanup();
    },
  });

  return { stream, filename: `tradr-export-${exportedAt.toISOString().slice(0, 10)}.zip` };
}
