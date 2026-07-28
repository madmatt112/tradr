// Thin Drizzle wrappers for external API keys (Unusual Whales BYOK) and the
// trade-data consent flag (design §Component 5 / §Component 7). Mirrors the
// provider-key helpers in `advisor.query.ts`: each function is a single
// userId-scoped statement taking a `Database | Transaction` handle as its first
// argument so callers can compose them inside or outside a transaction.

import { and, eq } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { externalApiKeys } from '@/db/schema/advisor.schema';
import { users } from '@/db/schema/users.schema';

/** The only external provider this slice manages. */
export const UNUSUAL_WHALES_PROVIDER = 'unusual-whales';

type Db = Database | Transaction;

/**
 * The masked wire shape of a stored external API key — NEVER includes the
 * ciphertext or plaintext (REQ-6.2). `configured` is always true when a row is
 * returned; the field exists so the absence (`null`) and presence cases share a
 * single nullable shape at the call site.
 */
export interface ExternalKeyMasked {
  configured: true;
  keyHintTail: string;
  verified: boolean;
}

/** The ciphertext envelope for decryption at tool-context build time (REQ-1.7). */
export interface ExternalKeyCiphertext {
  encryptedKey: string;
  keyVersion: number;
}

/**
 * Insert or replace (UNIQUE user+provider) the encrypted Unusual Whales key
 * (REQ-6.1). The plaintext is encrypted by the caller; only the ciphertext
 * envelope, version, last-4 hint, and verification flag are persisted. Respects
 * `external_api_keys_user_provider_uniq` via ON CONFLICT.
 */
export async function upsertUnusualWhalesKey(
  db: Db,
  data: {
    userId: string;
    encryptedKey: string;
    keyVersion: number;
    keyHintTail: string;
    verified: boolean;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(externalApiKeys)
    .values({
      userId: data.userId,
      provider: UNUSUAL_WHALES_PROVIDER,
      encryptedKey: data.encryptedKey,
      keyVersion: data.keyVersion,
      keyHintTail: data.keyHintTail,
      verified: data.verified,
    })
    .onConflictDoUpdate({
      target: [externalApiKeys.userId, externalApiKeys.provider],
      set: {
        encryptedKey: data.encryptedKey,
        keyVersion: data.keyVersion,
        keyHintTail: data.keyHintTail,
        verified: data.verified,
        lastUsedAt: null,
        updatedAt: now,
      },
    });
}

/**
 * Read the masked view of the user's Unusual Whales key (REQ-6.2), or `null` if
 * none is stored. Returns neither plaintext nor ciphertext.
 */
export async function selectUnusualWhalesKeyMasked(
  db: Db,
  userId: string,
): Promise<ExternalKeyMasked | null> {
  const rows = await db
    .select({
      keyHintTail: externalApiKeys.keyHintTail,
      verified: externalApiKeys.verified,
    })
    .from(externalApiKeys)
    .where(
      and(
        eq(externalApiKeys.userId, userId),
        eq(externalApiKeys.provider, UNUSUAL_WHALES_PROVIDER),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { configured: true, keyHintTail: rows[0].keyHintTail, verified: rows[0].verified };
}

/**
 * Read the ciphertext envelope of the user's Unusual Whales key for decryption
 * at tool-context build time (REQ-1.7 per-iteration re-read), or `null` if none
 * is stored. Returns the encrypted key + version only — no masked metadata.
 */
export async function selectUnusualWhalesKeyCiphertext(
  db: Db,
  userId: string,
): Promise<ExternalKeyCiphertext | null> {
  const rows = await db
    .select({
      encryptedKey: externalApiKeys.encryptedKey,
      keyVersion: externalApiKeys.keyVersion,
    })
    .from(externalApiKeys)
    .where(
      and(
        eq(externalApiKeys.userId, userId),
        eq(externalApiKeys.provider, UNUSUAL_WHALES_PROVIDER),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { encryptedKey: rows[0].encryptedKey, keyVersion: rows[0].keyVersion };
}

/** Whether the user has an Unusual Whales key stored (REQ-1.7 capability snapshot). */
export async function hasUnusualWhalesKey(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: externalApiKeys.id })
    .from(externalApiKeys)
    .where(
      and(
        eq(externalApiKeys.userId, userId),
        eq(externalApiKeys.provider, UNUSUAL_WHALES_PROVIDER),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Hard-delete the user's Unusual Whales key (REQ-6.2). Returns whether a row was
 * removed so the caller can map an absent key to 404.
 */
export async function deleteUnusualWhalesKey(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .delete(externalApiKeys)
    .where(
      and(
        eq(externalApiKeys.userId, userId),
        eq(externalApiKeys.provider, UNUSUAL_WHALES_PROVIDER),
      ),
    )
    .returning({ id: externalApiKeys.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Trade-data consent (users.advisor_trade_data_consent — REQ-9.1)
// ---------------------------------------------------------------------------

/** Read the user's trade-data consent flag (REQ-9.1). Defaults to false. */
export async function getTradeDataConsent(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ consent: users.advisorTradeDataConsent })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows.length > 0 ? rows[0].consent : false;
}

/** Set the user's trade-data consent flag (REQ-9.1). */
export async function setTradeDataConsent(db: Db, userId: string, consent: boolean): Promise<void> {
  await db
    .update(users)
    .set({ advisorTradeDataConsent: consent, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
