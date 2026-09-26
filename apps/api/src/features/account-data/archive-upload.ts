import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { ARCHIVE_CAPS } from '@tradr/shared';

import { ArchiveTooLargeError } from './account-data.errors';

/**
 * Stream an archive upload to disk (design C4 Upload spooler). The body is
 * written chunk by chunk with backpressure, its bytes counted and hashed with
 * SHA-256 as they pass — the whole body is never held in memory. On any read
 * failure, including exceeding `maxBytes`, the reader is cancelled, the partial
 * file deleted, and the error rethrown (`ArchiveTooLargeError` over the cap).
 *
 * Mirrors the byte-counted, cap-aborting read of `csv-import.upload.ts:35-77`
 * but writes to a file sink instead of buffering.
 */
export async function spoolUpload(
  body: ReadableStream<Uint8Array> | null,
  dir: string,
  maxBytes: number = ARCHIVE_CAPS.maxUploadBytes,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const filePath = path.join(dir, 'upload.zip');
  const hash = createHash('sha256');
  const sink = createWriteStream(filePath);
  let bytes = 0;

  if (body === null) {
    sink.end();
    await finished(sink);
    return { path: filePath, bytes: 0, sha256: hash.digest('hex') };
  }

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ArchiveTooLargeError('maxUploadBytes', maxBytes);
      }
      hash.update(value);
      if (!sink.write(value)) {
        await once(sink, 'drain');
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    // Wait for the sink to fully close before unlinking: destroy() is async, and
    // a still-pending open() would otherwise re-create the file after unlink.
    sink.destroy();
    await once(sink, 'close').catch(() => {});
    await unlink(filePath).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  sink.end();
  await finished(sink);
  return { path: filePath, bytes, sha256: hash.digest('hex') };
}
