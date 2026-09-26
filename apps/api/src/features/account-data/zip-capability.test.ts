import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { describe, expect, it } from 'vitest';

// Capability probe for fflate 0.8.3 (apps/api/node_modules/fflate), pinned
// before any archive code (design C3/C5) relies on it. The Design Probes left
// fflate unprobed; this proves the exact behaviours the streaming export writer
// and the streaming import reader need.
//
// Classes used:
//   Writer — Zip, ZipPassThrough (stored), ZipDeflate (deflate).
//   Reader — Unzip, UnzipInflate (deflate), UnzipPassThrough (stored).
//
// Encryption-bit note: fflate's Unzip exposes only `name` and `compression`
// (and, for non-streaming archives, `size`/`originalSize`) on the file object —
// NOT the general-purpose bit flag. The flag, whose bit 0 is the encryption
// bit, lives at offset +6 of every local file header, which always precedes the
// entry's data in the byte stream. So the reader reads the encryption bit from
// the local header directly (readLocalHeaders below); the archive validator
// (C5) rejects an entry with the bit set. fflate streaming archives also set
// the data-descriptor bit (flag & 8), which is why `file.size` is undefined for
// them and the inflated-byte cap (capability d) must be counted, not trusted.

const LOCAL_FILE_HEADER_SIG = 0x04034b50;

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

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

interface LocalHeader {
  name: string;
  method: number;
  gpFlag: number;
  encrypted: boolean;
}

// Scan a zip for local file headers, reading each entry's name, compression
// method and general-purpose bit flag (encryption = bit 0). This is the fixed
// header layout C5's validator reads to reject encrypted entries.
function readLocalHeaders(archive: Uint8Array): LocalHeader[] {
  const headers: LocalHeader[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i + 30 <= archive.length; i++) {
    if (u32(archive, i) !== LOCAL_FILE_HEADER_SIG) continue;
    const gpFlag = u16(archive, i + 6);
    const method = u16(archive, i + 8);
    const nameLen = u16(archive, i + 26);
    const extraLen = u16(archive, i + 28);
    const name = decoder.decode(archive.subarray(i + 30, i + 30 + nameLen));
    headers.push({ name, method, gpFlag, encrypted: (gpFlag & 1) === 1 });
    i += 30 + nameLen + extraLen - 1;
  }
  return headers;
}

const encoder = new TextEncoder();
// ~256 KiB of compressible text (deflates hard) and a tiny stored payload.
const DEFLATED_SOURCE = encoder.encode(
  'The quick brown fox jumps over the lazy dog. '.repeat(6000),
);
const STORED_SOURCE = encoder.encode('stored-entry-bytes');

interface BuiltArchive {
  archive: Uint8Array;
  writerChunkCount: number;
  writerFinalSeen: boolean;
}

// Build a zip with one stored and one deflated entry through the streaming
// writer, feeding the deflated source in slices so compression itself streams.
function buildArchive(): BuiltArchive {
  const chunks: Uint8Array[] = [];
  let writerFinalSeen = false;
  const zip = new Zip((err, data, final) => {
    if (err) throw err;
    chunks.push(data);
    if (final) writerFinalSeen = true;
  });

  const stored = new ZipPassThrough('stored.bin');
  zip.add(stored);
  stored.push(STORED_SOURCE, true);

  const deflated = new ZipDeflate('deflated.txt', { level: 6 });
  zip.add(deflated);
  for (let offset = 0; offset < DEFLATED_SOURCE.length; offset += 40000) {
    const end = Math.min(offset + 40000, DEFLATED_SOURCE.length);
    deflated.push(DEFLATED_SOURCE.subarray(offset, end), end >= DEFLATED_SOURCE.length);
  }

  zip.end();
  return { archive: concat(chunks), writerChunkCount: chunks.length, writerFinalSeen };
}

