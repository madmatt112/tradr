// Provider-key write/read handlers (design §Component 7; REQ-5.5–5.9).
//
// BYOK keys are encrypted at rest and NEVER returned in plaintext (REQ-5.7):
//   - GET    /provider-keys             → list status + keyHintTail only
//   - PUT    /provider-keys/:providerId → encrypt, validate (listModels), store
//   - PATCH  /provider-keys/:providerId → change defaultModel only (no key material)
//   - DELETE /provider-keys/:providerId → hard delete (REQ-5.6)
//
// HTTP shape only. All DB work + ownership scoping live in advisor.query.ts
// (consumed via the advisor.service façade). Keys are scoped to the
// authenticated userId.

import type { Context } from 'hono';

import { ProviderIdSchema, ProviderKeyInputSchema, ProviderKeyPatchSchema } from '@tradr/shared';
import type { ProviderId, ProviderKeyListItem, ProviderModel } from '@tradr/shared';

import { encrypt, ENCRYPTION_KEY_VERSION_CURRENT } from '@/lib/encryption';
import { ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { ProviderKeyInvalidError } from './advisor.errors';
import {
  deleteProviderKey,
  listProviderKeysForUser,
  updateProviderKeyDefaultModel,
  upsertProviderKey,
} from './advisor.service';
import type { ProviderKeyListRow } from './advisor.service';
import { selectDefaultClaudeModel } from './providers/claude';
import { selectDefaultGeminiModel } from './providers/gemini';
import { selectDefaultOpenAIModel } from './providers/openai';
import { selectDefaultOpenRouterModel } from './providers/openrouter';
import { getProvider } from './providers/registry';

// REQ-6.4: server-side initial default-model selection, used when the save body
// omits `defaultModel` (a first-time key has no model list to pick from yet).
const DEFAULT_MODEL_SELECTORS: Record<ProviderId, (models: ProviderModel[]) => string> = {
  claude: selectDefaultClaudeModel,
  openai: selectDefaultOpenAIModel,
  gemini: selectDefaultGeminiModel,
  openrouter: selectDefaultOpenRouterModel,
};

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

// REQ-5.8: the save-time listModels probe has a 5-second timeout; on timeout the
// key is saved anyway (`verified: false`) — a transient provider outage must not
// block the user from storing a valid key.
const VALIDATION_TIMEOUT_MS = 5_000;

/** Map a DB row to the wire shape. Never includes key material. */
function toListItem(row: ProviderKeyListRow): ProviderKeyListItem {
  return {
    id: row.id,
    providerId: row.providerId,
    defaultModel: row.defaultModel,
    keyHintTail: row.keyHintTail,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Validate the `:providerId` path param, 400 on an unknown provider. */
function parseProviderId(c: Context<AuthEnv>): ProviderId {
  const parsed = ProviderIdSchema.safeParse(c.req.param('providerId'));
  if (!parsed.success) {
    throw new ValidationError('Validation failed', { providerId: 'unknown provider' });
  }
  return parsed.data;
}

/** GET /provider-keys — the user's configured keys (no key material). */
export async function listProviderKeysHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const rows = await listProviderKeysForUser(userId);
  return c.json({ items: rows.map(toListItem) });
}

/**
 * PUT /provider-keys/:providerId — save (or replace) the BYOK key.
 *
 * The plaintext key is encrypted before storage (REQ-5.1); only the ciphertext,
 * the version hint, the chosen default model, and the last-4-char masking hint
 * are persisted. A validation roundtrip (REQ-5.8) calls the provider's
 * listModels with the supplied key:
 *   - 401/403 → reject (PROVIDER_KEY_INVALID); the key is NOT stored.
 *   - success → store + return `verified: true`.
 *   - timeout / other failure → store anyway + return `verified: false`
 *     (a transient provider outage must not block a legitimate save).
 */
export async function saveProviderKeyHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const providerId = parseProviderId(c);

  const parsed = ProviderKeyInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
  const { apiKey } = parsed.data;

  // Validation roundtrip BEFORE storage so a flat-out rejected key (401/403) is
  // never persisted. Timeouts / other errors fall through to verified:false.
  const { verified, models } = await validateProviderKey(providerId, apiKey, userId);

  // REQ-6.4: when the client sends no defaultModel (first save — the model list
  // only populates once a key exists), pick the provider's deterministic
  // default from the probe's response (nominal default when the probe failed).
  const defaultModel = parsed.data.defaultModel ?? DEFAULT_MODEL_SELECTORS[providerId](models);

  const row = await upsertProviderKey({
    userId,
    providerId,
    encryptedKey: encrypt(apiKey),
    keyVersion: ENCRYPTION_KEY_VERSION_CURRENT,
    defaultModel,
    keyHintTail: apiKey.slice(-4),
  });

  return c.json({ ...toListItem(row), verified });
}

/**
 * Run the listModels probe with a 5s timeout. Returns `verified: true` plus the
 * listed models on success (they feed REQ-6.4 default-model selection), and
 * `verified: false` with an empty list on timeout / non-auth failure. Throws
 * ProviderKeyInvalidError on a 401/403 (the only outcome that blocks storage).
 */
async function validateProviderKey(
  providerId: ProviderId,
  apiKey: string,
  userId: string,
): Promise<{ verified: boolean; models: ProviderModel[] }> {
  const adapter = getProvider(providerId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMEOUT = Symbol('timeout');
  try {
    const result = await Promise.race([
      adapter.listModels(apiKey),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), VALIDATION_TIMEOUT_MS);
      }),
    ]);
    if (result === TIMEOUT) {
      logger.warn('provider key validation timed out — saving unverified', {
        userId,
        providerId,
      });
      return { verified: false, models: [] };
    }
    return { verified: true, models: result };
  } catch (err) {
    const status =
      typeof err === 'object' &&
      err !== null &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : null;
    if (status === 401 || status === 403) {
      throw new ProviderKeyInvalidError();
    }
    // Network / 5xx / unknown — provider may be transiently down; save unverified.
    logger.warn('provider key validation failed (non-auth) — saving unverified', {
      userId,
      providerId,
      error: (err as Error).message,
    });
    return { verified: false, models: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * PATCH /provider-keys/:providerId — change the default model for an existing
 * key without re-supplying the key material. No validation probe (the key is
 * unchanged); an unknown model still fails at stream time (MODEL_NOT_LISTED),
 * mirroring PUT. 404 when no key is configured for the provider.
 */
export async function patchProviderKeyHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const providerId = parseProviderId(c);

  const parsed = ProviderKeyPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }

  const row = await updateProviderKeyDefaultModel({
    userId,
    providerId,
    defaultModel: parsed.data.defaultModel,
  });
  return c.json(toListItem(row));
}

/** DELETE /provider-keys/:providerId — hard delete (REQ-5.6). 204 / 404. */
export async function deleteProviderKeyHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const providerId = parseProviderId(c);
  await deleteProviderKey({ userId, providerId });
  return c.body(null, 204);
}
