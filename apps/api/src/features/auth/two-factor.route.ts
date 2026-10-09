// Second sign-in step (design C4) and the two-factor management endpoints
// (design C5). Mounted in app.ts as a FOURTH router on the /api/auth base (the
// password-reset / verification double-mount precedent) so the frozen
// auth.route.ts surface stays untouched; the global CORS + anti-CSRF middleware
// in app.ts cover it. `POST /login/two-factor` is PUBLIC — the challenge travels
// in the request body only, never a cookie, so the step works the same
// split-origin (Req 2.9). The five management routes each carry `authMiddleware`
// per route (the router also serves that public route); the POSTs add the
// per-user `two-factor-manage` limiter (design D19) and `Cache-Control: no-store`.

import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';

import {
  LoginTwoFactorSchema,
  TwoFactorCodeSchema,
  TwoFactorDisableSchema,
} from '@tradr/shared/schemas/auth';

import { sessionCookieOptions } from '@/lib/cookie-policy';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  completeTwoFactorLogin,
  confirmTwoFactorEnrolment,
  disableTwoFactor,
  enrolTwoFactor,
  getTwoFactorStatus,
  regenerateBackupCodes,
} from './two-factor.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const twoFactor = new Hono<AuthEnv>();

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

// --- Design C5 — authenticated two-factor management ---

// One per-user limiter shared across the four management POSTs (design D19): 10
// writes per 15 minutes keyed on the authenticated userId, so a single account
// cannot hammer enrol/confirm/regenerate/disable. The Redis-outage fallback keeps
// the same cap — a userId-keyed abuse limiter, not a per-IP brute-force surface.
const manageRateLimiter = createRateLimiter({
  name: 'two-factor-manage',
  max: 10,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (c) => c.get('userId'),
  fallbackMax: 10,
});

// A management mutation is never cached (design C5). Set BEFORE next() so the
// header survives onError too — a thrown AppError's response is built from the
// prepared headers (hono Context#newResponse), so even a 400/409/429 carries it.
const noStoreHeaders = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

/**
 * @swagger
 * /api/auth/two-factor:
 *   get:
 *     summary: Whether two-factor is enabled for the signed-in user.
 *     description: >
 *       Returns `{ enabled }` — `true` once an enrolment has been confirmed, `false`
 *       otherwise (including a started-but-unconfirmed enrolment). Requires an
 *       authenticated session. Read-only and side-effect-free.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: The two-factor status.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 *       401: { description: "No authenticated session." }
 */
twoFactor.get('/two-factor', authMiddleware, async (c) => {
  return c.json(await getTwoFactorStatus(c.get('userId')));
});

/**
 * @swagger
 * /api/auth/two-factor/enrol:
 *   post:
 *     summary: Begin two-factor enrolment.
 *     description: >
 *       Generates a fresh TOTP secret (at least 160 bits), stores it only as an
 *       encryption envelope in a pending row and returns the base32 `secret` and
 *       its `otpauth://` URI once, for display as a text key and a QR code. Nothing
 *       turns on until `POST /two-factor/enrol/confirm` accepts a code. Requires an
 *       authenticated session; rate limited to 10 management writes per 15 minutes
 *       per user; never cached.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: The enrolment secret and provisioning URI.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 secret: { type: string, description: "The base32 TOTP secret (text key)." }
 *                 otpauthUri: { type: string, description: "The otpauth:// provisioning URI for a QR code." }
 *       401: { description: "No authenticated session." }
 *       409: { description: "Two-factor is already enabled (`TWO_FACTOR_ALREADY_ENABLED`)." }
 *       429: { description: "Rate limit exceeded." }
 */
twoFactor.post(
  '/two-factor/enrol',
  authMiddleware,
  noStoreHeaders,
  manageRateLimiter,
  async (c) => {
    return c.json(await enrolTwoFactor(c.get('userId')));
  },
);