describe('fflate 0.8.3 zip capabilities (design C3/C5)', () => {
  it('(a) the streaming writer emits a zip chunk by chunk holding stored and deflated entries', () => {
    const { archive, writerChunkCount, writerFinalSeen } = buildArchive();

    // Emitted incrementally, not as one buffer, with a single final flag.
    expect(writerChunkCount).toBeGreaterThan(1);
    expect(writerFinalSeen).toBe(true);

    const headers = readLocalHeaders(archive);
    const byName = new Map(headers.map((h) => [h.name, h]));
    expect(byName.get('stored.bin')?.method).toBe(0); // stored
    expect(byName.get('deflated.txt')?.method).toBe(8); // deflate

    // The deflated entry actually shrank: the whole archive is far smaller than
    // the deflated source alone.
    expect(archive.length).toBeLessThan(DEFLATED_SOURCE.length);
  });

  it('(b) the streaming reader reports name, compression and the encryption bit before entry data', () => {
    const { archive } = buildArchive();

    const events: string[] = [];
    const seen = new Map<string, { compression: number }>();

    const unzip = new Unzip((file) => {
      events.push(`file:${file.name}`);
      seen.set(file.name, { compression: file.compression });
      let firstData = true;
      file.ondata = (err) => {
        if (err) throw err;
        if (firstData) {
          firstData = false;
          events.push(`data:${file.name}`);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);

    // Feed the bytes in small chunks; the header is buffered until complete.
    for (let offset = 0; offset < archive.length; offset += 64) {
      const end = Math.min(offset + 64, archive.length);
      unzip.push(archive.subarray(offset, end), end >= archive.length);
    }

    // Name + compression are reported (via onfile) before any data event.
    expect(seen.get('stored.bin')?.compression).toBe(0);
    expect(seen.get('deflated.txt')?.compression).toBe(8);
    for (const name of ['stored.bin', 'deflated.txt']) {
      const fileAt = events.indexOf(`file:${name}`);
      const dataAt = events.indexOf(`data:${name}`);
      expect(fileAt).toBeGreaterThanOrEqual(0);
      expect(dataAt).toBeGreaterThan(fileAt);
    }

    // The encryption bit (and method) is readable from the local header, which
    // precedes the entry data. Our entries are unencrypted.
    const headers = readLocalHeaders(archive);
    expect(headers.map((h) => h.name).sort()).toEqual(['deflated.txt', 'stored.bin']);
    for (const header of headers) {
      expect(header.encrypted).toBe(false);
      expect(header.method).toBe(seen.get(header.name)?.compression);
    }

    // Setting general-purpose bit 0 in a local header is detected as encrypted.
    const tampered = archive.slice();
    const firstSig = tampered.findIndex(
      (_, i) => i + 4 <= tampered.length && u32(tampered, i) === LOCAL_FILE_HEADER_SIG,
    );
    tampered[firstSig + 6] |= 1;
    expect(readLocalHeaders(tampered)[0].encrypted).toBe(true);
  });

  it('(c) deflated data arrives as bounded chunks, never one whole-entry buffer', () => {
    const { archive } = buildArchive();

    let dataChunks = 0;
    let maxChunk = 0;
    const unzip = new Unzip((file) => {
      if (file.name !== 'deflated.txt') return;
      file.ondata = (err, data) => {
        if (err) throw err;
        dataChunks += 1;
        maxChunk = Math.max(maxChunk, data.length);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);

    for (let offset = 0; offset < archive.length; offset += 64) {
      const end = Math.min(offset + 64, archive.length);
      unzip.push(archive.subarray(offset, end), end >= archive.length);
    }

    expect(dataChunks).toBeGreaterThan(1);
    expect(maxChunk).toBeLessThan(DEFLATED_SOURCE.length);
  });

  it('(d) an entry can be abandoned mid-inflate once a running byte counter passes a cap', () => {
    const { archive } = buildArchive();

    const CAP = 50 * 1024; // well under the ~256 KiB inflated size
    let inflatedBytes = 0;
    let abandoned = false;
    let feeding = true;

    const unzip = new Unzip((file) => {
      if (file.name !== 'deflated.txt') return;
      file.ondata = (err, data) => {
        if (err) throw err;
        inflatedBytes += data.length;
        if (inflatedBytes > CAP && !abandoned) {
          abandoned = true;
          feeding = false;
          file.terminate();
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);

    for (let offset = 0; offset < archive.length && feeding; offset += 64) {
      const end = Math.min(offset + 64, archive.length);
      unzip.push(archive.subarray(offset, end), end >= archive.length);
    }

    expect(abandoned).toBe(true);
    expect(inflatedBytes).toBeGreaterThan(CAP); // the counter passed the cap
    expect(inflatedBytes).toBeLessThan(DEFLATED_SOURCE.length); // stopped mid-entry
  });

  it('(e) a round trip returns identical bytes', () => {
    const { archive } = buildArchive();

    const restored = new Map<string, Uint8Array>();
    const unzip = new Unzip((file) => {
      const parts: Uint8Array[] = [];
      file.ondata = (err, data, final) => {
        if (err) throw err;
        parts.push(data.slice());
        if (final) restored.set(file.name, concat(parts));
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);

    for (let offset = 0; offset < archive.length; offset += 512) {
      const end = Math.min(offset + 512, archive.length);
      unzip.push(archive.subarray(offset, end), end >= archive.length);
    }

    expect(Buffer.from(restored.get('stored.bin')!).equals(Buffer.from(STORED_SOURCE))).toBe(true);
    expect(Buffer.from(restored.get('deflated.txt')!).equals(Buffer.from(DEFLATED_SOURCE))).toBe(
      true,
    );
  });
});
