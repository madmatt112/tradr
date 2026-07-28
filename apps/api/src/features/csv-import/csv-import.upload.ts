import type { CsvPreviewRequest } from '@tradr/shared';
import { CsvPreviewRequestSchema } from '@tradr/shared';

import { config } from '@/lib/config';
import { AppError, ValidationError } from '@/lib/errors';

/**
 * Upload, size & row guards for the CSV preview route (design Component 11).
 *
 * These guards bound memory at the ingress so the 2 GB reference box is protected
 * (REQ-1.5/1.6/1.7, REQ-11.1). They live in a dedicated helper to keep a third
 * writer off csv-import.service.ts.
 */

/**
 * Result of a successful upload parse: the (byte-capped) CSV file bytes plus the
 * validated request options from the multipart `request` part.
 */
export interface ParsedUpload {
  fileBytes: Uint8Array;
  request: CsvPreviewRequest;
}

/**
 * Read the raw request body into a buffer, aborting the moment the accumulated
 * ACTUAL bytes read exceed `CSV_IMPORT_MAX_FILE_BYTES` (REQ-1.6).
 *
 * This counts bytes as they arrive from the stream reader, so a deceptive
 * `Content-Length <= cap` cannot bypass the limit — unlike Hono `bodyLimit`,
 * which trusts `Content-Length` and short-circuits the streaming check
 * (see `dashboard.body-limit.test.ts:130-162`).
 *
 * @throws AppError 413 PAYLOAD_TOO_LARGE when the body exceeds the cap.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array<ArrayBuffer>> {
  const cap = config.CSV_IMPORT_MAX_FILE_BYTES;

  if (body === null) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > cap) {
        // Abort immediately — never fully materialize an over-cap body.
        await reader.cancel();
        throw new AppError(
          413,
          'PAYLOAD_TOO_LARGE',
          `File exceeds the ${Math.floor(cap / 1_048_576)} MB import limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Split the already-capped body buffer into the `file` and `request` multipart
 * parts using the Web-standard `Response().formData()` over the bounded buffer
 * (no unbounded materialization — the buffer is already <= the file cap).
 *
 * Validates the `request` part size against `CSV_IMPORT_MAX_REQUEST_BYTES`
 * (round-2 SF-A: `formData()` imposes no per-field limit), then JSON-parses and
 * validates it with `CsvPreviewRequestSchema`.
 *
 * @throws AppError 400 CSV_IMPORT_REQUEST_TOO_LARGE when the `request` part exceeds its cap.
 * @throws ValidationError 400 when the multipart, JSON, or schema is malformed.
 */
export async function splitMultipart(
  captured: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<{ fileBytes: Uint8Array; request: CsvPreviewRequest }> {
  let form: FormData;
  try {
    // Wrap the already-capped buffer in a Blob (a valid BodyInit) so the
    // multipart split operates on the bounded bytes with no extra copy beyond
    // the Blob view.
    form = await new Response(new Blob([captured]), {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    throw new ValidationError('Upload must be multipart/form-data with file and request parts.');
  }

  const filePart = form.get('file');
  if (!(filePart instanceof File)) {
    throw new ValidationError('Missing "file" part in upload.');
  }

  const requestPart = form.get('request');
  if (typeof requestPart !== 'string') {
    throw new ValidationError('Missing "request" part in upload.');
  }

  const requestBytes = new TextEncoder().encode(requestPart).byteLength;
  if (requestBytes > config.CSV_IMPORT_MAX_REQUEST_BYTES) {
    throw new AppError(
      400,
      'CSV_IMPORT_REQUEST_TOO_LARGE',
      'The import request options are too large.',
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(requestPart);
  } catch {
    throw new ValidationError('The "request" part is not valid JSON.');
  }

  const parsed = CsvPreviewRequestSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new ValidationError('Invalid import request options.', undefined, fields);
  }

  const fileBytes = new Uint8Array(await filePart.arrayBuffer());
  return { fileBytes, request: parsed.data };
}

/**
 * Read + split the upload: byte-capped raw-body read, then the multipart split
 * over the bounded buffer. Convenience wrapper combining the two guards above.
 */
export async function readUpload(
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
): Promise<ParsedUpload> {
  const captured = await readBodyCapped(body);
  return splitMultipart(captured, contentType);
}

/**
 * Trip the row-count guard at `CSV_IMPORT_MAX_ROWS` BEFORE building the full
 * in-memory result, and reject the empty/header-only "no importable rows" case
 * (REQ-1.7, REQ-11.1).
 *
 * @throws AppError 413 CSV_IMPORT_TOO_MANY_ROWS when rowCount exceeds the cap.
 * @throws AppError 400 CSV_IMPORT_NO_ROWS when there are zero data rows.
 */
export function guardRowCount(rowCount: number): void {
  if (rowCount > config.CSV_IMPORT_MAX_ROWS) {
    throw new AppError(
      413,
      'CSV_IMPORT_TOO_MANY_ROWS',
      `Import exceeds the maximum of ${config.CSV_IMPORT_MAX_ROWS} rows. Split the file.`,
    );
  }
  if (rowCount <= 0) {
    throw new AppError(400, 'CSV_IMPORT_NO_ROWS', 'No importable rows found.');
  }
}
