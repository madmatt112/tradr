// Task 15 (hosted-platform): anti-CSRF middleware. Verifies deny-by-default on
// non-safe methods (exact allow-list Origin, Referer fallback, absent/`null`
// denied), the Stripe-webhook exemption, safe-method pass-through, and that
// split-origin OFF means no enforcement (REQ-6.1/6.2/6.3/6.5).

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '@/lib/config';
import { errorHandler } from '@/middleware/error.middleware';

import { csrfMiddleware } from './csrf.middleware';

const ALLOWED = 'https://app.example.com';
const EVIL = 'https://evil.example.com';
const ORIGINAL = config.CORS_ALLOWED_ORIGINS;

function buildApp() {
  const app = new Hono();
  app.use(csrfMiddleware);
  app.get('/api/thing', (c) => c.json({ ok: true }));
  app.post('/api/thing', (c) => c.json({ ok: true }));
  app.delete('/api/thing', (c) => c.json({ ok: true }));
  app.post('/api/billing/webhook', (c) => c.json({ webhook: true }));
  // Look-alike / sub-route paths: exempted ONLY on an exact match, so these must
  // still be CSRF-enforced. Handlers exist so a wrongly-exempt path would 200.
  app.post('/api/billing/webhook-evil', (c) => c.json({ evil: true }));
  app.post('/api/billing/webhook/anything', (c) => c.json({ sub: true }));
  app.onError(errorHandler);
  return app;
}

async function code(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

afterEach(() => {
  config.CORS_ALLOWED_ORIGINS = ORIGINAL;
});

describe('csrfMiddleware (split-origin ON)', () => {
  beforeEach(() => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
  });

  it('allows a non-safe method from an allow-listed Origin (positive)', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'POST',
      headers: { Origin: ALLOWED },
    });
    expect(res.status).toBe(200);
  });

  it('allows when Origin is absent but the Referer origin is allow-listed', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'POST',
      headers: { Referer: `${ALLOWED}/conversations/1` },
    });
    expect(res.status).toBe(200);
  });

  it('denies a cross-origin non-safe method with 403 CSRF_FORBIDDEN', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'POST',
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('denies by default when Origin is entirely absent', async () => {
    const res = await buildApp().request('/api/thing', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('denies a literal `null` Origin (opaque origin)', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'POST',
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('denies a cross-origin DELETE (all non-safe methods covered)', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'DELETE',
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(403);
  });

  it('exempts the Stripe webhook (no Origin, signature-authed)', async () => {
    const res = await buildApp().request('/api/billing/webhook', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('still exempts the exact webhook path even from a cross-origin POST', async () => {
    const res = await buildApp().request('/api/billing/webhook', {
      method: 'POST',
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(200);
  });

  it('does NOT exempt a look-alike path (exact match only)', async () => {
    const res = await buildApp().request('/api/billing/webhook-evil', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('does NOT exempt a webhook sub-route (exact match only)', async () => {
    const res = await buildApp().request('/api/billing/webhook/anything', {
      method: 'POST',
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('leaves safe methods (GET) untouched even cross-origin', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'GET',
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(200);
  });
});

describe('csrfMiddleware (split-origin OFF)', () => {
  it('does not enforce — a cross-origin POST reaches the handler', async () => {
    config.CORS_ALLOWED_ORIGINS = '';
    const res = await buildApp().request('/api/thing', {
      method: 'POST',
      headers: { Origin: EVIL },
    });
    expect(res.status).toBe(200);
  });
});
