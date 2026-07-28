// External-key (Unusual Whales market-data BYOK) write/read handlers
// (design §Component 5; REQ-6.2, REQ-6.3, REQ-6.6). Mirrors
// `provider-keys.handler.ts`:
//   - GET    /market-data-key → masked status ({configured, keyHintTail, verified})
//   - PUT    /market-data-key → encrypt, optional verification probe, store
//   - DELETE /market-data-key → hard delete (REQ-6.2)
//
// HTTP shape only. All DB work + ownership scoping live in external-keys.query.ts
// (userId-scoped). The plaintext key is encrypted at rest and NEVER returned
// (REQ-6.2/6.6); the probe holds it only for the call's lifetime.

import type { Context } from 'hono';
import { z } from 'zod';

import { db } from '@/db';
import { encrypt, ENCRYPTION_KEY_VERSION_CURRENT } from '@/lib/encryption';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { MarketDataKeyInvalidError } from './advisor.errors';
import {
  deleteUnusualWhalesKey,
  type ExternalKeyCiphertext,
  getTradeDataConsent,
  selectUnusualWhalesKeyCiphertext,
  selectUnusualWhalesKeyMasked,
  setTradeDataConsent,
  upsertUnusualWhalesKey,
} from './external-keys.query';
import {
  createUnusualWhalesClient,
  MarketDataCache,
  MarketDataError,
  MarketDataMeter,
} from './lib/unusual-whales.client';
import { TOOL_RESULT_CODES } from './tools/error-codes';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

// Save-time verification probe symbol used as the canonical quote target. AAPL
// is a stable, always-listed ticker; the probe only needs a 401/403-vs-not
// signal, not the data.
const PROBE_SYMBOL = 'AAPL';

/** Body shape for PUT — the market-data key is a single secret (no model). */
const MarketDataKeyInputSchema = z.object({ apiKey: z.string().min(8) });

/**
 * GET /market-data-key — the masked status of the user's Unusual Whales key
 * (REQ-6.2). Returns `{ configured: false }` when none is stored; otherwise
 * `{ configured: true, keyHintTail, verified }`. Never key material.
 */
export async function getMarketDataKeyHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const masked = await selectUnusualWhalesKeyMasked(db, userId);
  if (!masked) return c.json({ configured: false });
  return c.json(masked);
}

/**
 * PUT /market-data-key — save (or replace) the Unusual Whales key.
 *
 * The plaintext is encrypted before storage (REQ-6.6); only the ciphertext
 * envelope, version, last-4 hint, and verification flag are persisted. A
 * lightweight verification probe (REQ-6.3) calls `getStockQuote`:
 *   - 401/403 → reject (MARKET_DATA_KEY_INVALID); the key is NOT stored.
 *   - success → store + `verified: true`.
 *   - timeout / unavailable / other → store anyway + `verified: false`
 *     (a transient outage must not block a legitimate save).
 */
export async function saveMarketDataKeyHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');

  const parsed = MarketDataKeyInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
  const { apiKey } = parsed.data;

  // Probe BEFORE storage so a flat-out rejected key (401/403) is never
  // persisted. Transient failures fall through to verified:false.
  const verified = await verifyMarketDataKey(apiKey, userId);

  await upsertUnusualWhalesKey(db, {
    userId,
    encryptedKey: encrypt(apiKey),
    keyVersion: ENCRYPTION_KEY_VERSION_CURRENT,
    keyHintTail: apiKey.slice(-4),
    verified,
  });

  return c.json({ configured: true, keyHintTail: apiKey.slice(-4), verified });
}

/**
 * Run the verification probe (REQ-6.3) with the supplied key. Returns `true` on
 * a successful quote, `false` on a transient failure (unavailable / rate-limited
 * / symbol-not-found — none of which prove the key is bad). Throws
 * MarketDataKeyInvalidError on a 401/403 (the only outcome that blocks storage),
 * surfacing the REQ-15 `MARKET_DATA_KEY_INVALID` code (tool_result bucket).
 */
async function verifyMarketDataKey(apiKey: string, userId: string): Promise<boolean> {
  const client = createUnusualWhalesClient({
    apiKey,
    userId,
    cache: new MarketDataCache(),
    meter: new MarketDataMeter(),
  });
  try {
    await client.getStockQuote(PROBE_SYMBOL);
    return true;
  } catch (err) {
    if (err instanceof MarketDataError && err.code === TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID) {
      throw new MarketDataKeyInvalidError();
    }
    // Transient — UW down / rate-limited / unexpected. Save unverified.
    logger.warn('market-data key verification failed (non-auth) — saving unverified', {
      userId,
      error: (err as Error).message,
    });
    return false;
  }
}

/** DELETE /market-data-key — hard delete (REQ-6.2). 204 / 404. */
export async function deleteMarketDataKeyHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const deleted = await deleteUnusualWhalesKey(db, userId);
  if (!deleted) throw new NotFoundError('MarketDataKey', userId);
  return c.body(null, 204);
}

// ---------------------------------------------------------------------------
// Trade-data consent (REQ-9.1) + per-iteration re-read helper (REQ-1.7)
// ---------------------------------------------------------------------------

/** Body shape for PUT /trade-data-consent. */
const TradeDataConsentInputSchema = z.object({ consent: z.boolean() });

/**
 * GET /trade-data-consent — the user's current trade-data consent flag
 * (REQ-9.1). Defaults to `false` for a user who has never set it.
 */
export async function getTradeDataConsentHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const consent = await getTradeDataConsent(db, userId);
  return c.json({ consent });
}

/**
 * PUT /trade-data-consent — set (or clear) the user's trade-data consent flag
 * (REQ-9.1). Turning consent off stops new trade-data reads and removes stored
 * structured trade-data from what is replayed to the provider; it does not
 * delete already-disclosed figures (REQ-10.2 — handled in the replay layer).
 */
export async function setTradeDataConsentHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');

  const parsed = TradeDataConsentInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }

  await setTradeDataConsent(db, userId, parsed.data.consent);
  return c.json({ consent: parsed.data.consent });
}

/**
 * The fresh per-round-trip authorization snapshot (REQ-1.7). `consent` and
 * `hasUwKey` gate which tools are offered/dispatched on the current iteration;
 * `uwKeyCiphertext` is the current ciphertext envelope (or `null`) so the loop
 * can rebuild the Unusual Whales client per iteration and honor a mid-turn key
 * rotation. Model capability is immutable within a turn and is NOT re-read.
 */
export interface AdvisorIterationState {
  consent: boolean;
  hasUwKey: boolean;
  uwKeyCiphertext: ExternalKeyCiphertext | null;
}

/**
 * Re-read the per-iteration authorization state (REQ-1.7) for `userId`:
 * `{consent, hasUwKey, uwKeyCiphertext}`. These are small, indexed reads on the
 * shared pool whose connections are released immediately — invoked between
 * provider round-trips, never held across a provider call. The ciphertext (not
 * just a presence boolean) is returned so the caller can rebuild the UW client
 * for a rotated key. `hasUwKey` is derived from the ciphertext read, avoiding a
 * separate existence query.
 */
export async function reReadAdvisorIterationState(userId: string): Promise<AdvisorIterationState> {
  const [consent, uwKeyCiphertext] = await Promise.all([
    getTradeDataConsent(db, userId),
    selectUnusualWhalesKeyCiphertext(db, userId),
  ]);
  return { consent, hasUwKey: uwKeyCiphertext !== null, uwKeyCiphertext };
}
