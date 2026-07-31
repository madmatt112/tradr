// Email-verification routes (design Component 6, REQ-5). Mounted in app.ts as
// a THIRD router on the /api/auth base (the password-reset double-mount
// precedent) so the frozen auth.route.ts surface stays untouched (REQ-1.1);
// the global CORS + anti-CSRF middleware in app.ts cover it.
//
// - POST /verify-email is public: the emailed link lands on a page whose
//   user-gesture POST carries the token in the body — the GET never mutates
//   (D6/REQ-4.8), and verification works with SMTP unconfigured (D12).
// - POST /verify-email/resend sits behind authMiddleware (D11): only the
//   account owner can trigger it, so no-enumeration holds by construction.
//   authMiddleware runs BEFORE the limiter so the limiter can key on the
//   authenticated userId (per-account = per-target, REQ-3.8-for-resend).

import { Hono } from 'hono';

import { VerifyEmailSchema } from '@tradr/shared/schemas/auth';

import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { resendVerification, verifyEmail } from './verification.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const verification = new Hono<AuthEnv>();

/**
 * @swagger
 * /api/auth/verify-email:
 *   post:
 *     summary: Verify an email address with an emailed token (gesture-consumed).
 *     description: >
 *       Public. Rate limited by client IP (10 / 15 min, the login posture; token
 *       guessing is primarily throttled by the token's 256-bit entropy + 24 h TTL).
 *       Atomically consumes the single-use verification token and marks the account
 *       email-verified in one transaction. Expired, already-consumed, and unrecognized
 *       tokens are indistinguishable: one generic 400 INVALID_OR_EXPIRED_TOKEN (the
 *       frontend then offers the resend path). Consumption is THIS POST — fetching the
 *       emailed GET link never mutates, so prefetchers and link scanners burn nothing.
 *       Fully functional when the instance has no email configured (consuming an
 *       existing token sends nothing).
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
 *       200: { description: '{ success: true } — account marked email-verified, token consumed.' }
 *       400: { description: Validation error, or INVALID_OR_EXPIRED_TOKEN (expired / consumed / unknown — one generic body). }
 *       429: { description: Rate limit reached (IP-keyed). }
 */
verification.post(
  '/verify-email',
  // IP-keyed, the login posture: hardens to 5/container under Redis outage.
  // Limiter before validation — the house pattern.
  createRateLimiter({
    name: 'verify-email',
    windowMs: 15 * 60 * 1000,
    max: 10,
    fallbackMax: 5,
  }),
  validate('json', VerifyEmailSchema),
  async (c) => {
    // NO isEmailConfigured() gate (D12): consuming an existing token sends
    // nothing, so nobody holding a live emailed link is stranded when SMTP
    // config is removed mid-flow.
    const { token } = c.req.valid('json');
    await verifyEmail(token);
    return c.json({ success: true }, 200);
  },
);

/**
 * @swagger
 * /api/auth/verify-email/resend:
 *   post:
 *     summary: Resend the verification email for the authenticated account.
 *     description: >
 *       Authenticated (session cookie) — only the account owner can trigger a resend,
 *       so account enumeration is impossible by construction. Rate limited per
 *       authenticated userId (3 / 1 h — per-account equals per-target, bound). No
 *       request body. Issues a fresh single-use verification token (24 h TTL,
 *       newest-wins over prior tokens) and dispatches the verification email WITHOUT
 *       awaiting delivery. Already-verified accounts get 409 ALREADY_VERIFIED (an
 *       authed self-fact); an instance with no email configured gets 409
 *       EMAIL_NOT_CONFIGURED — the two codes are distinct because the UI keys on code.
 *     tags: [Auth]
 *     responses:
 *       200: { description: '{ success: true } — verification email dispatched (delivery not awaited).' }
 *       401: { description: Not authenticated. }
 *       409: { description: ALREADY_VERIFIED (account already verified) or EMAIL_NOT_CONFIGURED (instance has no email configured) — distinct codes. }
 *       429: { description: Rate limit reached (userId-keyed). }
 */
verification.post(
  '/verify-email/resend',
  // authMiddleware FIRST: the limiter keys on the authenticated userId (D11).
  authMiddleware,
  createRateLimiter({
    name: 'verify-resend',
    windowMs: 60 * 60 * 1000,
    max: 3,
    fallbackMax: 3,
    keyGenerator: (c) => c.get('userId'),
  }),
  async (c) => {
    await resendVerification(c.get('userId'));
    // Identical on every configured non-409 branch: issued, or issuance
    // conflict swallowed by the service (Component 4's pinned translation).
    return c.json({ success: true }, 200);
  },
);

export default verification;
