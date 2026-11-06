import { Hono } from 'hono';

import {
  BlackScholesInputSchema,
  OccEncodeInputSchema,
  OccParseInputSchema,
  blackScholes,
  encodeOccSymbol,
  parseOccSymbol,
} from '@tradr/shared';

import { ValidationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  deleteMarketDataKeyHandler,
  getMarketDataKeyHandler,
  saveMarketDataKeyHandler,
} from '../advisor/external-keys.handler';
import { getOptionsChainHandler } from '../advisor/options-chain.handler';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

const optionsRouter = new Hono<AuthEnv>();

optionsRouter.use(authMiddleware);

// Per-user options rate limiter (symbols quote precedent): 120 requests per
// 60 s, keyed on the authenticated userId so the cap is per-account — NAT'd
// users do not collide and one user across multiple IPs cannot double it. The
// Redis-outage fallback keeps the same per-container budget (these are
// pure-function compute endpoints, a userId-keyed cost limiter not a
// brute-force surface).
const optionsRateLimit = createRateLimiter({
  name: 'options',
  max: 120,
  windowMs: 60_000,
  keyGenerator: (c) => c.get('userId'),
  fallbackMax: 120,
});

optionsRouter.use(optionsRateLimit);

/**
 * @swagger-example occ-parse-form1 {"input":"AAPL  250620C00150000"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 * @swagger-example occ-parse-form2 {"input":"AAPL    250620C00150000"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 * @swagger-example occ-parse-form3 {"input":"AAPL250620C00150000"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 * @swagger-example occ-parse-form4 {"input":"AAPL250620C150"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 */
optionsRouter.post('/occ/parse', validate('json', OccParseInputSchema), async (c) => {
  const { input } = c.req.valid('json');
  const result = parseOccSymbol(input);
  if (!result.ok) {
    throw new ValidationError(result.error.message, { input: result.error.message }, [
      { path: 'input', code: result.error.code, message: result.error.message },
    ]);
  }
  return c.json(result.value, 200);
});

/**
 * @swagger-example occ-encode-canonical {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150"} → {"symbol":"AAPL  250620C00150000"}
 */
optionsRouter.post('/occ/encode', validate('json', OccEncodeInputSchema), async (c) => {
  const input = c.req.valid('json');
  const result = encodeOccSymbol(input);
  if (!result.ok) {
    throw new ValidationError(result.error.message, { input: result.error.message }, [
      { path: 'input', code: result.error.code, message: result.error.message },
    ]);
  }
  return c.json({ symbol: result.value }, 200);
});

/**
 * @swagger-example bs-atm-call {"S":150,"K":150,"T":0.5,"sigma":0.30,"r":0.04,"q":0,"type":"call"} → {"price":"14.0857","delta":"5.79395e-1","gamma":"1.22884e-2","thetaPerDay":"-4.20684e-2","vegaPerPct":"4.14735e-1","rhoPerPct":"3.64118e-1"}
 * @swagger-example bs-q-omitted {"S":150,"K":150,"T":0.5,"sigma":0.30,"r":0.04,"type":"call"} → {"price":"14.0857","delta":"5.79395e-1","gamma":"1.22884e-2","thetaPerDay":"-4.20684e-2","vegaPerPct":"4.14735e-1","rhoPerPct":"3.64118e-1"}
 * @swagger-example bs-negative-r {"S":100,"K":100,"T":1.0,"sigma":0.20,"r":-0.005,"q":0,"type":"call"} → {"price":"7.73740","delta":"5.29893e-1","gamma":"1.98911e-2","thetaPerDay":"-1.02793e-2","vegaPerPct":"3.97822e-1","rhoPerPct":"4.52519e-1"}
 */
optionsRouter.post('/black-scholes', validate('json', BlackScholesInputSchema), async (c) => {
  const input = c.req.valid('json');
  const output = blackScholes(input);
  return c.json(output, 200);
});

// === options-chain viewer endpoint (design C9 — moved off the advisor router) ===

