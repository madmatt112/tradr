import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';

import { RegisterSchema, LoginSchema } from '@tradr/shared/schemas/auth';

import { db } from '@/db';
import { users } from '@/db/schema';
import { sessionCookieOptions } from '@/lib/cookie-policy';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { registerUser, loginUser, logoutUser } from './auth.service';

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
    const { email, password } = c.req.valid('json');
    const { user, token } = await registerUser(email, password);

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

export default auth;
