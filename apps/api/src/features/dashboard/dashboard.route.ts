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

/**
 * @swagger
 * components:
 *   schemas:
 *     WidgetPlacement:
 *       type: object
 *       description: >
 *         One widget on the dashboard grid. The grid is 12 columns wide and
 *         rows are a fixed height, so `x`/`w` are columns and `y`/`h` are rows.
 *       required: [id, type, x, y, w, h]
 *       properties:
 *         id: { type: string, format: uuid }
 *         type:
 *           type: string
 *           enum:
 *             [
 *               stats-summary,
 *               open-positions,
 *               performance-chart,
 *               account-balances,
 *               position-sizing,
 *               equity-curve,
 *             ]
 *         x: { type: integer, minimum: 0, maximum: 11 }
 *         y: { type: integer, minimum: 0 }
 *         w: { type: integer, minimum: 1, maximum: 12, description: 'x + w must not exceed 12.' }
 *         h: { type: integer, minimum: 1, maximum: 24 }
 *         config:
 *           description: Optional per-widget settings. Serialises to at most 2048 bytes.
 */
const app = new Hono<AuthEnv>();

app.use(authMiddleware);

export function buildThemeCookie(value: Theme): string {
  return `tradr_theme=${value}; ${themeCookieAttributes()}`;
}

/**
 * @swagger
 * /api/dashboard/layout:
 *   get:
 *     summary: Get the dashboard layout.
 *     description: >
 *       Authed. Returns the user's widget placements on a 12-column grid, their
 *       theme, and when the layout was last saved. A user who has never
 *       customised the dashboard gets the default layout, not an empty one.
 *     tags: [Dashboard]
 *     responses:
 *       200:
 *         description: The layout.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 widgets:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/WidgetPlacement' }
 *                 theme: { type: string, enum: [light, dark, system] }
 *                 updatedAt: { type: string, nullable: true }
 *       401: { description: No valid session. }
 */
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

/**
 * @swagger
 * /api/dashboard/layout:
 *   put:
 *     summary: Save the dashboard layout, the theme, or both.
 *     description: >
 *       Authed. Send `widgets`, `theme`, or both — a body with neither is a
 *       400. `widgets` replaces the whole layout; it is not a patch. Placements
 *       are validated as a set: at most one widget of each type, no two
 *       overlapping, none extending past the 12-column grid, and none below its
 *       type's minimum size. When `theme` is sent the response also sets the
 *       `tradr_theme` cookie so the next page load paints without a flash.
 *     tags: [Dashboard]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               widgets:
 *                 type: array
 *                 maxItems: 6
 *                 items: { $ref: '#/components/schemas/WidgetPlacement' }
 *               theme: { type: string, enum: [light, dark, system] }
 *     responses:
 *       200: { description: The saved layout. }
 *       400: { description: Validation error, or a body containing neither widgets nor theme. }
 *       413: { description: PAYLOAD_TOO_LARGE — the request body exceeds the limit. }
 */
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

/**
 * @swagger
 * /api/dashboard/theme:
 *   get:
 *     summary: Get the stored theme preference.
 *     description: 'Authed. Answered with `Cache-Control: no-store`.'
 *     tags: [Dashboard]
 *     responses:
 *       200:
 *         description: The theme.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 theme: { type: string, enum: [light, dark, system] }
 */
app.get('/theme', async (c) => {
  const userId = c.get('userId');
  const theme = await getThemeForUser(userId);
  c.header('Cache-Control', 'no-store');
  return c.json({ theme }, 200);
});

/**
 * @swagger
 * /api/dashboard/theme-cookie:
 *   post:
 *     summary: Re-issue the theme cookie.
 *     description: >
 *       Authed. Sets `tradr_theme` from the stored preference without changing
 *       it. Used to restore the cookie on a new device or after it is cleared,
 *       so the first paint matches the saved theme. The request body must be
 *       empty.
 *     tags: [Dashboard]
 *     responses:
 *       204: { description: The cookie is set. }
 *       400: { description: The request body was not empty. }
 */
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
