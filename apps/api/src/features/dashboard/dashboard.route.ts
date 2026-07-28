import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';

import { BODY_LIMIT_BYTES, PutDashboardLayoutRequestSchema, type Theme } from '@tradr/shared';

import { themeCookieAttributes } from '@/lib/cookie-policy';
import { ValidationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { getLayoutForUser, getThemeForUser, putLayoutForUser } from './dashboard.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
    requestId: string;
  };
};

const app = new Hono<AuthEnv>();

app.use(authMiddleware);

export function buildThemeCookie(value: Theme): string {
  return `tradr_theme=${value}; ${themeCookieAttributes()}`;
}

app.get('/layout', async (c) => {
  const userId = c.get('userId');
  const response = await getLayoutForUser(userId);
  return c.json(response, 200);
});

function payloadTooLargeResponse(c: Context<AuthEnv>) {
  const requestId = c.get('requestId') as string | undefined;
  return c.json(
    {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${BODY_LIMIT_BYTES} bytes`,
        requestId,
      },
    },
    413,
  );
}

// §A-r4: pre-consume the raw body BEFORE zValidator. Hono's zValidator wraps
// json-parse errors (including downstream BodyLimitError) into a 400
// HTTPException, which would mask the 413. By reading the body here first, we
// surface BodyLimitError in a place where bodyLimit's post-next onError block
// can fire — and we also catch it ourselves as a belt-and-braces fallback.
const consumeBodyOrEmit413 = createMiddleware(async (c, next) => {
  try {
    if (c.req.raw.body) {
      await c.req.text();
    }
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'BodyLimitError') {
      return payloadTooLargeResponse(c);
    }
    throw err;
  }
  await next();
});

app.put(
  '/layout',
  bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => payloadTooLargeResponse(c),
  }),
  consumeBodyOrEmit413,
  validate('json', PutDashboardLayoutRequestSchema),
  async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const response = await putLayoutForUser(userId, body);
    if (body.theme !== undefined) {
      c.header('Set-Cookie', buildThemeCookie(response.theme), { append: true });
    }
    return c.json(response, 200);
  },
);

app.get('/theme', async (c) => {
  const userId = c.get('userId');
  const theme = await getThemeForUser(userId);
  c.header('Cache-Control', 'no-store');
  return c.json({ theme }, 200);
});

app.post('/theme-cookie', async (c) => {
  const userId = c.get('userId');
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    throw new ValidationError('Request body must be empty');
  }
  const theme = await getThemeForUser(userId);
  c.header('Set-Cookie', buildThemeCookie(theme), { append: true });
  return c.body(null, 204);
});

export const dashboardRoute = app;
