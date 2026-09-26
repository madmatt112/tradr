import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ArchiveInvalidError,
  ArchiveTooLargeError,
  ArchiveVersionUnsupportedError,
} from './account-data.errors';
import { readArchive, type ArchiveEvent } from './archive-reader';

// C5 reader tests. Every archive is built with task 1's fflate writer, spooled to a
// temp file, then read with lowered caps so the container rules and the byte caps
// are provable on small inputs (design C5, Req 4.4).

interface Entry {
  name: string;
  data: Uint8Array | string;
  method?: 'store' | 'deflate';
}

function buildZip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(Buffer.from(data));
  });
  for (const e of entries) {
    const method = e.method ?? (e.name.startsWith('images/') ? 'store' : 'deflate');
    const bytes = typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data;
    const f =
      method === 'store' ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: 9 });
    zip.add(f);
    f.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

const manifest = (version = 1): Entry => ({
  name: 'manifest.json',
  data: JSON.stringify({ archiveVersion: version }),
});

// Find an entry's local file header offset through the central directory (the
// authoritative record), so a test can tamper with the header bytes.
function locateLocalHeader(buf: Buffer, name: string): number {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfh = buf.readUInt32LE(p + 42);
    const nm = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (nm === name) return lfh;
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry not found: ${name}`);
}

let dir: string;
let counter = 0;

async function save(buf: Buffer): Promise<string> {
  const p = path.join(dir, `archive-${counter++}.zip`);
  await writeFile(p, buf);
  return p;
}

async function collect(
  p: string,
  caps?: Parameters<typeof readArchive>[1],
): Promise<ArchiveEvent[]> {
  const events: ArchiveEvent[] = [];
  for await (const ev of readArchive(p, caps)) events.push(ev);
  return events;
}

// Drain the reader and return whatever it throws.
async function rejection(p: string, caps?: Parameters<typeof readArchive>[1]): Promise<unknown> {
  return collect(p, caps).then(
    () => {
      throw new Error('expected readArchive to reject');
    },
    (err: unknown) => err,
  );
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'archive-reader-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readArchive (design C5 reader)', () => {
  it('yields image, json, row and entry-end events in stream order', async () => {
    const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const buf = buildZip([
      { name: 'images/advisor/000001.png', data: image },
      manifest(1),
      { name: 'accounts.ndjson', data: '{"id":"a"}\n{"id":"b"}\n' },
      { name: 'preferences.json', data: '{"theme":"dark"}' },
      { name: 'dashboard-layout.json', data: 'null' },
    ]);
    const events = await collect(await save(buf));

    expect(events.map((e) => `${e.kind}:${e.entry}`)).toEqual([
      'image:images/advisor/000001.png',
      'entry-end:images/advisor/000001.png',
      'json:manifest.json',
      'entry-end:manifest.json',
      'row:accounts.ndjson',
      'row:accounts.ndjson',
      'entry-end:accounts.ndjson',
      'json:preferences.json',
      'entry-end:preferences.json',
      'json:dashboard-layout.json',
      'entry-end:dashboard-layout.json',
    ]);

    const img = events[0];
    expect(img.kind === 'image' && Buffer.from(img.bytes).equals(Buffer.from(image))).toBe(true);
    const rows = events.filter((e) => e.kind === 'row');
    expect(
      rows.map((r) => (r.kind === 'row' ? [r.index, (r.value as { id: string }).id] : null)),
    ).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
    const layout = events.find((e) => e.entry === 'dashboard-layout.json' && e.kind === 'json');
    expect(layout && layout.kind === 'json' && layout.value).toBe(null);
  });

  it('rejects path-traversal and absolute entry names', async () => {
    const buf = buildZip([
      { name: '../evil.ndjson', data: '{}\n' },
      { name: '/abs.ndjson', data: '{}\n' },
      manifest(1),
    ]);
    await expect(collect(await save(buf))).rejects.toBeInstanceOf(ArchiveInvalidError);
  });

  it('rejects a duplicate entry', async () => {
    const buf = buildZip([
      manifest(1),
      { name: 'accounts.ndjson', data: '{}\n' },
      { name: 'accounts.ndjson', data: '{}\n' },
    ]);
    await expect(collect(await save(buf))).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
  });

  it('rejects entries out of the fixed order', async () => {
    const buf = buildZip([
      manifest(1),
      { name: 'accounts.ndjson', data: '{}\n' },
      { name: 'brokerages.ndjson', data: '{}\n' },
    ]);
    await expect(collect(await save(buf))).rejects.toBeInstanceOf(ArchiveInvalidError);
  });

  it('rejects an entry whose encryption bit is set', async () => {
    const buf = buildZip([
      { name: 'images/advisor/000001.png', data: new Uint8Array([1, 2, 3]) },
      manifest(1),
    ]);
    const lfh = locateLocalHeader(buf, 'images/advisor/000001.png');
    buf[lfh + 6] |= 1; // general-purpose bit 0 = encrypted
    await expect(collect(await save(buf))).rejects.toBeInstanceOf(ArchiveInvalidError);
  });

  it('rejects an unknown compression method', async () => {
    const buf = buildZip([
      { name: 'images/advisor/000001.png', data: new Uint8Array([1, 2, 3]) },
      manifest(1),
    ]);
    const lfh = locateLocalHeader(buf, 'images/advisor/000001.png');
    buf.writeUInt16LE(12, lfh + 8); // method 12 (bzip2) — neither stored nor deflate
    await expect(collect(await save(buf))).rejects.toBeInstanceOf(ArchiveInvalidError);
  });

  it('rejects a deflate bomb via the running inflated-byte cap', async () => {
    const buf = buildZip([manifest(1), { name: 'accounts.ndjson', data: new Uint8Array(200_000) }]);
    const err = await rejection(await save(buf), { maxDecompressedBytes: 4096 });
    expect(err).toBeInstanceOf(ArchiveTooLargeError);
    expect((err as ArchiveTooLargeError).cap).toBe('maxDecompressedBytes');
  });

  it('rejects an oversized line', async () => {
    const line = `{"x":"${'a'.repeat(300)}"}\n`;
    const buf = buildZip([manifest(1), { name: 'accounts.ndjson', data: line }]);
    const err = await rejection(await save(buf), { maxLineBytes: 100 });
    expect(err).toBeInstanceOf(ArchiveTooLargeError);
    expect((err as ArchiveTooLargeError).cap).toBe('maxLineBytes');
  });

  it('rejects a structure-heavy line before parsing it', async () => {
    const line = `[${Array(61).fill('0').join(',')}]\n`; // 123 structural bytes, tiny total
    const buf = buildZip([manifest(1), { name: 'accounts.ndjson', data: line }]);
    const err = await rejection(await save(buf), { maxLineStructureBytes: 60 });
    expect(err).toBeInstanceOf(ArchiveTooLargeError);
    expect((err as ArchiveTooLargeError).cap).toBe('maxLineStructureBytes');
  });

  it('reports a newer version as a version error even with an unknown entry present', async () => {
    const buf = buildZip([{ name: 'mystery.ndjson', data: '{}\n' }, manifest(2)]);
    await expect(collect(await save(buf))).rejects.toBeInstanceOf(ArchiveVersionUnsupportedError);
    await expect(collect(await save(buf))).rejects.toMatchObject({ foundVersion: 2 });
  });

  it('rejects a truncated file', async () => {
    const buf = buildZip([manifest(1), { name: 'accounts.ndjson', data: '{}\n' }]);
    const truncated = buf.subarray(0, 50);
    await expect(collect(await save(Buffer.from(truncated)))).rejects.toBeInstanceOf(
      ArchiveInvalidError,
    );
  });
});
