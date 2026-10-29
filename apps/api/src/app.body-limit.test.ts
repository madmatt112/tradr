import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import * as billingService from '@/features/billing/billing.service';
import { config } from '@/lib/config';
import {
  BODY_LIMIT_EXEMPT_ROUTES,
  GLOBAL_BODY_LIMIT_BYTES,
} from '@/middleware/body-limit.middleware';

/**
 * Contract block — one row per success criterion from tasks.md task 3.
 *
 * | # | Pre-condition | Call (through the seam) | Observable result | Expected-value source |
 * |---|---|---|---|---|
 * | 1 | split-origin ON, a cross-origin `Origin`, no session cookie, body = CAP+1 bytes | `app.request('/api/tags', { method: 'POST', body, headers })` | 413, exact `PAYLOAD_TOO_LARGE` envelope, `X-Request-Id` matches `error.requestId`, `X-Content-Type-Options: nosniff` | Requirements 1.2, 1.5, 1.7, design Data Models |
 * | 2 | default config, no session cookie, body = exactly CAP bytes | same call, `/api/tags` | 401 (proves the body passed the limit) | Requirement 1.1 (red-first only together with 1.2, as task 1's own test notes) |
 * | 3 | Stripe configured, a validly signed oversized (CAP+1 byte) raw event payload | `app.request('/api/billing/webhook', { method: 'POST', body, headers })` | 413, and the mocked `handleStripeEvent` is never called | Requirements 3.1, 3.3 |
 * | 4 | none — the real `app` and task 1's exempt table | unique POST paths in `app.routes`, filtered to those `BODY_LIMIT_EXEMPT_ROUTES` matches | equals exactly the six Requirement 2.6 routes | Requirement 2.6, design exempt table |
 *
 * Row 4 already passes before this task's `app.ts` change (task 1 shipped the
 * table; no router this task touches changes `app.routes`), and no existing
 * assertion ties the exempt table to the real, mounted route set — task 1's own
 * test only checks illustrative, hand-built paths. Written as a regression
 * guard, not a red test (tasks.md: "the exempt-route guard passes once task 1
 * has shipped the table").
 */

vi.mock('@/features/billing/billing.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/billing/billing.service')>();
  return { ...actual, handleStripeEvent: vi.fn().mockResolvedValue({ kind: 'acked' }) };
});

const CAP = GLOBAL_BODY_LIMIT_BYTES;

function bytes(n: number): string {
  return 'a'.repeat(n);
}

/** A parseable Stripe event JSON string of exactly `targetBytes` bytes. */
function paddedWebhookPayload(targetBytes: number): string {
  const obj: Record<string, unknown> = {
    id: 'evt_test_pad',
    object: 'event',
    type: 'customer.subscription.updated',
    data: { object: {} },
    pad: '',
  };
  const withoutPad = JSON.stringify(obj).length;
  obj.pad = 'a'.repeat(targetBytes - withoutPad);
  return JSON.stringify(obj);
}

const ALLOWED_ORIGIN = 'https://app.example.com';
const EVIL_ORIGIN = 'https://evil.example.com';
const ORIGINAL_CORS = config.CORS_ALLOWED_ORIGINS;

afterEach(() => {
  config.CORS_ALLOWED_ORIGINS = ORIGINAL_CORS;
});

describe('the global body limit mounted on the real app', () => {
  it('POST /api/tags over the cap, no session, gets 413 — not CSRF, not auth — with the security headers', async () => {
    // Split-origin ON with a non-allow-listed Origin: CSRF would 403 a body
    // under the cap, and no session would 401 past CSRF. Getting 413 proves
    // the limit runs before both.
    config.CORS_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
    const body = bytes(CAP + 1);
    const res = await app.request('/api/tags', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        Origin: EVIL_ORIGIN,
      },
    });

    expect(res.status).toBe(413);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const json = (await res.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json.error.message).toBe(`Request body exceeds ${CAP} bytes`);
    expect(res.headers.get('X-Request-Id')).toBe(json.error.requestId);
  });

  it('the same route with exactly 1,048,576 bytes and no session gets 401', async () => {
    const body = bytes(CAP);
    const res = await app.request('/api/tags', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });

    expect(res.status).toBe(401);
  });

  it('POST /api/billing/webhook over the cap gets 413 and handleStripeEvent is never called', async () => {
    const prevSecret = config.STRIPE_SECRET_KEY;
    const prevWebhookSecret = config.STRIPE_WEBHOOK_SECRET;
    config.STRIPE_SECRET_KEY = 'sk_test_dummy_for_webhook_signing';
    config.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy_webhook_secret';
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);

    // Signed over the EXACT oversized bytes: at base, without the global
    // limit, this is a valid webhook delivery that reaches handleStripeEvent.
    const payload = paddedWebhookPayload(CAP + 1);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: config.STRIPE_WEBHOOK_SECRET,
    });

    try {
      const res = await app.request('/api/billing/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          'Stripe-Signature': signature,
        },
      });

      expect(res.status).toBe(413);
      expect(vi.mocked(billingService.handleStripeEvent)).not.toHaveBeenCalled();
    } finally {
      config.STRIPE_SECRET_KEY = prevSecret;
      config.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
    }
  });

  it('the exempt table matches exactly the six real routes of Requirement 2.6 (regression guard)', () => {
    const realPostPaths = new Set(
      app.routes.filter((route) => route.method === 'POST').map((route) => route.path),
    );
    const matched = [...realPostPaths].filter((path) =>
      BODY_LIMIT_EXEMPT_ROUTES.some((route) => route.method === 'POST' && route.pattern.test(path)),
    );

    expect(matched.sort()).toEqual(
      [
        '/api/advisor/conversations/:id/messages/stream',
        '/api/advisor/conversations/new/messages/stream',
        '/api/positions/:id/images',
        '/api/csv-import/preview',
        '/api/account-data/import/preview',
        '/api/account-data/import',
      ].sort(),
    );
  });
});
