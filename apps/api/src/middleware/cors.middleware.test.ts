// Task 15 (hosted-platform): split-origin CORS middleware. Verifies the
// allow-list echo + credentials, preflight handling, and that when split-origin
// is unconfigured NO CORS headers are emitted (REQ-5.1/5.3, REQ-6.3).

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '@/lib/config';

import { corsMiddleware } from './cors.middleware';

const ALLOWED = 'https://app.example.com';
const OTHER = 'https://evil.example.com';
const ORIGINAL = config.CORS_ALLOWED_ORIGINS;

function buildApp() {
  const app = new Hono();
  app.use(corsMiddleware);
  app.get('/api/thing', (c) => c.json({ ok: true }));
  app.post('/api/thing', (c) => c.json({ ok: true }));
  return app;
}

afterEach(() => {
  config.CORS_ALLOWED_ORIGINS = ORIGINAL;
});

describe('corsMiddleware (split-origin ON)', () => {
  beforeEach(() => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
  });

  it('echoes an allow-listed Origin and allows credentials (never `*`)', async () => {
    const res = await buildApp().request('/api/thing', { headers: { Origin: ALLOWED } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('never echoes a non-allow-listed Origin', async () => {
    const res = await buildApp().request('/api/thing', { headers: { Origin: OTHER } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('handles the OPTIONS preflight for an allow-listed Origin', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('denies the OPTIONS preflight for a non-allow-listed Origin (no ACAO)', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'OPTIONS',
      headers: { Origin: OTHER, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('covers a GET route (e.g. the image proxy)', async () => {
    const res = await buildApp().request('/api/thing', {
      method: 'GET',
      headers: { Origin: ALLOWED },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
  });
});

describe('corsMiddleware (split-origin OFF)', () => {
  it('emits no CORS headers at all — same-origin behavior unchanged', async () => {
    config.CORS_ALLOWED_ORIGINS = '';
    const res = await buildApp().request('/api/thing', { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });
});
