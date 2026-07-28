import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';

import { db } from '@/db';
import { sessions, users } from '@/db/schema';
import { UnauthorizedError } from '@/lib/errors';
import { setLogUser } from '@/lib/logger';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOUCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, 'session');
  if (!token) throw new UnauthorizedError();

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const result = await db
    .select({
      session: sessions,
      user: {
        id: users.id,
        email: users.email,
        isAdmin: users.isAdmin,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (result.length === 0) throw new UnauthorizedError();

  const { session, user } = result[0];
  const now = Date.now();

  // Check absolute timeout (24 hours since creation)
  if (now - session.createdAt.getTime() > ABSOLUTE_TIMEOUT_MS) {
    throw new UnauthorizedError();
  }

  // Check idle timeout (30 minutes since last access)
  if (now - session.lastAccessed.getTime() > IDLE_TIMEOUT_MS) {
    throw new UnauthorizedError();
  }

  // Touch session if >5 minutes stale (non-blocking)
  if (now - session.lastAccessed.getTime() > TOUCH_INTERVAL_MS) {
    db.update(sessions)
      .set({ lastAccessed: new Date() })
      .where(eq(sessions.id, session.id))
      .then(() => {})
      .catch(() => {});
  }

  c.set('userId', user.id);
  setLogUser(user.id);
  c.set('isAdmin', user.isAdmin);

  await next();
});
