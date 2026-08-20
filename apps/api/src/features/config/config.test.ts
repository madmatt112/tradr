import { afterEach, describe, expect, it } from 'vitest';

import app from '@/app';
import { config } from '@/lib/config';

// GET /api/config — the public posture endpoint (REQ-9.4/9.5, NFR-Security).
//
// Every request here is raw: no session cookie, no CSRF token, no headers of
// any kind. That is the point — the SPA calls this before anyone has logged in,
// and these tests would fail if the route ever picked up authMiddleware.

/**
 * The allow-list. This endpoint is unauthenticated and ships on every
 * self-hosted instance, so its field list is a boundary rather than a default:
 * anything added here is published to strangers. The assertions below check
 * EQUALITY against this array, not containment, so adding a second field to the
 * response reds the build and forces the decision to be made deliberately.
 */
const ALLOWED_KEYS = ['registrationEnabled'];

describe('GET /api/config', () => {
  afterEach(() => {
    config.DISABLE_REGISTRATION = false;
    config.STRIPE_SECRET_KEY = undefined;
    config.STRIPE_WEBHOOK_SECRET = undefined;
    config.STRIPE_PRO_PRICE_ID = undefined;
    config.OBJECT_STORAGE_ENDPOINT = undefined;
    config.OBJECT_STORAGE_BUCKET = undefined;
    config.OBJECT_STORAGE_ACCESS_KEY_ID = undefined;
    config.OBJECT_STORAGE_SECRET_ACCESS_KEY = undefined;
    config.SMTP_HOST = undefined;
    config.EMAIL_FROM = undefined;
    config.WEB_BASE_URL = undefined;
    config.STOCK_QUOTE_API_KEY = undefined;
  });

  // 1. The default posture of an unconfigured self-hosted instance: open.
  it('reports registration enabled on an unconfigured instance', async () => {
    const res = await app.request('/api/config');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registrationEnabled: true });
  });

  // 2. The other state. isRegistrationEnabled() reads config live, so no module
  //    captured the value at load time and a direct mutation is enough.
  it('reports registration disabled when the operator closed sign-up', async () => {
    config.DISABLE_REGISTRATION = true;

    const res = await app.request('/api/config');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registrationEnabled: false });
  });

  // 3. THE TRIPWIRE. The response key set EQUALS the allow-list — a second
  //    field fails here even if every other assertion in this file is updated
  //    to accommodate it.
  it('returns exactly the allow-listed keys and nothing else', async () => {
    const body = await (await app.request('/api/config')).json();

    expect(Object.keys(body).sort()).toEqual([...ALLOWED_KEYS].sort());
    // Flat, too: a nested object would smuggle fields past a top-level key
    // check, so every value must be a primitive.
    for (const value of Object.values(body)) {
      expect(typeof value).not.toBe('object');
    }
  });

  // 4. No authentication. A raw request with no cookie is served, and the
  //    endpoint issues nothing back — it is a read of static posture.
  it('requires no authentication and sets no cookie', async () => {
    const res = await app.request('/api/config', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // 5. Cacheable, but not so cacheable that opening sign-up at launch looks
  //    broken for hours. One minute is the compromise.
  it('is publicly cacheable for a minute', async () => {
    const res = await app.request('/api/config');

    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  // 6. NFR-Security. With billing, object storage, email and market data all
  //    configured — every is*Configured() predicate this endpoint could
  //    plausibly have been asked to report — the body is byte-identical. A
  //    stranger learns nothing about the deployment's infrastructure, and no
  //    secret value appears anywhere in the response.
  it('discloses nothing about configured providers, storage, billing or email', async () => {
    config.STRIPE_SECRET_KEY = 'sk_test_secret_value';
    config.STRIPE_WEBHOOK_SECRET = 'whsec_secret_value';
    config.STRIPE_PRO_PRICE_ID = 'price_secret_value';
    config.OBJECT_STORAGE_ENDPOINT = 'https://storage.example.invalid';
    config.OBJECT_STORAGE_BUCKET = 'secret-bucket';
    config.OBJECT_STORAGE_ACCESS_KEY_ID = 'akid_secret_value';
    config.OBJECT_STORAGE_SECRET_ACCESS_KEY = 'sak_secret_value';
    config.SMTP_HOST = 'smtp.example.invalid';
    config.EMAIL_FROM = 'noreply@example.invalid';
    config.WEB_BASE_URL = 'https://app.example.invalid';
    config.STOCK_QUOTE_API_KEY = 'quote_secret_value';

    const res = await app.request('/api/config');
    const raw = await res.text();

    expect(res.status).toBe(200);
    expect(raw).toBe(JSON.stringify({ registrationEnabled: true }));
    for (const secret of [
      'sk_test_secret_value',
      'whsec_secret_value',
      'price_secret_value',
      'storage.example.invalid',
      'secret-bucket',
      'akid_secret_value',
      'sak_secret_value',
      'smtp.example.invalid',
      'noreply@example.invalid',
      'app.example.invalid',
      'quote_secret_value',
      'DATABASE_URL',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });
});
