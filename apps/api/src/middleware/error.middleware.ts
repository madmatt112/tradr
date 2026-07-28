import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { AppError, RateLimitError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { captureServerException } from '@/lib/posthog';

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get('requestId') as string | undefined;

  if (err instanceof RateLimitError) {
    c.header('Retry-After', String(err.retryAfter));
    return c.json(
      {
        error: { code: err.code, message: err.message, requestId },
      },
      err.statusCode as ContentfulStatusCode,
    );
  }

  if (err instanceof ValidationError) {
    const details = err.details ?? {};
    const fields =
      err.fields ??
      Object.entries(details).map(([path, message]) => ({
        path,
        code: 'VALIDATION_ERROR',
        message,
      }));
    logger.error('Request error', {
      code: err.code,
      message: err.message,
      path: c.req.path,
      fields: fields.map((f) => f.path),
      requestId,
    });
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details,
          fields,
          requestId,
        },
      },
      err.statusCode as ContentfulStatusCode,
    );
  }

  if (err instanceof AppError) {
    logger.error('Request error', {
      code: err.code,
      message: err.message,
      requestId,
    });
    return c.json(
      {
        error: { code: err.code, message: err.message, requestId },
      },
      err.statusCode as ContentfulStatusCode,
    );
  }

  // Prepared-statement error behind a transaction-mode pooler (REQ-9.5). Postgres
  // raises 42P05 (duplicate_prepared_statement) / 26000 (invalid_sql_statement_name)
  // when prepared statements collide across pooled sessions — the failure mode an
  // operator hits behind a transaction pooler with DB_TRANSACTION_POOLER unset.
  // Surface an ACTIONABLE diagnostic pointing at the flag instead of a generic 500.
  const pgCode = (err as { code?: unknown }).code;
  if (pgCode === '42P05' || pgCode === '26000') {
    logger.error('Prepared-statement error (transaction-pooler misconfiguration?)', {
      code: pgCode,
      message: err.message,
      requestId,
    });
    return c.json(
      {
        error: {
          code: 'DB_POOLER_MISCONFIG',
          message:
            'Database prepared-statement error behind a transaction pooler; set ' +
            'DB_TRANSACTION_POOLER=true so the driver runs with prepare:false.',
          requestId,
        },
      },
      500,
    );
  }

  // Unknown error
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    requestId,
  });
  const userId = c.get('userId') as string | undefined;
  captureServerException(err, userId);

  return c.json(
    {
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId },
    },
    500,
  );
};
