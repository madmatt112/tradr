// Second sign-in step (design C4). Mounted in app.ts as a FOURTH router on the
// /api/auth base (the password-reset / verification double-mount precedent) so
// the frozen auth.route.ts surface stays untouched; the global CORS + anti-CSRF
// middleware in app.ts cover it. The challenge travels in the request body
// only — never a cookie — so the step works the same split-origin (Req 2.9).

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

import { LoginTwoFactorSchema } from '@tradr/shared/schemas/auth';

import { sessionCookieOptions } from '@/lib/cookie-policy';
import { validate } from '@/lib/validation';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { completeTwoFactorLogin } from './two-factor.service';

const twoFactor = new Hono();

/**
 * @swagger
 * /api/auth/login/two-factor:
 *   post:
 *     summary: Finish signing in with a two-factor code.
 *     description: >
 *       Public. Answers the single-use `challenge` from a `202` login response
 *       with the current authenticator code or an unused backup code. On success
 *       the `session` cookie is set, exactly as a password-only login, and the
 *       body carries the signed-in user. Rate limited to 10 requests per 15
 *       minutes per client, tightening to 5 while the shared rate-limit store is
 *       unavailable. A valid TOTP code and a backup code are each single-use. A
 *       wrong code is refused `400 INVALID_TWO_FACTOR_CODE` and counts toward the
 *       per-address lock; an expired, already-used or over-attempted challenge is
 *       `400 CHALLENGE_EXPIRED`; a locked address is refused `429 ACCOUNT_LOCKED`
 *       with `Retry-After`. If the stored secret cannot be decrypted the step
 *       fails closed with `500 TWO_FACTOR_UNAVAILABLE` and never falls back to
 *       the password alone.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [challenge, code]
 *             properties:
 *               challenge:
 *                 type: string
 *                 pattern: '^[0-9a-f]{64}$'
 *                 description: The single-use challenge from the login `202` response.
 *               code:
 *                 type: string
 *                 minLength: 6
 *                 maxLength: 20
 *                 description: A 6-digit authenticator code or a backup code.
 *     responses:
 *       200:
 *         description: The signed-in user. The `session` cookie is set.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     email: { type: string, format: email }
 *                     isAdmin: { type: boolean }
 *                     emailVerified: { type: boolean }
 *       400: { description: "Validation error, CHALLENGE_EXPIRED (dead challenge), or INVALID_TWO_FACTOR_CODE (wrong code)." }
 *       429: { description: "Rate limit exceeded, or the address is temporarily locked (`ACCOUNT_LOCKED`)." }
 *       500: { description: "The stored two-factor secret could not be decrypted (`TWO_FACTOR_UNAVAILABLE`); sign-in fails closed." }
 */
twoFactor.post(
  '/login/two-factor',
  // Same budget and Redis-outage hardening as the first login step (Req 2.6).
  createRateLimiter({
    name: 'login-two-factor',
    max: 10,
    windowMs: 15 * 60 * 1000,
    fallbackMax: 5,
  }),
  validate('json', LoginTwoFactorSchema),
  async (c) => {
    const { challenge, code } = c.req.valid('json');
    const { user, token } = await completeTwoFactorLogin(challenge, code);

    setCookie(c, 'session', token, sessionCookieOptions());

    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          isAdmin: user.isAdmin,
          emailVerified: user.emailVerified,
        },
      },
      200,
    );
  },
);

export default twoFactor;
