// Pre-task survey (Task 10): `rg -n "logger" apps/api/src/middleware/error.middleware.ts apps/api/src/lib/`
// confirmed the middleware imports `logger` from `@/lib/logger` and invokes
// `logger.error(message, { code, ... })`. The structured payload contains
// { code, message, requestId } (+ stack on the unknown branch).
// Surveyed target: `logger.error` on the `@/lib/logger` module.

import { Hono } from 'hono';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { z } from 'zod';

import { AppError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { validate } from '@/lib/validation';
import { errorHandler } from '@/middleware/error.middleware';
import { loggingMiddleware } from '@/middleware/logging.middleware';

function buildApp(setup: (app: Hono) => void) {
  const app = new Hono();
  app.use(loggingMiddleware);
  setup(app);
  app.onError(errorHandler);
  return app;
}

describe('error.middleware ValidationError envelope', () => {
  it('preserves Zod issue code in fields[] (NOT VALIDATION_ERROR)', async () => {
    const schema = z.object({ name: z.string().min(1) });
    const app = buildApp((a) => {
      a.post('/t', validate('json', schema), (c) => c.json({ ok: true }));
    });

    const res = await app.request('/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields: Array<{ code: string }> } };
    expect(body.error.fields).toBeDefined();
    expect(body.error.fields[0].code).toBe('too_small');
    expect(body.error.fields[0].code).not.toBe('VALIDATION_ERROR');
  });

  it('falls back to VALIDATION_ERROR fields[] when err.fields is undefined', async () => {
    const app = buildApp((a) => {
      a.get('/t', () => {
        throw new ValidationError('x', { f: 'm' });
      });
    });

    const res = await app.request('/t');

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { fields: Array<{ path: string; code: string; message: string }> };
    };
    expect(body.error.fields[0]).toEqual({
      path: 'f',
      code: 'VALIDATION_ERROR',
      message: 'm',
    });
  });

  it('retains all fields at same path; details retains LAST', async () => {
    // Build a custom schema that emits two issues at the same path.
    const schema = z.object({ n: z.string() }).superRefine((_val, ctx) => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['n'],
        message: 'first issue',
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['n'],
        message: 'second issue',
      });
    });
    const app = buildApp((a) => {
      a.post('/t', validate('json', schema), (c) => c.json({ ok: true }));
    });

    const res = await app.request('/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: 'anything' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        fields: Array<{ path: string; message: string }>;
        details: Record<string, string>;
      };
    };
    const sameField = body.error.fields.filter((f) => f.path === 'n');
    expect(sameField).toHaveLength(2);
    expect(sameField.map((f) => f.message)).toEqual(['first issue', 'second issue']);
    expect(body.error.details.n).toBe('second issue');
  });

  describe('prepared-statement pooler diagnostic (REQ-9.5)', () => {
    class PgError extends Error {
      constructor(
        public code: string,
        message: string,
      ) {
        super(message);
      }
    }

    it.each(['42P05', '26000'])(
      'classifies SQLSTATE %s and surfaces an actionable DB_TRANSACTION_POOLER diagnostic',
      async (code) => {
        const app = buildApp((a) => {
          a.get('/t', () => {
            throw new PgError(code, 'prepared statement "s1" already exists');
          });
        });

        const res = await app.request('/t');

        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('DB_POOLER_MISCONFIG');
        expect(body.error.message).toContain('DB_TRANSACTION_POOLER');
      },
    );

    it('leaves an unrelated pg error code on the generic INTERNAL_ERROR path', async () => {
      const app = buildApp((a) => {
        a.get('/t', () => {
          throw new PgError('23505', 'duplicate key value violates unique constraint');
        });
      });

      const res = await app.request('/t');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('logger fires with structured payload on every error family', () => {
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spy = vi.spyOn(logger, 'error');
      spy.mockReset();
    });

    it.each([
      {
        label: 'ValidationError',
        throwIt: () => {
          throw new ValidationError('bad', { f: 'm' });
        },
        payloadMatcher: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          path: '/t',
          fields: ['f'],
          requestId: expect.any(String),
        }),
      },
      {
        label: 'AppError',
        throwIt: () => {
          throw new AppError(418, 'CUSTOM_APP_ERROR', 'teapot');
        },
        payloadMatcher: expect.objectContaining({
          code: 'CUSTOM_APP_ERROR',
          requestId: expect.any(String),
        }),
      },
      {
        label: 'unknown Error',
        throwIt: () => {
          throw new Error('boom');
        },
        payloadMatcher: expect.objectContaining({
          error: 'boom',
          requestId: expect.any(String),
        }),
      },
    ])('logs $label with structured payload', async ({ throwIt, payloadMatcher }) => {
      const app = buildApp((a) => {
        a.get('/t', (c) => {
          throwIt();
          return c.json({ unreachable: true });
        });
      });

      await app.request('/t');

      // v3-4: assert on log MESSAGE CONTENT. The middleware calls
      // logger.error(message, payload), so each entry in spy.mock.calls is a
      // 2-element [message, payload] tuple. Payload shape varies per error
      // family — ValidationError includes route path and failing field names
      // per REQ-6.12; unknown errors keep the pre-existing { error, stack,
      // requestId } shape.
      expect(spy.mock.calls).toContainEqual([expect.any(String), payloadMatcher]);
    });
  });
});
