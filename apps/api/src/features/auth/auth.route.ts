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
