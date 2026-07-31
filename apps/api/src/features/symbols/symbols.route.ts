// Symbols feature router (design v4 §symbols.route, REQ-3/4/9, REQ-2.4(d)).
//
// A Hono sub-app mounted at /api/symbols behind router-level `authMiddleware`.
// Four endpoints: ticker-prefix search, delayed spot quote (per-user rate
// limited), quote-config presence, and an admin-only manual refresh. Each
// endpoint carries a hand-authored `@swagger` JSDoc block (the
// changelog/advisor/billing convention; `@hono/zod-openapi` stays deferred).

import { Hono } from 'hono';

import { adminMiddleware } from '@/middleware/admin.middleware';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  getQuoteHandler,
  quoteConfigHandler,
  refreshSymbolsHandler,
  searchSymbolsHandler,
} from './symbols.handler';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
    requestId: string;
  };
};

const symbolsRouter = new Hono<AuthEnv>();

symbolsRouter.use(authMiddleware);

// Per-user quote rate limiter (advisor-stream precedent): 30 lookups per 60 s,
// keyed on the authenticated userId so the cap is per-account — NAT'd users do
// not collide and one user across multiple IPs cannot double it. The
// Redis-outage fallback keeps the normal per-container budget (not tightened —
// a userId-keyed cost limiter, not a brute-force surface).
const perUserQuoteRateLimit = createRateLimiter({
  name: 'stock-quote',
  max: 30,
  windowMs: 60_000,
  keyGenerator: (c) => c.get('userId'),
  fallbackMax: 30,
});

/**
 * @swagger
 * /api/symbols/search:
 *   get:
 *     summary: Ranked ticker-prefix symbol autocomplete.
 *     description: >
 *       Returns up to 10 NYSE/NASDAQ symbols whose ticker starts with the query prefix
 *       `q`, ranked exact-match-first, then by ascending ticker length, then
 *       alphabetically. `q` is sanitized to `[A-Z.-]{0,16}` (trimmed, uppercased); a
 *       normalized-empty `q` returns `{ results: [] }` without a database prefix scan,
 *       and likewise before the reference table is first populated. Read-only and
 *       side-effect-free (CSRF-safe GET); never calls the quote provider. Requires an
 *       authenticated session.
 *     tags: [Symbols]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, pattern: '^[A-Z.-]{0,16}$' }
 *     responses:
 *       200:
 *         description: '{ results: SymbolSearchItem[] } — [] for an empty query or before first population.'
 *       400: { description: Query out of charset or longer than 16 chars (VALIDATION_ERROR). }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 */
symbolsRouter.get('/search', searchSymbolsHandler);

/**
 * @swagger
 * /api/symbols/{symbol}/quote:
 *   get:
 *     summary: Delayed spot last-price for a symbol.
 *     description: >
 *       Returns the platform-global provider's ~15-minute-delayed last price for
 *       `symbol`. With no provider key configured the response is `{ configured: false
 *       }` — defense-in-depth mirroring the frontend gate. With a key configured the
 *       response is `{ configured: true, symbol, lastPrice, change, delayed }`.
 *       Independent of the symbols table. Per-user rate limited to 30 lookups per 60 s.
 *       Provider failures surface as coded statuses — 404 unknown symbol, 503
 *       temporarily unavailable / rate-limited, 502 misconfigured — never a generic
 *       500. Requires an authenticated session.
 *     tags: [Symbols]
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema: { type: string, pattern: '^[A-Z.-]{1,16}$' }
 *     responses:
 *       200:
 *         description: '{ configured: false } or { configured: true, symbol, lastPrice, change, delayed }.'
 *       400: { description: Symbol out of charset or longer than 16 chars (VALIDATION_ERROR). }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       404: { description: Unknown symbol (NOT_FOUND). }
 *       429: { description: Per-user quote rate limit reached (30 / 60 s). }
 *       502: { description: Quote provider rejected the key (QUOTE_PROVIDER_MISCONFIGURED). }
 *       503: { description: Quote provider unavailable or rate-limited (QUOTE_PROVIDER_UNAVAILABLE). }
 */
symbolsRouter.get('/:symbol/quote', perUserQuoteRateLimit, getQuoteHandler);

/**
 * @swagger
 * /api/symbols/quote-config:
 *   get:
 *     summary: Whether the delayed-quote provider is configured.
 *     description: >
 *       Returns `{ stockQuoteConfigured: boolean }` so the frontend can gate the
 *       pull-last-price affordance without probing the quote endpoint. Gates
 *       solely on the presence of the provider key. Requires an authenticated
 *       session.
 *     tags: [Symbols]
 *     responses:
 *       200: { description: '{ stockQuoteConfigured: boolean }.' }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 */
symbolsRouter.get('/quote-config', quoteConfigHandler);

/**
 * @swagger
 * /api/symbols/refresh:
 *   post:
 *     summary: Force a symbols reference-data sync from the SEC source (admin).
 *     description: >
 *       Admin-only manual refresh path. Runs the guarded, multi-container-safe
 *       population with `force: true` and returns the SyncOutcome verbatim. Under
 *       NODE_ENV=test population is a no-op (`skipped-test-env`). A side-effecting POST
 *       (CSRF-protected); requires an admin session (authMiddleware → adminMiddleware).
 *     tags: [Symbols]
 *     responses:
 *       200:
 *         description: The SyncOutcome for this run.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [completed, skipped-fresh, skipped-claimed, skipped-test-env, error]
 *                 symbolCount: { type: integer, description: "Present when status is 'completed'." }
 *                 reason: { type: string, description: "Present when status is 'error'." }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       403: { description: Authenticated but not an admin (ADMIN_REQUIRED). }
 */
symbolsRouter.post('/refresh', adminMiddleware, refreshSymbolsHandler);

export default symbolsRouter;
