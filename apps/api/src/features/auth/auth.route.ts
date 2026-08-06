import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';

import { UserTimezoneSchema } from '@tradr/shared';
import { RegisterSchema, LoginSchema } from '@tradr/shared/schemas/auth';

import { db } from '@/db';
import { users } from '@/db/schema';
import { sessionCookieOptions } from '@/lib/cookie-policy';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  registerUser,
  loginUser,
  logoutUser,
  getReportingTimezone,
  setReportingTimezone,
} from './auth.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const auth = new Hono();

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Create an account and start a session.
 *     description: >
 *       Public. Creates a user and sets the `session` cookie, so a successful
 *       register leaves the caller signed in. Rate limited to 5 requests per 15
 *       minutes per client, tightening to 3 while the shared rate-limit store is
 *       unavailable. `emailVerified` is `false` until the address is confirmed;
 *       when transactional email is not configured there is nothing to confirm
 *       and the flag stays false without blocking use.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8, maxLength: 72 }
 *               timezone:
 *                 type: string
 *                 maxLength: 64
 *                 description: >
 *                   Optional IANA zone the client detected in the browser, stored
 *                   as the user's reporting timezone. Omit it and the account is
 *                   created with the default, `UTC`; it is changeable afterwards
 *                   via `PUT /api/users/me/timezone`. Unrelated to an account's
 *                   trading-day timezone.
 *                 example: Europe/London
 *     responses:
 *       201:
 *         description: The new user. The `session` cookie is set.
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
 *       400: { description: Validation error. }
 *       409: { description: That email is already registered. }
 *       429: { description: Rate limit exceeded. }
 */
auth.post(
  '/register',
  // Redis-outage fallback TIGHTENS to 3/container (below the normal max of 5):
  // register is a brute-force surface, so it hardens under degradation. The
  // aggregate is a bounded N×-degraded 3N, not the global budget (REQ-7.5, D8).
  createRateLimiter({ name: 'register', max: 5, windowMs: 15 * 60 * 1000, fallbackMax: 3 }),
  validate('json', RegisterSchema),
  async (c) => {
    // `timezone` is optional and absent for every scripted or e2e registration
    // that predates it; registerUser substitutes the default (R2.3).
    const { email, password, timezone } = c.req.valid('json');
    const { user, token } = await registerUser(email, password, timezone);

    setCookie(c, 'session', token, sessionCookieOptions());

    // emailVerified is the ONE additive field on the frozen 201 shape
    // (REQ-1.1 carve-out (b)); register.tsx branches on it (D14).
    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          isAdmin: user.isAdmin,
          emailVerified: user.emailVerified,
        },
      },
      201,
    );
  },
);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Sign in and start a session.
 *     description: >
 *       Public. On success sets the `session` cookie; every authenticated
 *       endpoint reads it. Rate limited to 10 requests per 15 minutes per
 *       client, tightening to 5 while the shared rate-limit store is
 *       unavailable. A wrong email and a wrong password are answered
 *       identically, so the response does not reveal whether an address is
 *       registered. A user may hold 5 concurrent sessions; signing in a sixth
 *       time ends the oldest one.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8, maxLength: 72 }
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
 *       400: { description: Validation error. }
 *       401: { description: Invalid email or password. }
 *       429: { description: Rate limit exceeded. }
 */
