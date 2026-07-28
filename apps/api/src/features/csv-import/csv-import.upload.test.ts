import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';

import { readBodyCapped } from './csv-import.upload';

const CAP = config.CSV_IMPORT_MAX_FILE_BYTES;

/** Build a ReadableStream that emits `total` bytes in fixed-size chunks. */
function byteStream(total: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, total - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });
}

describe('readBodyCapped (Component 11 byte-cap)', () => {
  it('returns the full buffer when bytes are at or under the cap', async () => {
    const out = await readBodyCapped(byteStream(CAP));
    expect(out.byteLength).toBe(CAP);
  });

  it('aborts with 413 PAYLOAD_TOO_LARGE when actual bytes exceed the cap', async () => {
    await expect(readBodyCapped(byteStream(CAP + 1))).rejects.toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('counts ACTUAL bytes read, not Content-Length: a deceptive small CL still 413s', async () => {
    // The reader never sees Content-Length — readBodyCapped tallies bytes off
    // the stream directly. A body whose real size exceeds the cap aborts even
    // though a caller could have advertised a small Content-Length (the exact
    // hazard dashboard.body-limit.test.ts:130-162 pins for Hono bodyLimit).
    let err: unknown;
    try {
      await readBodyCapped(byteStream(CAP * 2));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(413);
  });

  it('returns an empty buffer for a null body', async () => {
    const out = await readBodyCapped(null);
    expect(out.byteLength).toBe(0);
  });
});