/**
 * @swagger
 * /api/auth/two-factor/enrol/confirm:
 *   post:
 *     summary: Confirm two-factor enrolment with a code.
 *     description: >
 *       Validates the submitted authenticator `code` against the pending secret,
 *       then turns two-factor on, shows 10 single-use backup codes once (stored only
 *       as one-way hashes) and ends every other session of the user, keeping the
 *       current one. Requires an authenticated session; rate limited to 10
 *       management writes per 15 minutes per user; never cached.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, minLength: 6, maxLength: 20 }
 *     responses:
 *       200:
 *         description: The 10 single-use backup codes, shown once.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 backupCodes:
 *                   type: array
 *                   items: { type: string }
 *       400: { description: "Validation error, or the code is wrong (`INVALID_TWO_FACTOR_CODE`)." }
 *       401: { description: "No authenticated session." }
 *       409: { description: "No pending enrolment to confirm (`TWO_FACTOR_NOT_PENDING`)." }
 *       429: { description: "Rate limit exceeded." }
 */
twoFactor.post(
  '/two-factor/enrol/confirm',
  authMiddleware,
  noStoreHeaders,
  manageRateLimiter,
  validate('json', TwoFactorCodeSchema),
  async (c) => {
    const { code } = c.req.valid('json');
    // The request's own session cookie, hashed as auth.middleware.ts:24-27 does,
    // so confirm keeps exactly this session and ends the rest (D11).
    const tokenHash = createHash('sha256')
      .update(getCookie(c, 'session') ?? '')
      .digest('hex');
    return c.json(await confirmTwoFactorEnrolment(c.get('userId'), code, tokenHash));
  },
);

/**
 * @swagger
 * /api/auth/two-factor/backup-codes:
 *   post:
 *     summary: Regenerate backup codes.
 *     description: >
 *       Validates a current authenticator `code` (a backup code is NOT accepted
 *       here), then replaces every earlier backup code with 10 fresh single-use
 *       ones, shown once and stored only as one-way hashes. Requires an
 *       authenticated session; rate limited to 10 management writes per 15 minutes
 *       per user; never cached.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, minLength: 6, maxLength: 20 }
 *     responses:
 *       200:
 *         description: The 10 new single-use backup codes, shown once.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 backupCodes:
 *                   type: array
 *                   items: { type: string }
 *       400: { description: "Validation error, or the code is wrong (`INVALID_TWO_FACTOR_CODE`)." }
 *       401: { description: "No authenticated session." }
 *       429: { description: "Rate limit exceeded." }
 */
twoFactor.post(
  '/two-factor/backup-codes',
  authMiddleware,
  noStoreHeaders,
  manageRateLimiter,
  validate('json', TwoFactorCodeSchema),
  async (c) => {
    const { code } = c.req.valid('json');
    return c.json(await regenerateBackupCodes(c.get('userId'), code));
  },
);

/**
 * @swagger
 * /api/auth/two-factor/disable:
 *   post:
 *     summary: Turn two-factor off.
 *     description: >
 *       Requires the account `password` AND a valid authenticator `code` or an
 *       unused backup code. On success deletes the secret and every backup code, so
 *       the account signs in with the password alone again. A wrong password or code
 *       is a single `400 INVALID_CREDENTIALS` that does not reveal which failed.
 *       Requires an authenticated session; rate limited to 10 management writes per
 *       15 minutes per user; never cached.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password, code]
 *             properties:
 *               password: { type: string, minLength: 8, maxLength: 72 }
 *               code: { type: string, minLength: 6, maxLength: 20 }
 *     responses:
 *       200:
 *         description: Two-factor is now off.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 *       400: { description: "Validation error, or the password or code is wrong (`INVALID_CREDENTIALS`)." }
 *       401: { description: "No authenticated session." }
 *       429: { description: "Rate limit exceeded." }
 */
twoFactor.post(
  '/two-factor/disable',
  authMiddleware,
  noStoreHeaders,
  manageRateLimiter,
  validate('json', TwoFactorDisableSchema),
  async (c) => {
    const { password, code } = c.req.valid('json');
    await disableTwoFactor(c.get('userId'), password, code);
    return c.json({ enabled: false });
  },
);

export default twoFactor;