/**
 * @swagger
 * /api/options/chain:
 *   get:
 *     summary: Get one expiry's option chain for a symbol from Unusual Whales.
 *     description: >
 *       Backs the options-tools page chain viewer. Shares the Unusual Whales client and
 *       the `market_data_options_chain` tool's parsing (no duplicate fetch logic). When
 *       the authenticated user has no Unusual Whales key the response is `{ configured:
 *       false }` so the viewer shows an empty-state CTA to Settings, not an error.
 *
 *       A chain is scoped to ONE expiry. Omit `expiration` to get the nearest tradeable
 *       one. The response is `{ configured: true, expiration, expirations[], underlying?,
 *       chain }`: `expiration` is the expiry actually returned, `expirations` is every
 *       tradeable expiry (soonest first) for the picker, and `chain` is the compact
 *       projection `{ symbol, expiration?, count, contracts[] }` sorted by strike. Each
 *       contract carries `premium` — the last traded price, or the NBBO midpoint when the
 *       contract has not traded — which is what the calculator uses as an entry price.
 *
 *       `underlying` is the last trade on the underlying (`price`, `market_time`,
 *       `tape_time`), used by the viewer to anchor the ladder on at-the-money. It is
 *       fetched separately and is OMITTED rather than fatal when that quote fails — the
 *       chain is the payload; the anchor is not worth failing it for. A `market_time`
 *       other than `regular` means the price is a pre/post-market print, not a live quote.
 *
 *       Requesting an `expiration` the symbol has no contracts for is 404
 *       SYMBOL_NOT_FOUND with an explicit message. Other upstream failures map to their
 *       reason codes on the matching HTTP status: 400 MARKET_DATA_KEY_INVALID, 429
 *       MARKET_DATA_RATE_LIMITED / PLATFORM_RATE_LIMITED, 503 MARKET_DATA_UNAVAILABLE.
 *       The plaintext key is never returned or logged.
 *     tags: [Options]
 *     parameters:
 *       - in: query
 *         name: symbol
 *         required: true
 *         schema: { type: string, pattern: '^[A-Z.]{1,6}$' }
 *       - in: query
 *         name: expiration
 *         description: Expiry to fetch (YYYY-MM-DD). Defaults to the nearest tradeable expiry.
 *         schema: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$' }
 *     responses:
 *       200:
 *         description: '{ configured: false } or { configured: true, expiration, expirations, underlying?, chain }.'
 *       400: { description: 'Validation error or MARKET_DATA_KEY_INVALID.' }
 *       404: { description: 'SYMBOL_NOT_FOUND — unknown symbol, or no contracts on that expiry.' }
 *       429: { description: 'MARKET_DATA_RATE_LIMITED or PLATFORM_RATE_LIMITED.' }
 *       503: { description: MARKET_DATA_UNAVAILABLE. }
 */
optionsRouter.get('/chain', getOptionsChainHandler);

// === market-data-key endpoints (moved off the advisor router) ===
// Per-user save rate limiter — mounted on PUT only: 10 saves per user per
// hour, mirroring the LLM provider-key limiter. A distinct instance so the
// market-data bucket does not share counts with the provider-key endpoint.
const perUserMarketDataKeySaveRateLimit = createRateLimiter({
  name: 'market-data-keys',
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (c) => c.get('userId'),
  // Redis-outage fallback keeps the normal per-container budget (D8; not tightened).
  fallbackMax: 10,
});

/**
 * @swagger
 * /api/options/market-data-key:
 *   get:
 *     summary: Get the masked status of the authenticated user's Unusual Whales key.
 *     description: >
 *       Returns the market-data (Unusual Whales) BYOK key status. The plaintext is
 *       NEVER returned — only `configured`, a last-4-char masking hint (`keyHintTail`),
 *       and the `verified` flag. When no key is stored the response is `{ configured:
 *       false }`.
 *     tags: [Options]
 *     responses:
 *       200: { description: '{ configured: false } or { configured: true, keyHintTail, verified } — no key material.' }
 *   put:
 *     summary: Save (or replace) the Unusual Whales market-data key.
 *     description: >
 *       Encrypts the supplied key at rest (AES-256-GCM) and stores only the ciphertext
 *       plus a last-4-char masking hint — the plaintext is never persisted or returned.
 *       Runs a lightweight verification probe: a 401/403 rejects the save with
 *       `MARKET_DATA_KEY_INVALID`; a successful probe returns `verified: true`; a
 *       transient failure (timeout / upstream unavailable) stores the key anyway and
 *       returns `verified: false`. Rate limited to 10 saves per user per hour.
 *     tags: [Options]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [apiKey]
 *             properties:
 *               apiKey: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: '{ configured: true, keyHintTail, verified: boolean }.' }
 *       400: { description: 'Validation error or MARKET_DATA_KEY_INVALID (key rejected by Unusual Whales).' }
 *       429: { description: Save rate limit reached (10 / hour). }
 *   delete:
 *     summary: Remove the Unusual Whales market-data key.
 *     description: >
 *       Hard-deletes the stored key for the authenticated user. The ciphertext is
 *       gone from the database; the plaintext was never persisted.
 *     tags: [Options]
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: No market-data key configured. }
 */
optionsRouter.get('/market-data-key', getMarketDataKeyHandler);
optionsRouter.put('/market-data-key', perUserMarketDataKeySaveRateLimit, saveMarketDataKeyHandler);
optionsRouter.delete('/market-data-key', deleteMarketDataKeyHandler);

export default optionsRouter;
