// Options-chain viewer endpoint (design §Component 12, REQ-12.2/12.3/12.4).
//
// GET /api/advisor/options-chain?symbol=…[&expiration=YYYY-MM-DD]
//
// Shares the Unusual Whales client (Task 8) and the `market_data_options_chain`
// tool's parsing (Task 13: parseOptionChain + optionsChainInputSchema) so the
// viewer and the advisor tool fetch + project identically (REQ-12.4 — no
// duplicate fetch logic).
//
// No key configured → `{ configured: false }` (200) so the viewer shows an
// empty-state CTA to Settings, NOT an error (REQ-12.2). With a key, a UW failure
// is mapped to its REQ-6.5 reason code on the appropriate HTTP status so the
// viewer can render loading / rate-limited / unavailable / symbol-not-found
// states (REQ-12.3). The plaintext key lives only for the call's lifetime
// (REQ-6.6); it is never logged or returned.

import type { Context } from 'hono';

import { db } from '@/db';
import { decrypt } from '@/lib/encryption';
import { AppError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { selectUnusualWhalesKeyCiphertext } from './external-keys.query';
import {
  createUnusualWhalesClient,
  MarketDataCache,
  MarketDataError,
  MarketDataMeter,
  PlatformRateLimitedError,
} from './lib/unusual-whales.client';
import { TOOL_RESULT_CODES } from './tools/error-codes';
import { optionsChainInputSchema, parseOptionChain } from './tools/market-data';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

/**
 * A mapped Unusual Whales failure surfaced to the viewer (REQ-12.3). Carries the
 * REQ-6.5 reason code on the HTTP status the viewer maps to a UI state. The
 * provider's raw message is NEVER surfaced (REQ-6.8); the generic message from
 * the client is used as-is.
 */
class OptionsChainUpstreamError extends AppError {
  constructor(statusCode: number, code: string, message: string) {
    super(statusCode, code, message);
  }
}

/** Map a thrown UW failure to the HTTP status + reason code the viewer uses. */
function toHttpError(error: unknown): AppError {
  if (error instanceof MarketDataError) {
    switch (error.code) {
      case TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID:
        return new OptionsChainUpstreamError(400, error.code, error.message);
      case TOOL_RESULT_CODES.MARKET_DATA_RATE_LIMITED:
        return new OptionsChainUpstreamError(429, error.code, error.message);
      case TOOL_RESULT_CODES.SYMBOL_NOT_FOUND:
        return new OptionsChainUpstreamError(404, error.code, error.message);
      default:
        // MARKET_DATA_UNAVAILABLE and any other mapped code → transient.
        return new OptionsChainUpstreamError(503, error.code, error.message);
    }
  }
  if (error instanceof PlatformRateLimitedError) {
    return new OptionsChainUpstreamError(429, error.code, error.message);
  }
  // Unexpected throw — never surface raw detail (REQ-6.8).
  return new OptionsChainUpstreamError(
    503,
    TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
    'Unusual Whales is temporarily unavailable.',
  );
}

/**
 * GET /options-chain — the live options chain for a symbol (REQ-12.4).
 *
 * Returns `{ configured: false }` when the user has no Unusual Whales key
 * (REQ-12.2 — empty-state CTA, not an error). Otherwise decrypts the key, builds
 * a one-shot UW client, fetches + projects the chain via the tool's shared
 * `parseOptionChain`, and returns `{ configured: true, chain }`. UW failures are
 * mapped to their REQ-6.5 reason codes on the matching HTTP status (REQ-12.3).
 */
export async function getOptionsChainHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');

  const parsed = optionsChainInputSchema.safeParse({
    symbol: c.req.query('symbol'),
    expiration: c.req.query('expiration') ?? undefined,
  });
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
  const { symbol, expiration } = parsed.data;

  // No key → empty state (REQ-12.2). Not an error.
  const ciphertext = await selectUnusualWhalesKeyCiphertext(db, userId);
  if (!ciphertext) {
    return c.json({ configured: false });
  }

  const apiKey = decrypt(ciphertext.encryptedKey);
  const client = createUnusualWhalesClient({
    apiKey,
    userId,
    cache: new MarketDataCache(),
    meter: new MarketDataMeter(),
  });

  try {
    const raw = await client.getOptionChain(symbol, expiration);
    return c.json({ configured: true, chain: parseOptionChain(symbol, raw, expiration) });
  } catch (error) {
    logger.warn('options-chain fetch failed', {
      userId,
      symbol,
      code: error instanceof MarketDataError ? error.code : 'unknown',
    });
    throw toHttpError(error);
  }
}
