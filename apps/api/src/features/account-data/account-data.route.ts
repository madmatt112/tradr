import { Hono } from 'hono';

import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { ArchiveDigestMismatchError } from './account-data.errors';
import { createExport } from './export.service';
import { confirmImport, previewImport } from './import.service';

// ---------------------------------------------------------------------------
// Account export/import routes (design C9). Mounted at `/api/account-data`
// (app.ts) so the three handlers own `/export`, `/import/preview` and
// `/import`. Router-level `authMiddleware` puts every handler behind a session
// (401 without one); each reads the actor from `c.get('userId')` and no request
// input names another user (Req 8.1). The two thin upload routes hand
// `c.req.raw.body` straight to the services, which count bytes as they arrive
// (never trust Content-Length) and cap the upload themselves (Req 8.4).
//
// Two per-user limiters keyed on the authenticated userId (the deletion/admin
// precedent), so NAT'd users do not collide and one user across IPs cannot
// bypass them. Export is 5/hour (Redis-outage fallback 3); import is 10/hour
// (fallback 6) and ONE instance is shared by both import routes, so a failed
// preview→confirm pair plus a Req 10.3 recovery pair still fit the bucket.
// Hand-authored `@swagger` blocks (billing/admin route style).
// ---------------------------------------------------------------------------

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const accountDataRouter = new Hono<AuthEnv>();

accountDataRouter.use(authMiddleware);

const exportRateLimit = createRateLimiter({
  name: 'account-export',
  max: 5,
  windowMs: 60 * 60 * 1000,
  fallbackMax: 3,
  keyGenerator: (c) => c.get('userId'),
});

const importRateLimit = createRateLimiter({
  name: 'account-import',
  max: 10,
  windowMs: 60 * 60 * 1000,
  fallbackMax: 6,
  keyGenerator: (c) => c.get('userId'),
});

// The digest the preview minted: a lowercase-hex sha256. A missing or malformed
// value is refused at the route before the body is spooled; a well-formed but
// wrong value is caught by the byte comparison inside `confirmImport`.
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * @swagger
 * /api/account-data/export:
 *   post:
 *     summary: Download the signed-in user's whole account as one archive.
 *     description: >
 *       Authed. Streams a `.zip` of every category the user owns from one
 *       consistent snapshot; secrets, billing and other users' data never
 *       travel. POST (not GET) so a cross-site navigation cannot start one. No
 *       password. Rate limited to 5 requests per hour per user (tightening to 3
 *       while the shared rate-limit store is unavailable). Scripts sign in for a
 *       session cookie and, on split-origin deployments, send an allowed
 *       `Origin` header.
 *     tags: [Account data]
 *     responses:
 *       200:
 *         description: >
 *           The archive, chunked. `Content-Disposition` names the file
 *           `tradr-export-YYYY-MM-DD.zip` (UTC date).
 *         content:
 *           application/zip:
 *             schema: { type: string, format: binary }
 *       401: { description: No valid session. }
 *       429: { description: Rate limit exceeded (5 / hour per user). }
 *       503: { description: "OBJECT_UNREACHABLE — object storage was unreachable before the download began." }
 */
accountDataRouter.post('/export', exportRateLimit, async (c) => {
  const { stream, filename } = await createExport(c.get('userId'));
  return c.body(stream, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
});

/**
 * @swagger
 * /api/account-data/import/preview:
 *   post:
 *     summary: Validate an uploaded archive and preview what it would restore.
 *     description: >
 *       Authed. Reads the raw `.zip` request body, validating it before any
 *       write: manifest present and version supported, counts match, every row
 *       strict, references resolve, invariants hold and the target account is
 *       empty. Writes nothing. Returns the server's own per-category counts, the
 *       source app version, the export date, any degradations and a `digest` the
 *       confirm call must echo. Rate limited with import (10 / hour per user,
 *       fallback 6). Scripts sign in for a session cookie and, on split-origin
 *       deployments, send an allowed `Origin` header.
 *     tags: [Account data]
 *     requestBody:
 *       required: true
 *       content:
 *         application/zip:
 *           schema: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: >
 *           `{ counts, sourceAppVersion, exportedAt, degradations, digest }`.
 *       400: { description: "ARCHIVE_VERSION_UNSUPPORTED, ARCHIVE_INVALID or ARCHIVE_EMPTY." }
 *       401: { description: No valid session. }
 *       409: { description: "IMPORT_TARGET_NOT_EMPTY — the account already holds data; the message names the categories." }
 *       413: { description: "ARCHIVE_TOO_LARGE — the upload exceeded a cap; the message names the cap." }
 *       429: { description: Rate limit exceeded (10 / hour per user). }
 */
accountDataRouter.post('/import/preview', importRateLimit, async (c) => {
  const preview = await previewImport(c.get('userId'), c.req.raw.body);
  return c.json(preview, 200);
});

/**
 * @swagger
 * /api/account-data/import:
 *   post:
 *     summary: Restore a previewed archive into the empty signed-in account.
 *     description: >
 *       Authed. Re-uploads the raw `.zip` request body with the preview's
 *       `digest` in the query; a missing or malformed digest, or one that does
 *       not match the uploaded bytes, is refused. Restores whole-or-nothing in
 *       one transaction, giving every row a fresh identifier, resolving platform
 *       references and overwriting preferences and the dashboard layout (advisor
 *       trade-data consent keeps the target's value). Rate limited with preview
 *       (10 / hour per user, fallback 6, shared bucket). Scripts sign in for a
 *       session cookie and, on split-origin deployments, send an allowed
 *       `Origin` header.
 *     tags: [Account data]
 *     parameters:
 *       - in: query
 *         name: digest
 *         required: true
 *         description: The sha256 hex digest the preview returned.
 *         schema: { type: string, pattern: '^[0-9a-f]{64}$' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/zip:
 *           schema: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: "ImportResult — the created count per category and the platform-reference resolutions."
 *       400: { description: "ARCHIVE_DIGEST_MISMATCH (missing, malformed or mismatched digest), ARCHIVE_VERSION_UNSUPPORTED, ARCHIVE_INVALID or ARCHIVE_EMPTY." }
 *       401: { description: No valid session. }
 *       409: { description: "IMPORT_TARGET_NOT_EMPTY — the account already holds data; the message names the categories." }
 *       413: { description: "ARCHIVE_TOO_LARGE — the upload exceeded a cap; the message names the cap." }
 *       429: { description: Rate limit exceeded (10 / hour per user). }
 *       500: { description: "IMPORT_FAILED — the restore rolled back; logged with the request id." }
 *       503: { description: "IMPORT_BUSY (another data operation held the lock) or OBJECT_UNREACHABLE (an image write failed before any row)." }
 */
accountDataRouter.post('/import', importRateLimit, async (c) => {
  const digest = c.req.query('digest');
  if (!digest || !DIGEST_RE.test(digest)) throw new ArchiveDigestMismatchError();
  const result = await confirmImport(c.get('userId'), c.req.raw.body, digest);
  return c.json(result, 200);
});

export default accountDataRouter;
