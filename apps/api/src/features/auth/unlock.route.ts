// Account-unlock route (design C6; Req 3.7, 4.7, 4.8). Mounted in app.ts as a
// FIFTH router on the /api/auth base (the password-reset / verification /
// two-factor double-mount precedent) so the frozen auth.route.ts surface stays
// untouched; the global CORS + anti-CSRF middleware in app.ts cover it. The
// endpoint is PUBLIC — the raw token travels in the request body (the emailed
// link's URL fragment). It consumes the token and clears the lock in one
// transaction; it sends no mail and needs no email config.

import { Hono } from 'hono';

import { UnlockAccountSchema } from '@tradr/shared/schemas/auth';

import { validate } from '@/lib/validation';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { unlockAccount } from './lockout.service';

const unlock = new Hono();

/**
 * @swagger
 * /api/auth/unlock:
 *   post:
 *     summary: Clear an account lockout with an emailed unlock token.
 *     description: >
 *       Public. Rate limited by client IP (10 / 15 min, the login posture —
 *       token guessing is primarily throttled by the token's 256-bit entropy +
 *       15 min TTL), tightening to 5 while the shared rate-limit store is
 *       unavailable. Atomically consumes the single-use `account_unlock` token
 *       and clears the per-address lock for its owner. Expired, already-consumed,
 *       unrecognized, and wrong-purpose tokens are indistinguishable: one generic
 *       400 INVALID_OR_EXPIRED_TOKEN. An unlock for an address that is no longer
 *       locked still returns 200 — the token was spent. Sends no mail and stays
 *       functional when the instance has no email configured.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 pattern: '^[0-9a-f]{64}$'
 *                 description: The raw token from the emailed link's URL fragment.
 *     responses:
 *       200: { description: '{ success: true } — the lock (if any) was cleared.' }
 *       400: { description: 'Validation error, or INVALID_OR_EXPIRED_TOKEN (expired / consumed / unknown / wrong purpose — one generic body).' }
 *       429: { description: Rate limit reached (IP-keyed). }
 */
unlock.post(
  '/unlock',
  // IP-keyed, the login posture: hardens to 5/container under Redis outage.
  // Limiter before validation — the house pattern.
  createRateLimiter({
    name: 'unlock',
    max: 10,
    windowMs: 15 * 60 * 1000,
    fallbackMax: 5,
  }),
  validate('json', UnlockAccountSchema),
  async (c) => {
    // No isEmailConfigured() gate: unlock consumes an existing token and sends
    // nothing, so a live emailed link keeps working if SMTP config is removed.
    const { token } = c.req.valid('json');
    await unlockAccount(token);
    return c.json({ success: true }, 200);
  },
);

export default unlock;
