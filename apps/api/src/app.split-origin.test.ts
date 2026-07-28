// Task 15 (hosted-platform): wiring test. Proves the global CORS + anti-CSRF
// middleware are composed BEFORE the routes in app.ts, that anti-CSRF is active
// on cookie-auth mutating routes when split-origin is on, that the Stripe
// webhook is exempt, and that split-origin OFF is unchanged (no CSRF
// enforcement, no CORS headers) — REQ-6.3/6.4.

import { afterEach, describe, expect, it } from 'vitest';

import app from '@/app';
import { config } from '@/lib/config';

const ALLOWED = 'https://app.example.com';
const EVIL = 'https://evil.example.com';
const ORIGINAL = config.CORS_ALLOWED_ORIGINS;

async function code(res: Response): Promise<string | undefined> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return undefined;
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

afterEach(() => {
  config.CORS_ALLOWED_ORIGINS = ORIGINAL;
});

describe('split-origin middleware wiring — ON', () => {
  it('anti-CSRF is active on a cookie-auth mutating route (POST /api/accounts)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { Origin: EVIL, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('anti-CSRF covers the auth mutating routes (POST /api/auth/login)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { Origin: EVIL, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('exempts the Stripe webhook from anti-CSRF (no Origin)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/billing/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(await code(res)).not.toBe('CSRF_FORBIDDEN');
  });

  it('CORS is wired: an allow-listed preflight is answered with ACAO', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/accounts', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
  });
});

describe('split-origin middleware wiring — OFF (default)', () => {
  it('no anti-CSRF enforcement: a cross-origin POST is not CSRF-blocked', async () => {
    config.CORS_ALLOWED_ORIGINS = '';
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { Origin: EVIL, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(await code(res)).not.toBe('CSRF_FORBIDDEN');
  });

  it('no CORS headers: an Origin request gets no Access-Control-Allow-Origin', async () => {
    config.CORS_ALLOWED_ORIGINS = '';
    const res = await app.request('/api/accounts', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ── Task 22 (hosted-platform): split-origin INTEGRATION coverage ────────────
// Extends the Task 15 wiring above with the explicit Task-22 legs, driven via
// app.request() against the composed app booted with CORS_ALLOWED_ORIGINS set
// (NOT a two-real-browser-origin Playwright setup): a credentialed allow-listed
// request succeeds (preflight carries ACAO + Allow-Credentials, the actual
// mutating POST passes the CSRF gate), a forged mutating POST from a
// non-allow-listed / ABSENT / `null` Origin is rejected (403 CSRF_FORBIDDEN),
// the Stripe webhook stays exempt even cross-origin, and the self-host
// same-origin (OFF) flow is unchanged (REQ-5.1/5.3, REQ-6.2/6.5, REQ-1.6).
describe('split-origin integration — Task 22', () => {
  it('a credentialed allow-listed preflight carries ACAO + Allow-Credentials', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/accounts', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('an allow-listed credentialed mutating POST passes the CSRF gate (not 403)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
      body: '{}',
    });
    // Passes CSRF (allow-listed Origin); stops at authMiddleware (401), not 403.
    expect(res.status).not.toBe(403);
    expect(await code(res)).not.toBe('CSRF_FORBIDDEN');
  });

  it('a forged mutating POST from an ABSENT Origin is rejected (403 CSRF_FORBIDDEN)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('a forged mutating POST from a `null` Origin is rejected (403 CSRF_FORBIDDEN)', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_FORBIDDEN');
  });

  it('the Stripe webhook stays exempt even from a cross-origin Origin', async () => {
    config.CORS_ALLOWED_ORIGINS = ALLOWED;
    const res = await app.request('/api/billing/webhook', {
      method: 'POST',
      headers: { Origin: EVIL, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(await code(res)).not.toBe('CSRF_FORBIDDEN');
  });

  it('same-origin self-host flow is unchanged with split-origin OFF', async () => {
    config.CORS_ALLOWED_ORIGINS = '';
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(await code(res)).not.toBe('CSRF_FORBIDDEN');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
