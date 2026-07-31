import { Hono } from 'hono';

import { CsvCommitRequestSchema } from '@tradr/shared';

import { db } from '@/db';
import { AppError, ValidationError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { commitImport, previewImport } from './csv-import.service';
import { readUpload } from './csv-import.upload';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const csvImport = new Hono<AuthEnv>();

csvImport.use(authMiddleware);

/**
 * Carry-forward fix (Task 7 review): the pure parser/normalizer throw a coded
 * `ValidationError(message, { code })` where the stable code (e.g.
 * `CSV_NOT_UTF8`) lands in `details.code` — but the repo's error middleware
 * always serializes a `ValidationError`'s top-level `error.code` as
 * `VALIDATION_ERROR` and would synthesize a spurious `fields[0]={path:"code"}`
 * from those details. This route handler is the structure.md-sanctioned
 * error-enriching boundary, so it remaps a coded preview `ValidationError` to an
 * `AppError(400, code, message)` whose top-level code is the stable client code,
 * with no `fields` artifact (design Component 10, Error Scenario 2).
 */
function surfaceCodedPreviewError(err: unknown): never {
  if (err instanceof ValidationError && typeof err.details?.code === 'string') {
    throw new AppError(err.statusCode, err.details.code, err.message);
  }
  throw err;
}

/**
 * @swagger
 * /api/csv-import/preview:
 *   post:
 *     summary: Preview a CSV trade import (mints a single-use commit token).
 *     description: >
 *       First call of the preview→commit handshake. Parses, maps, normalizes,
 *       segments, and dry-runs the uploaded CSV against the target account,
 *       returning the proposed positions/fills plus per-row/per-cell errors and
 *       warnings — and a single-use `token` the client passes to
 *       `/api/csv-import/commit`. No trade data is written; the only side effect
 *       is staging one preview row per user (a newer preview supersedes the
 *       prior one). The body is read with an actual-bytes byte cap
 *       (`CSV_IMPORT_MAX_FILE_BYTES`, default 10 MiB) — a deceptive
 *       `Content-Length` below the cap does not bypass it — so an oversized
 *       upload is rejected with 413. The multipart `request` part is itself
 *       capped (`CSV_IMPORT_MAX_REQUEST_BYTES`, default 64 KiB).
 *     tags: [CSV Import]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, request]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: The raw CSV file (UTF-8).
 *               request:
 *                 type: string
 *                 description: >
 *                   A JSON string (CsvPreviewRequest): `{ accountId, rowShape,
 *                   mapping, presetId?, timezone, dateFormat, numberFormat }`.
 *     responses:
 *       200:
 *         description: >
 *           `{ token, summary, positions, errors, warnings, timezone,
 *           committable, requiresDuplicateAffirmation }`. `token` is consumed by
 *           the commit endpoint.
 *       400: { description: 'Malformed upload, request part, or CSV (e.g. CSV_NOT_UTF8, CSV_IMPORT_REQUEST_TOO_LARGE, CSV_NO_ROWS).' }
 *       413: { description: 'File over CSV_IMPORT_MAX_FILE_BYTES (PAYLOAD_TOO_LARGE), too many rows (CSV_IMPORT_TOO_MANY_ROWS), or staged result too large (CSV_IMPORT_RESULT_TOO_LARGE).' }
 *       409: { description: 'An import is already in progress for this user (CSV_IMPORT_IN_PROGRESS).' }
 */
csvImport.post('/preview', async (c) => {
  const userId = c.get('userId');
  const contentType = c.req.header('content-type') ?? '';

  // Task 14 byte-capped raw-body read (NOT Hono bodyLimit) → 413/400.
  const { fileBytes, request } = await readUpload(c.req.raw.body, contentType);

  const preview = await previewImport(db, userId, request.accountId, fileBytes, request).catch(
    surfaceCodedPreviewError,
  );

  return c.json(preview, 200);
});

/**
 * @swagger
 * /api/csv-import/commit:
 *   post:
 *     summary: Commit a previewed CSV import (consumes the preview token).
 *     description: >
 *       Second call of the preview→commit handshake. Consumes the single-use `token`
 *       minted by `/api/csv-import/preview` and atomically replays the staged
 *       positions/fills (firing the close-hook ledger entries inside one bulk
 *       transaction). Idempotent: re-committing an already-committed token returns the
 *       original summary, never a second import. A stale token (replaced by a newer
 *       preview), an expired token, a blocked preview, an in-flight commit, or
 *       unconfirmed near-total duplicates each return a specific 409 with a stable
 *       code; an unknown token returns 404. Set `confirmDuplicates: true` to import
 *       past a near-total-overlap (≥90%) duplicate block. Tier enforcement (gated
 *       non-admin free users): the commit refuses 403 when the lifetime CSV-import
 *       allowance is exhausted, when the target account is not the writable designation
 *       while over the account cap, or when the batch would exceed the position cap
 *       (atomic whole-batch refusal — the message names the cap and the batch size). A
 *       tier refusal leaves the staged preview INTACT: the same token is re-committable
 *       after re-designation/upgrade, no re-upload. Only successful commits consume the
 *       lifetime allowance — previews, refusals, and failed commits never do.
 *     tags: [CSV Import]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string, format: uuid }
 *               confirmDuplicates: { type: boolean, default: false }
 *     responses:
 *       200:
 *         description: '`{ positionsCreated, fillsCreated, positionIds, accountId }` — the import summary.'
 *       400: { description: Malformed body (invalid token / confirmDuplicates). }
 *       403: { description: 'Tier refusal (never 429, no Retry-After) with a stable code: TIER_LIMIT_CSV_IMPORTS (lifetime import allowance exhausted), TIER_ACCOUNT_NOT_WRITABLE (target account not writable while over the account cap), or TIER_LIMIT_POSITIONS (batch would exceed the position cap; message names cap and batch size). The staged preview stays intact and re-committable.' }
 *       404: { description: No staged preview matches this token (or not owned). }
 *       409: { description: 'Refusal with a stable code: CSV_IMPORT_SUPERSEDED, CSV_IMPORT_EXPIRED, CSV_IMPORT_BLOCKED, CSV_IMPORT_IN_PROGRESS, or CSV_IMPORT_DUPLICATES_UNCONFIRMED.' }
 */
csvImport.post('/commit', validate('json', CsvCommitRequestSchema), async (c) => {
  const userId = c.get('userId');
  const isAdmin = c.get('isAdmin');
  const { token, confirmDuplicates } = c.req.valid('json');

  const summary = await commitImport(db, userId, token, confirmDuplicates, { isAdmin });

  captureServerEvent('csv_import_completed', {
    distinctId: userId,
    properties: {
      positionsCreated: summary.positionsCreated,
      fillsCreated: summary.fillsCreated,
    },
  });

  return c.json(summary, 200);
});

export default csvImport;