auth.post(
  '/login',
  // Redis-outage fallback TIGHTENS to 5/container (below the normal max of 10):
  // login is a brute-force surface, so it hardens under degradation. The
  // aggregate is a bounded N×-degraded 5N, not the global budget (REQ-7.5, D8).
  createRateLimiter({ name: 'login', max: 10, windowMs: 15 * 60 * 1000, fallbackMax: 5 }),
  validate('json', LoginSchema),
  async (c) => {
    const { email, password } = c.req.valid('json');
    const { user, token } = await loginUser(email, password);

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

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: End the current session.
 *     description: >
 *       Revokes the session server-side and clears the `session` cookie.
 *       Idempotent: calling it without a session still returns 200, so a client
 *       can always reach a signed-out state.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: The session is ended.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 */
auth.post('/logout', async (c) => {
  const token = getCookie(c, 'session');

  if (!token) {
    return c.json({ success: true }, 200);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  await logoutUser(tokenHash);

  setCookie(c, 'session', '', { ...sessionCookieOptions(), maxAge: 0 });

  return c.json({ success: true }, 200);
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get the signed-in user.
 *     description: >
 *       Authed. The canonical "who am I" call — clients use it on boot to decide
 *       whether a session is still valid.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: The current user.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 email: { type: string, format: email }
 *                 isAdmin: { type: boolean }
 *                 emailVerified: { type: boolean }
 *       401: { description: No valid session. }
 */
auth.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const isAdmin = c.get('isAdmin');

  const result = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return c.json(
    { id: userId, email: result[0].email, isAdmin, emailVerified: result[0].emailVerified },
    200,
  );
});

// ---------------------------------------------------------------------------
// User reporting timezone
//
// A stored per-user preference, so it follows the established
// `/api/users/me/<preference>` convention rather than inventing another one —
// as with `/users/me/buying-power-basis` (calculator), `/users/me/display-currency`
// (accounting) and `/users/me/tax-jurisdiction` (expenses).
//
// It gets its OWN router because that path is absolute: `auth` is mounted at
// `/api/auth`, so a `/users/me/...` path declared on it would resolve to
// `/api/auth/users/me/...`. Mounted bare at `/api` in app.ts. It lives in the
// auth slice because the auth slice is the one that owns the `users` row —
// `registerUser` seeds this very column — and a whole feature slice for one
// scalar preference would be the invention the convention exists to avoid.
// ---------------------------------------------------------------------------

export const userPreferencesRouter = new Hono<AuthEnv>();

userPreferencesRouter.use(authMiddleware);

/**
 * @swagger
 * /api/users/me/timezone:
 *   get:
 *     summary: Get the reporting timezone.
 *     description: >
 *       Authed. The IANA zone the user's P&L is bucketed into by day, week and
 *       month. It does not affect how individual timestamps are displayed.
 *       `timezone` is never null: accounts created before the preference
 *       existed store nothing and read as the default `UTC`, with `stored`
 *       false to say so. This is not an account's trading-day timezone — that
 *       one defaults to US Eastern because that is where the US equity venues
 *       run, and setting either leaves the other untouched.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: The resolved reporting timezone, and whether it is the user's own.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timezone: { type: string, example: Europe/London }
 *                 stored:
 *                   type: boolean
 *                   description: >
 *                     True when `timezone` is the value held on the user's row.
 *                     False when the column is unset — a row predating the
 *                     preference — and the server default is being substituted;
 *                     a client may then seed the column once from the zone it
 *                     detects, which is what that user was already bucketing by.
 *                   example: true
 *       401: { description: Authentication required. }
 */
userPreferencesRouter.get('/users/me/timezone', async (c) => {
  const userId = c.get('userId');
  const { timezone, stored } = await getReportingTimezone(userId);
  return c.json({ timezone, stored }, 200);
});

/**
 * @swagger
 * /api/users/me/timezone:
 *   put:
 *     summary: Set the reporting timezone.
 *     description: >
 *       Authed. Changes which calendar day each trade is counted in for daily,
 *       weekly and monthly figures. It rewrites no stored timestamp — every
 *       fill keeps the instant it happened — it does not change how timestamps
 *       are displayed, and it does not touch any account's trading-day
 *       timezone.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [timezone]
 *             properties:
 *               timezone:
 *                 type: string
 *                 maxLength: 64
 *                 description: An IANA zone name, such as `Europe/London` or `UTC`.
 *                 example: Europe/London
 *     responses:
 *       200: { description: The stored reporting timezone. }
 *       400: { description: Not a valid IANA timezone name. }
 *       401: { description: Authentication required. }
 */
userPreferencesRouter.put('/users/me/timezone', validate('json', UserTimezoneSchema), async (c) => {
  const userId = c.get('userId');
  const { timezone } = c.req.valid('json');
  await setReportingTimezone(userId, timezone);
  // Same shape as the GET, so one client type covers both. `stored` is true by
  // construction here: the write just put this value on the row.
  return c.json({ timezone, stored: true }, 200);
});

export default auth;
