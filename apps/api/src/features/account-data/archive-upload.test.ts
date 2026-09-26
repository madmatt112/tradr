import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArchiveTooLargeError } from './account-data.errors';
import { spoolUpload } from './archive-upload';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('spoolUpload', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'archive-upload-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('spools a body under the cap and reports bytes, path and sha256', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await spoolUpload(streamOf([bytes.slice(0, 2), bytes.slice(2)]), dir, 1000);

    expect(result.bytes).toBe(5);
    expect(existsSync(result.path)).toBe(true);
    expect(new Uint8Array(await readFile(result.path))).toEqual(bytes);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('accepts a body exactly at the cap', async () => {
    const bytes = new Uint8Array(64).fill(7);
    const result = await spoolUpload(streamOf([bytes]), dir, 64);

    expect(result.bytes).toBe(64);
    expect(existsSync(result.path)).toBe(true);
  });

  it('rejects a body over the cap and deletes the partial file', async () => {
    const stream = streamOf([new Uint8Array(40), new Uint8Array(40)]);
    let thrown: unknown;
    try {
      await spoolUpload(stream, dir, 64);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ArchiveTooLargeError);
    expect((thrown as ArchiveTooLargeError).statusCode).toBe(413);
    expect((thrown as ArchiveTooLargeError).message).toContain('maxUploadBytes');
    expect((thrown as ArchiveTooLargeError).message).toContain('64');
    expect(existsSync(path.join(dir, 'upload.zip'))).toBe(false);
  });

  it('writes an empty file for a null body', async () => {
    const result = await spoolUpload(null, dir, 1000);

    expect(result.bytes).toBe(0);
    expect(existsSync(result.path)).toBe(true);
    expect((await readFile(result.path)).byteLength).toBe(0);
    expect(result.sha256).toBe(createHash('sha256').digest('hex'));
  });

  it('deletes the partial file on a mid-stream read error and rethrows', async () => {
    const boom = new Error('mid-stream boom');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(boom);
      },
    });

    await expect(spoolUpload(stream, dir, 1000)).rejects.toBe(boom);
    expect(existsSync(path.join(dir, 'upload.zip'))).toBe(false);
  });

  it('hashes exactly the bytes that passed', async () => {
    const chunks = [new Uint8Array([9, 8, 7]), new Uint8Array([6, 5]), new Uint8Array([4])];
    const all = new Uint8Array([9, 8, 7, 6, 5, 4]);
    const result = await spoolUpload(streamOf(chunks), dir, 1000);

    expect(result.sha256).toBe(createHash('sha256').update(all).digest('hex'));
  });
});
