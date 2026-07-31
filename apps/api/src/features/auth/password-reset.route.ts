// Password-reset routes (design Component 5, REQ-3/REQ-4). Mounted in app.ts
// as a SECOND router on the /api/auth base (the positions/fillsRouter
// double-mount precedent) so the frozen auth.route.ts surface stays untouched
// (REQ-1.1); the global CORS + anti-CSRF middleware in app.ts cover it.
//
// The request endpoint's middleware chain is the design's normative
// no-enumeration shape (Architecture §no-enumeration) and its ORDER is
// load-bearing: the IP limiter runs before validation (the house
// limiter-before-validation pattern, register posture), while the per-target
// limiter is mounted AFTER validate() so its key is the schema-NORMALIZED
// email (trim + lowercase — REQ-3.8; raw-string keying is evaded by case
// variants that all resolve to the same account). Both limiters key on what
// was SUBMITTED, never on whether it matched — 429 behavior is
// account-existence-independent (REQ-3.4).

import { Hono } from 'hono';

import {
  PasswordResetCompleteSchema,
  PasswordResetRequestSchema,
} from '@tradr/shared/schemas/auth';

import { isEmailConfigured } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { completePasswordReset, requestPasswordReset } from './password-reset.service';

const passwordReset = new Hono();

/**
 * @swagger
 * /api/auth/password-reset/request:
 *   post:
 *     summary: Request a password-reset email (no-enumeration surface).
 *     description: >
 *       Public. Rate limited by client IP (5 / 15 min, the register posture) AND by the
 *       normalized target email (3 / 1 h — per-target bound; case variants share one
 *       bucket). Responds the identical generic `200 { success: true }` whether or not
 *       the email matches an account and regardless of delivery outcome (no
 *       account-existence or delivery-health oracle). When an account exists, a
 *       single-use reset token (60 min TTL, newest-wins over prior tokens) is issued
 *       and the reset email dispatched WITHOUT awaiting delivery. When the instance has
 *       no email configured the endpoint returns a stable `409 EMAIL_NOT_CONFIGURED`
 *       for every caller — instance-level, account-independent.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: '{ success: true } — identical for existing and nonexistent accounts.' }
 *       400: { description: Validation error (malformed email). }
 *       409: { description: EMAIL_NOT_CONFIGURED — this instance has no email configured. }
 *       429: { description: Rate limit reached (IP-keyed or per-target). }
 */
passwordReset.post(
  '/password-reset/request',
  // IP-keyed, the register posture: hardens to 3/container under Redis outage.
  createRateLimiter({
    name: 'password-reset-request',
    windowMs: 15 * 60 * 1000,
    max: 5,
    fallbackMax: 3,
  }),
  validate('json', PasswordResetRequestSchema),
  // Per-target bound (REQ-3.8), keyed on the POST-ZOD normalized email.
  createRateLimiter({
    name: 'password-reset-target',
    windowMs: 60 * 60 * 1000,
    max: 3,
    fallbackMax: 3,
    keyGenerator: (c) => c.req.valid('json').email,
  }),
  async (c) => {
    // Instance-level, account-independent: deliberate disclosure per
    // REQ-1.2/REQ-3.3 (graceful absence), not a leak. The code is the
    // contract (the UI keys on it — D12).
    if (!isEmailConfigured()) {
      throw new AppError(
        409,
        'EMAIL_NOT_CONFIGURED',
        'This instance has no email configured. Self-service reset is unavailable — ask your operator (tradr reset-password).',
      );
    }
    const { email } = c.req.valid('json');
    await requestPasswordReset(email);
    // Identical on every configured branch: account found, not found, send
    // failed/hung, issuance conflict (REQ-3.2/3.3).
    return c.json({ success: true }, 200);
  },
);

/**
 * @swagger
 * /api/auth/password-reset/complete:
 *   post:
 *     summary: Complete a password reset with an emailed token (consume → revoke → rewrite).
 *     description: >
 *       Public. Rate limited by client IP (10 / 15 min, the login posture — token
 *       guessing is primarily throttled by the token's 256-bit entropy + 60 min TTL).
 *       Atomically consumes the single-use token, revokes ALL of the account's
 *       sessions, sets the new bcrypt password hash, and marks the account
 *       email-verified — a completed email-delivered reset proves mailbox control.
 *       Expired, already-consumed, and unrecognized tokens are indistinguishable: one
 *       generic 400 INVALID_OR_EXPIRED_TOKEN. No auto-login — no session cookie is set;
 *       the page routes to login. Fully functional when the instance has no email
 *       configured (consuming an existing token sends nothing).
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token:
 *                 type: string
 *                 pattern: '^[0-9a-f]{64}$'
 *                 description: The raw token from the emailed link's URL fragment.
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 maxLength: 72
 *                 description: The new password (the shared registration policy).
 *     responses:
 *       200: { description: '{ success: true } — password rewritten, all sessions revoked, no session cookie set.' }
 *       400: { description: Validation error, or INVALID_OR_EXPIRED_TOKEN (expired / consumed / unknown — one generic body). }
 *       429: { description: Rate limit reached (IP-keyed). }
 */
passwordReset.post(
  '/password-reset/complete',
  // IP-keyed, the login posture (REQ-4.7): hardens to 5/container under Redis
  // outage. Limiter before validation — the house pattern.
  createRateLimiter({
    name: 'password-reset-complete',
    windowMs: 15 * 60 * 1000,
    max: 10,
    fallbackMax: 5,
  }),
  validate('json', PasswordResetCompleteSchema),
  async (c) => {
    // NO isEmailConfigured() gate: completion consumes an existing token and
    // sends nothing, so it stays functional when SMTP config is removed
    // mid-flow (D12) — nobody holding a live emailed link is stranded.
    const { token, password } = c.req.valid('json');
    await completePasswordReset(token, password);
    // No auto-login (D8): no session cookie; the page routes to login.
    return c.json({ success: true }, 200);
  },
);

export default passwordReset;
