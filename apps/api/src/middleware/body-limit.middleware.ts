import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/** The one definition of the global cap (Requirement 1.8); never an env var. */
export const GLOBAL_BODY_LIMIT_BYTES = 1_048_576;

/**
 * Routes that keep their own, larger body cap and must not be read, buffered or
 * wrapped by the global limiter (design Component 1, Requirement 2.6).
 */
export const BODY_LIMIT_EXEMPT_ROUTES: ReadonlyArray<{
  method: 'POST';
  pattern: RegExp;
  reason: string;
}> = [
  {
    method: 'POST',
    pattern: /^\/api\/advisor\/conversations\/[^/]+\/messages\/stream$/,
    reason: 'advisor stream routes cap themselves at ADVISOR_MAX_REQUEST_BYTES',
  },
  {
    method: 'POST',
    pattern: /^\/api\/positions\/[^/]+\/images$/,
    reason: 'position image upload caps itself at 4,504,096 bytes',
  },
  {
    method: 'POST',
    pattern: /^\/api\/csv-import\/preview$/,
    reason: 'CSV import preview caps itself via CSV_IMPORT_MAX_FILE_BYTES',
  },
  {
    method: 'POST',
    pattern: /^\/api\/account-data\/import\/preview$/,
    reason: 'archive import preview caps itself via ARCHIVE_CAPS.maxUploadBytes',
  },
  {
    method: 'POST',
    pattern: /^\/api\/account-data\/import$/,
    reason: 'archive import caps itself via ARCHIVE_CAPS.maxUploadBytes',
  },
];

function isExemptRoute(method: string, path: string): boolean {
  return BODY_LIMIT_EXEMPT_ROUTES.some(
    (route) => route.method === method && route.pattern.test(path),
  );
}

const limitRequestBody = bodyLimit({
  maxSize: GLOBAL_BODY_LIMIT_BYTES,
  onError: (c) => {
    const requestId = c.get('requestId') as string | undefined;
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds ${GLOBAL_BODY_LIMIT_BYTES} bytes`,
          requestId,
        },
      },
      413,
    );
  },
});

/**
 * Refuses a request body over 1 MiB before any router, CSRF check, session
 * lookup, rate limiter or parser runs. Exempt routes are skipped entirely —
 * never read, buffered or wrapped — so their own, larger caps still apply.
 */
export const globalBodyLimitMiddleware: MiddlewareHandler = (c, next) => {
  if (isExemptRoute(c.req.method, c.req.path)) {
    return next();
  }
  return limitRequestBody(c, next);
};
