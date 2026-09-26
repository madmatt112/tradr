import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';

import {
  ARCHIVE_CAPS,
  ARCHIVE_ENTRY_ORDER,
  ARCHIVE_IMAGE_ENTRY_RE,
  ARCHIVE_VERSION,
  type ArchiveCaps,
} from '@tradr/shared';

import {
  ArchiveInvalidError,
  ArchiveTooLargeError,
  ArchiveVersionUnsupportedError,
} from './account-data.errors';

// Design C5 — the streaming archive reader (the reader half of C5; the validator
// half is `validateArchive`). `readArchive` treats the spooled upload as untrusted
// input (Req 4.4): it streams the file through task 1's fflate `Unzip` reader and
// yields one event per image, per JSON entry, per NDJSON row and per entry end,
// enforcing every container rule as bytes arrive. It never holds more than one line
// or one image in memory and touches no database.
//
// fflate's `Unzip` surfaces only the entry name and compression method, never the
// general-purpose bit flag whose bit 0 marks encryption (task 1's doc-gap finding).
// So a bounded pre-pass reads the ZIP central directory, then reads bit 0 (offset
// +6) and the method (offset +8) of every local file header directly, rejecting an
// encrypted entry or a method other than stored/deflate before any data is
// inflated. The streaming pass then enforces names, order, uniqueness and the caps.

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

// Compressed bytes are pushed to `Unzip` in small slices so one push inflates a
// bounded amount: deflate's worst-case ratio is ~1032:1, so an 8 KiB slice yields
// at most ~8.5 MiB in a single `ondata` call (the deflate-bomb ceiling per chunk).
const PUSH_CHUNK = 8 * 1024;

const EMPTY = new Uint8Array(0);

// The two JSON (non-NDJSON) entries besides the manifest.
const JSON_ENTRIES = new Set(['manifest.json', 'preferences.json', 'dashboard-layout.json']);
const MESSAGES_ENTRY = 'messages.ndjson';

/**
 * An event yielded by {@link readArchive}: an image's raw bytes, a parsed JSON
 * entry value, one parsed NDJSON row, or an entry-end marker. The validator half
 * of C5 consumes this stream.
 */
export type ArchiveEvent =
  | { readonly kind: 'image'; readonly entry: string; readonly bytes: Uint8Array }
  | { readonly kind: 'json'; readonly entry: string; readonly value: unknown }
  | {
      readonly kind: 'row';
      readonly entry: string;
      readonly index: number;
      readonly value: unknown;
    }
  | { readonly kind: 'entry-end'; readonly entry: string };

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function invalid(path: string, code: string, message: string): ArchiveInvalidError {
  return new ArchiveInvalidError([{ path, code, message }]);
}

// The count of bytes that fall outside JSON string literals (structural
// punctuation, numbers, keywords and whitespace). A structure-heavy line — deep
// nesting or thousands of tiny tokens — is cheap to store but expensive to parse,
// so this pre-parse scan caps it before `JSON.parse` runs.
function structuralByteCount(text: string): number {
  let count = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c)
        escaped = true; // backslash
      else if (c === 0x22) inString = false; // closing quote
    } else if (c === 0x22) {
      inString = true;
      count++; // the opening quote is structural
    } else {
      count++;
    }
  }
  return count;
}

// --- Container pre-pass ------------------------------------------------------

interface CentralEntry {
  name: string;
  localHeaderOffset: number;
}

