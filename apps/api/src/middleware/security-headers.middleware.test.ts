// Task 15 (security-hardening): security-headers middleware. Verifies the
// pinned header set (design C9) lands on every response shape — a 200, a 404,
// a thrown AppError, and the CSRF 403 — and that Strict-Transport-Security is
// absent by default and present, with the exact value, only when explicitly
// turned on (Req 5.1-5.5).

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { csrfMiddleware } from '@/middleware/csrf.middleware';
import { errorHandler } from '@/middleware/error.middleware';

import { securityHeadersMiddleware } from './security-headers.middleware';

const ALLOWED = 'https://app.example.com';
const EVIL = 'https://evil.example.com';
const ORIGINAL_CORS = config.CORS_ALLOWED_ORIGINS;

function buildApp(hstsEnabled?: boolean) {
  const app = new Hono();
  app.use(
    hstsEnabled === undefined
      ? securityHeadersMiddleware()
      : securityHeadersMiddleware(hstsEnabled),
  );
  app.use(csrfMiddleware);
  app.get('/ok', (c) => c.json({ ok: true }));
  app.get('/throws', () => {
    throw new AppError(400, 'SOME_ERROR', 'boom');
  });
  app.post('/mutate', (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

/** Req 5.2/5.4: the pinned, always-on header values design C9 specifies. */
function expectPinnedHeaders(res: Response) {
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-site');
}

describe('securityHeadersMiddleware', () => {
  it('sends the pinned headers on a 200 response', async () => {
    const res = await buildApp(false).request('/ok');
    expect(res.status).toBe(200);
    expectPinnedHeaders(res);
  });

  it('sends the pinned headers on a 404 (unmatched route)', async () => {
    const res = await buildApp(false).request('/does-not-exist');
    expect(res.status).toBe(404);
    expectPinnedHeaders(res);
  });

  it('sends the pinned headers on a thrown AppError response', async () => {
    const res = await buildApp(false).request('/throws');
    expect(res.status).toBe(400);
    expectPinnedHeaders(res);
  });

  it('sends the pinned headers on the CSRF 403 (split-origin denial)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    try {
      const res = await buildApp(false).request('/mutate', {
        method: 'POST',
        headers: { Origin: EVIL },
      });
      expect(res.status).toBe(403);
      expectPinnedHeaders(res);
    } finally {
      config.CORS_ALLOWED_ORIGINS = ORIGINAL_CORS;
    }
  });

  it('sends no Strict-Transport-Security header by default (config.HSTS_ENABLED false)', async () => {
    const res = await buildApp().request('/ok');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('sends Strict-Transport-Security with the pinned value only when enabled', async () => {
    const res = await buildApp(true).request('/ok');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});