// Read the ZIP central directory (bounded), then read every local file header's
// encryption bit and compression method directly. A missing directory, a lying
// offset, an encrypted entry or a non stored/deflate method is an invalid archive;
// a Zip64 container is refused (this format's exports never produce one).
async function assertContainer(path: string, caps: ArchiveCaps): Promise<void> {
  const { size } = await stat(path);
  const maxEntries = caps.maxImages + ARCHIVE_ENTRY_ORDER.length + 64;

  const handle = await open(path, 'r');
  try {
    if (size < EOCD_MIN_SIZE) {
      throw invalid('container', 'malformed', 'The archive is too small to be a ZIP file.');
    }

    // Read the tail and scan backwards for the end-of-central-directory record.
    const tailLen = Math.min(size, EOCD_MIN_SIZE + EOCD_MAX_COMMENT);
    const tail = new Uint8Array(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - EOCD_MIN_SIZE; i >= 0; i--) {
      if (u32(tail, i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw invalid(
        'container',
        'malformed',
        'The archive has no end-of-central-directory record.',
      );
    }

    const totalEntries = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOffset = u32(tail, eocd + 16);
    if (
      totalEntries === ZIP64_MARKER_16 ||
      cdSize === ZIP64_MARKER_32 ||
      cdOffset === ZIP64_MARKER_32
    ) {
      throw invalid('container', 'unsupported', 'Zip64 archives are not supported.');
    }
    if (totalEntries > maxEntries) {
      throw new ArchiveTooLargeError('maxImages', caps.maxImages);
    }
    if (cdOffset + cdSize > size || cdSize > maxEntries * 512) {
      throw invalid('container', 'malformed', 'The central directory is out of bounds.');
    }

    const cd = new Uint8Array(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);

    const entries: CentralEntry[] = [];
    let p = 0;
    for (let n = 0; n < totalEntries; n++) {
      if (p + 46 > cdSize || u32(cd, p) !== CENTRAL_DIR_HEADER_SIG) {
        throw invalid('container', 'malformed', 'The central directory is corrupt.');
      }
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const localHeaderOffset = u32(cd, p + 42);
      const nameEnd = p + 46 + nameLen;
      if (nameEnd > cdSize) {
        throw invalid('container', 'malformed', 'The central directory is corrupt.');
      }
      const name = new TextDecoder().decode(cd.subarray(p + 46, nameEnd));
      entries.push({ name, localHeaderOffset });
      p = nameEnd + extraLen + commentLen;
    }

    // Read bit 0 (encryption) and the method from each local file header itself.
    const header = new Uint8Array(30);
    for (const entry of entries) {
      if (entry.localHeaderOffset + 30 > size) {
        throw invalid('container', 'malformed', 'A local file header is out of bounds.');
      }
      await handle.read(header, 0, 30, entry.localHeaderOffset);
      if (u32(header, 0) !== LOCAL_FILE_HEADER_SIG) {
        throw invalid('container', 'malformed', 'A local file header is missing its signature.');
      }
      if ((u16(header, 6) & 1) === 1) {
        throw invalid(`entry:${entry.name}`, 'encrypted', 'Encrypted entries are not allowed.');
      }
      const method = u16(header, 8);
      if (method !== 0 && method !== 8) {
        throw invalid(
          `entry:${entry.name}`,
          'unsupported_method',
          `Entry uses an unsupported compression method (${method}).`,
        );
      }
    }
  } finally {
    await handle.close();
  }
}

// --- Streaming pass ----------------------------------------------------------

/**
 * Stream a spooled archive and yield an {@link ArchiveEvent} per image, JSON
 * entry, NDJSON row and entry end (design C5, Req 4.4). Enforces, as bytes arrive:
 * entry names are exactly the fixed names or {@link ARCHIVE_IMAGE_ENTRY_RE}, each
 * at most once, in {@link ARCHIVE_ENTRY_ORDER}; entries are unencrypted and use
 * only stored/deflate; the running inflated-byte, per-image, per-JSON-entry,
 * per-line (4 MiB for `messages.ndjson`), structure and row caps. Names before the
 * manifest that the rules do not know are held; after the manifest a version above
 * 1 throws {@link ArchiveVersionUnsupportedError}, otherwise the held names are
 * faults. A cap breach throws {@link ArchiveTooLargeError} naming the cap; any
 * other fault throws {@link ArchiveInvalidError}.
 */
export async function* readArchive(
  path: string,
  capsOverride?: Partial<ArchiveCaps>,
): AsyncGenerator<ArchiveEvent> {
  const caps: ArchiveCaps = { ...ARCHIVE_CAPS, ...capsOverride };

  await assertContainer(path, caps);

  const events: ArchiveEvent[] = [];
  let pendingError: Error | null = null;

  const seenNames = new Set<string>();
  const heldUnknown: string[] = [];
  let lastFixedRank = 0; // 1..N once a fixed entry is seen; images must precede these
  let manifestSeen = false;
  let imageCount = 0;
  let runningInflated = 0;
  let runningRows = 0;

  const fail = (err: Error): void => {
    if (!pendingError) pendingError = err;
  };

  // Add to the running inflated-byte total; returns true (and fails) if over cap.
  const overDecompressed = (len: number): boolean => {
    runningInflated += len;
    if (runningInflated > caps.maxDecompressedBytes) {
      fail(new ArchiveTooLargeError('maxDecompressedBytes', caps.maxDecompressedBytes));
      return true;
    }
    return false;
  };

  // Resolve the container's held names once the manifest has been read: a version
  // above 1 is a version error naming both versions; otherwise held names are faults.
  const resolveManifest = (value: unknown): void => {
    const version =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>).archiveVersion
        : undefined;
    if (typeof version === 'number' && version > ARCHIVE_VERSION) {
      fail(new ArchiveVersionUnsupportedError(version));
      return;
    }
    if (heldUnknown.length > 0) {
      fail(
        new ArchiveInvalidError(
          heldUnknown.map((name) => ({
            path: `entry:${name}`,
            code: 'unknown_entry',
            message: `Unexpected archive entry ${name}.`,
          })),
        ),
      );
    }
  };

  const unzip = new Unzip((file) => {
    if (pendingError) return;
    const name = file.name;

    if (seenNames.has(name)) {
      fail(invalid(`entry:${name}`, 'duplicate_entry', `Entry ${name} appears more than once.`));
      return;
    }

    const isImage = ARCHIVE_IMAGE_ENTRY_RE.test(name);
    const fixedIdx = ARCHIVE_ENTRY_ORDER.indexOf(name as (typeof ARCHIVE_ENTRY_ORDER)[number]);

    if (isImage) {
      if (lastFixedRank > 0) {
        fail(invalid(`entry:${name}`, 'out_of_order', 'An image entry must precede the manifest.'));
        return;
      }
      imageCount += 1;
      if (imageCount > caps.maxImages) {
        fail(new ArchiveTooLargeError('maxImages', caps.maxImages));
        return;
      }
      seenNames.add(name);
      startImageEntry(file, name);
      return;
    }

    if (fixedIdx >= 0) {
      const rank = fixedIdx + 1;
      if (rank <= lastFixedRank) {
        fail(invalid(`entry:${name}`, 'out_of_order', `Entry ${name} is out of order.`));
        return;
      }
      lastFixedRank = rank;
      seenNames.add(name);
      if (name === 'manifest.json') manifestSeen = true;
      if (JSON_ENTRIES.has(name)) startJsonEntry(file, name);
      else startNdjsonEntry(file, name);
      return;
    }

    // Unknown name. Before the manifest it is held (a newer version might define
    // it); after the manifest — where the version is already known to be 1 — it is
    // an immediate fault.
    seenNames.add(name);
    if (!manifestSeen) {
      heldUnknown.push(name);
      startDrainEntry(file);
      return;
    }
    fail(invalid(`entry:${name}`, 'unknown_entry', `Unexpected archive entry ${name}.`));
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  function startImageEntry(file: UnzipFile, name: string): void {
    const parts: Uint8Array[] = [];
    let len = 0;
    file.ondata = (err, data, final) => {
      if (pendingError) return;
      if (err) {
        fail(invalid(`entry:${name}`, 'inflate_error', 'The entry could not be decompressed.'));
        return;
      }
      if (overDecompressed(data.length)) {
        file.terminate();
        return;
      }
      len += data.length;
      if (len > caps.maxImageBytes) {
        fail(new ArchiveTooLargeError('maxImageBytes', caps.maxImageBytes));
        file.terminate();
        return;
      }
      parts.push(data.slice());
      if (final) {
        events.push({ kind: 'image', entry: name, bytes: concat(parts, len) });
        events.push({ kind: 'entry-end', entry: name });
      }
    };
    file.start();
  }

  function startJsonEntry(file: UnzipFile, name: string): void {
    const parts: Uint8Array[] = [];
    let len = 0;
    file.ondata = (err, data, final) => {
      if (pendingError) return;
      if (err) {
        fail(invalid(`entry:${name}`, 'inflate_error', 'The entry could not be decompressed.'));
        return;
      }
      if (overDecompressed(data.length)) {
        file.terminate();
        return;
      }
      len += data.length;
      if (len > caps.maxJsonEntryBytes) {
        fail(new ArchiveTooLargeError('maxJsonEntryBytes', caps.maxJsonEntryBytes));
        file.terminate();
        return;
      }
      parts.push(data.slice());
      if (!final) return;
      const text = new TextDecoder().decode(concat(parts, len));
      if (structuralByteCount(text) > caps.maxLineStructureBytes) {
        fail(new ArchiveTooLargeError('maxLineStructureBytes', caps.maxLineStructureBytes));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        fail(invalid(`entry:${name}`, 'invalid_json', `Entry ${name} is not valid JSON.`));
        return;
      }
      events.push({ kind: 'json', entry: name, value });
      events.push({ kind: 'entry-end', entry: name });
      if (name === 'manifest.json') resolveManifest(value);
    };
    file.start();
  }

  function startNdjsonEntry(file: UnzipFile, name: string): void {
    const lineCap = name === MESSAGES_ENTRY ? caps.maxMessageLineBytes : caps.maxLineBytes;
    let parts: Uint8Array[] = [];
    let lineLen = 0;
    let rowIndex = 0;

    const emitLine = (): void => {
      const total = lineLen;
      const bytes = concat(parts, total);
      parts = [];
      lineLen = 0;
      if (total > lineCap) {
        fail(
          new ArchiveTooLargeError(
            name === MESSAGES_ENTRY ? 'maxMessageLineBytes' : 'maxLineBytes',
            lineCap,
          ),
        );
        return;
      }
      const text = new TextDecoder().decode(bytes);
      if (text.length === 0) return;
      if (structuralByteCount(text) > caps.maxLineStructureBytes) {
        fail(new ArchiveTooLargeError('maxLineStructureBytes', caps.maxLineStructureBytes));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        fail(
          invalid(`${name}[${rowIndex}]`, 'invalid_json', `A row in ${name} is not valid JSON.`),
        );
        return;
      }
      runningRows += 1;
      if (runningRows > caps.maxRows) {
        fail(new ArchiveTooLargeError('maxRows', caps.maxRows));
        return;
      }
      events.push({ kind: 'row', entry: name, index: rowIndex, value });
      rowIndex += 1;
    };

    file.ondata = (err, data, final) => {
      if (pendingError) return;
      if (err) {
        fail(invalid(`entry:${name}`, 'inflate_error', 'The entry could not be decompressed.'));
        return;
      }
      if (overDecompressed(data.length)) {
        file.terminate();
        return;
      }
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0a) continue; // newline
        parts.push(data.slice(start, i));
        lineLen += i - start;
        emitLine();
        if (pendingError) return;
        start = i + 1;
      }
      parts.push(data.slice(start));
      lineLen += data.length - start;
      if (lineLen > lineCap) {
        fail(
          new ArchiveTooLargeError(
            name === MESSAGES_ENTRY ? 'maxMessageLineBytes' : 'maxLineBytes',
            lineCap,
          ),
        );
        file.terminate();
        return;
      }
      if (final) {
        if (lineLen > 0) emitLine();
        if (pendingError) return;
        events.push({ kind: 'entry-end', entry: name });
      }
    };
    file.start();
  }

  // A held/unknown entry: consume and discard its bytes so the reader can reach the
  // manifest, counting them against the running inflated-byte cap.
  function startDrainEntry(file: UnzipFile): void {
    file.ondata = (err, data) => {
      if (pendingError) return;
      if (err) return;
      if (overDecompressed(data.length)) file.terminate();
    };
    file.start();
  }

  const input = createReadStream(path, { highWaterMark: PUSH_CHUNK });
  try {
    for await (const chunk of input) {
      const bytes = chunk as Uint8Array;
      for (let offset = 0; offset < bytes.length; offset += PUSH_CHUNK) {
        try {
          unzip.push(bytes.subarray(offset, offset + PUSH_CHUNK), false);
        } catch {
          throw invalid('container', 'malformed', 'The archive is not a valid ZIP container.');
        }
        while (events.length > 0) yield events.shift()!;
        if (pendingError) throw pendingError;
      }
    }
    try {
      unzip.push(EMPTY, true);
    } catch {
      throw invalid(
        'container',
        'truncated',
        'The archive ends before its last entry is complete.',
      );
    }
    while (events.length > 0) yield events.shift()!;
    if (pendingError) throw pendingError;
    if (heldUnknown.length > 0) {
      throw new ArchiveInvalidError(
        heldUnknown.map((name) => ({
          path: `entry:${name}`,
          code: 'unknown_entry',
          message: `Unexpected archive entry ${name}.`,
        })),
      );
    }
  } finally {
    input.destroy();
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
