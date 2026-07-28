// Thin Drizzle wrappers for advisor persistence (design §Component 4).
//
// This file is intentionally dumb: each function is a single Drizzle/SQL
// statement scoped to a transaction handle. The business orchestration
// (transaction boundary, statement_timeout, dedupe branching, invariant
// checks) lives in `persistence.ts`. Splitting the two keeps the CTE and the
// connection seam in one place while the orchestration stays testable.

import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';

import type { ResponseMessageContentPart, StoredContentPart } from '@tradr/shared';

import { db } from '@/db';
import type { Transaction } from '@/db';
import {
  advisorConversations,
  advisorMessages,
  advisorPersonas,
  advisorProviderKeys,
  advisorSummaries,
} from '@/db/schema/advisor.schema';
import { users } from '@/db/schema/users.schema';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import type { CanonicalPart, ProviderId } from './providers/adapter';

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/** Insert a new conversation row and return its id. */
export async function insertConversation(
  tx: Transaction,
  data: {
    userId: string;
    title: string;
    personaId: string | null;
    providerId: string;
    model: string;
  },
): Promise<string> {
  const rows = await tx
    .insert(advisorConversations)
    .values({
      userId: data.userId,
      title: data.title,
      personaId: data.personaId,
      providerId: data.providerId,
      model: data.model,
    })
    .returning({ id: advisorConversations.id });
  return rows[0].id;
}

/** Bump a conversation's `updated_at` to now. */
export async function touchConversation(tx: Transaction, conversationId: string): Promise<void> {
  await tx
    .update(advisorConversations)
    .set({ updatedAt: new Date() })
    .where(eq(advisorConversations.id, conversationId));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Idempotency-checked user-message insert via a single CTE (design §Component 4
 * step 2 / REQ-3.12 Layer 1). The `ON CONFLICT` predicate matches the partial
 * unique index `advisor_messages_idem` WHERE clause verbatim:
 * `role = 'user' AND client_message_id IS NOT NULL`.
 *
 * Returns the (existing or newly inserted) user-message id and whether this
 * call performed the insert.
 */
export async function insertUserMessageIdempotent(
  tx: Transaction,
  data: {
    conversationId: string;
    // Widened to StoredContentPart[] (CanonicalPart ⊆ StoredContentPart, Task 4)
    // so the object-storage write seam can persist pointer markers; serialized
    // to jsonb below, so the inline base64 path is byte-for-byte unchanged.
    contentParts: StoredContentPart[];
    clientMessageId: string;
  },
): Promise<{ userMessageId: string; wasInserted: boolean }> {
  const cte = sql`
    WITH ins AS (
      INSERT INTO advisor_messages (conversation_id, role, content_parts, client_message_id)
      VALUES (${data.conversationId}, 'user', ${JSON.stringify(data.contentParts)}::jsonb, ${data.clientMessageId})
      ON CONFLICT (conversation_id, client_message_id) WHERE role = 'user' AND client_message_id IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    SELECT
      COALESCE(
        (SELECT id FROM ins),
        (SELECT id FROM advisor_messages
         WHERE conversation_id = ${data.conversationId}
           AND client_message_id = ${data.clientMessageId}
           AND role = 'user')
      ) AS user_message_id,
      EXISTS(SELECT 1 FROM ins) AS was_inserted
  `;
  const result = await tx.execute(cte);
  const row = result[0] as { user_message_id: string; was_inserted: boolean };
  return { userMessageId: row.user_message_id, wasInserted: row.was_inserted };
}

/**
 * Look up the assistant message paired with a user `client_message_id`. The
 * assistant row inherits the user row's `client_message_id` at insert time
 * (design v2-3), so this is a single-statement lookup with NO `created_at`
 * ordering. Returns the assistant id, or `null` if none exists.
 */
export async function findPairedAssistantMessage(
  tx: Transaction,
  data: { conversationId: string; clientMessageId: string },
): Promise<string | null> {
  const rows = await tx
    .select({ id: advisorMessages.id })
    .from(advisorMessages)
    .where(
      and(
        eq(advisorMessages.conversationId, data.conversationId),
        eq(advisorMessages.clientMessageId, data.clientMessageId),
        eq(advisorMessages.role, 'assistant'),
      ),
    )
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Insert the assistant message. It inherits the paired user message's
 * `client_message_id` (design v2-3) so the Layer-1 dedupe lookup above can find
 * it without `created_at` ordering. Returns the new assistant id.
 */
export async function insertAssistantMessage(
  tx: Transaction,
  data: {
    conversationId: string;
    // Full ordered turn output (text/tool_call/tool_result), stored in the
    // single assistant row's `content_parts` JSONB (design §4.3 / REQ-4.3).
    contentParts: CanonicalPart[];
    promptTokens: number | null;
    completionTokens: number | null;
    clientMessageId: string;
  },
): Promise<string> {
  const rows = await tx
    .insert(advisorMessages)
    .values({
      conversationId: data.conversationId,
      role: 'assistant',
      contentParts: data.contentParts,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      clientMessageId: data.clientMessageId,
    })
    .returning({ id: advisorMessages.id });
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Auto-summaries (design §Component 8, REQ-11.3)
// ---------------------------------------------------------------------------

/** A conversation's stored summary (one row per conversation), or null. */
export interface SummaryRow {
  prose: string;
  tradeDataFigures: string | null;
  coveredThroughMessageId: string | null;
  coveredThroughCreatedAt: Date;
}

/**
 * Read the conversation's current summary, or null when none exists. The
 * boundary used for extend-prior and the keep-verbatim window is
 * `coveredThroughCreatedAt` (design §C8 v4); `coveredThroughMessageId` is
 * advisory only.
 */
export async function getSummary(conversationId: string): Promise<SummaryRow | null> {
  const rows = await db
    .select({
      prose: advisorSummaries.prose,
      tradeDataFigures: advisorSummaries.tradeDataFigures,
      coveredThroughMessageId: advisorSummaries.coveredThroughMessageId,
      coveredThroughCreatedAt: advisorSummaries.coveredThroughCreatedAt,
    })
    .from(advisorSummaries)
    .where(eq(advisorSummaries.conversationId, conversationId))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Write (insert-or-replace) the conversation's summary. The write is
 * intentionally NON-ATOMIC with the turn (design §5.3): if the turn later
 * aborts, the advanced summary is harmless additive context and a re-issued
 * turn tolerates it. Keyed by the unique `(conversation_id)` index; the boundary
 * column `covered_through_created_at` is the well-defined recurrence anchor.
 */
export async function upsertSummary(data: {
  conversationId: string;
  prose: string;
  tradeDataFigures: string | null;
  coveredThroughMessageId: string | null;
  coveredThroughCreatedAt: Date;
}): Promise<void> {
  await db
    .insert(advisorSummaries)
    .values({
      conversationId: data.conversationId,
      prose: data.prose,
      tradeDataFigures: data.tradeDataFigures,
      coveredThroughMessageId: data.coveredThroughMessageId,
      coveredThroughCreatedAt: data.coveredThroughCreatedAt,
    })
    .onConflictDoUpdate({
      target: advisorSummaries.conversationId,
      set: {
        prose: data.prose,
        tradeDataFigures: data.tradeDataFigures,
        coveredThroughMessageId: data.coveredThroughMessageId,
        coveredThroughCreatedAt: data.coveredThroughCreatedAt,
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Provider key
// ---------------------------------------------------------------------------

/**
 * Bump the provider key's `last_used_at` to now (REQ-6.6). Scoped to a single
 * statement inside the caller's transaction so a `SET LOCAL statement_timeout`
 * auto-cleans on COMMIT/ROLLBACK.
 */
export async function touchProviderKeyLastUsed(
  tx: Transaction,
  data: { userId: string; providerId: string },
): Promise<void> {
  await tx
    .update(advisorProviderKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(advisorProviderKeys.userId, data.userId),
        eq(advisorProviderKeys.providerId, data.providerId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Streaming read-side context (design §Component 3 steps 2-3)
// ---------------------------------------------------------------------------

/**
 * Assert the user owns the conversation (design step 2). Throws `NOT_FOUND`
 * when the conversation does not exist or belongs to another user — the two
 * cases are deliberately indistinguishable to the client (no existence oracle).
 */
export async function assertOwnsConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  const rows = await db
    .select({ id: advisorConversations.id })
    .from(advisorConversations)
    .where(
      and(eq(advisorConversations.id, conversationId), eq(advisorConversations.userId, userId)),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Conversation', conversationId);
  }
}

/** DB-side streaming context (design step 3). The encrypted provider key is
 * decrypted by the route (step 4) before {@link prepare}. The selected
 * `ProviderModel` is resolved by the route after decryption (it needs the
 * plaintext key to query `listModels`). */
export interface StreamContextRow {
  providerId: ProviderId;
  modelId: string;
  /**
   * Encrypted BYOK key for the resolved provider, or `null` when none is
   * stored (platform path — design §Component 5, REQ-4.2). `null` signals the
   * route to take the platform credential (`getPlatformApiKey`) instead of
   * decrypting; it never decrypts `null`.
   */
  encryptedKey: string | null;
  /**
   * Whether the user has ANY stored BYOK provider key (for any provider), even
   * when `encryptedKey` is null for the resolved turn provider. Drives the
   * was-BYOK→platform `fellThrough` disclosure (wallet-billing REQ-4.4 / REQ-6.5):
   * a key for provider X does not satisfy a turn resolved to provider Y, so the
   * turn falls through to platform billing and the user must be told.
   */
  hasAnyProviderKey: boolean;
  // Raw DB read for the provider path (REQ-2.6, D10): parts are the persisted
  // superset `StoredContentPart` (inline OR object pointer OR unrecoverable).
  // `resolveForProvider` (streaming.ts) re-inlines pointers to `CanonicalPart`
  // once, upfront, at the provider-entry boundary (stream.handler.ts).
  history: Array<
    | { role: 'user'; parts: readonly StoredContentPart[] }
    | { role: 'assistant'; parts: readonly StoredContentPart[] }
  >;
  persona: { systemPrompt: string } | null;
  personaId: string | null;
}

/**
 * Load the streaming context for a submission (design step 3, §Component 5):
 * provider id + model + an *optional* encrypted BYOK key, plus (for existing
 * conversations) the message history and resolved persona.
 *
 * Provider/model resolution (always defined on the non-throwing paths):
 *   - **Existing conversation** → from `advisor_conversations`; `encryptedKey`
 *     is the BYOK key for that provider or `null`. A client `providerOverride`
 *     is ignored (M1 — a client cannot repin an existing conversation).
 *   - **New conversation**, in precedence:
 *       (a) a single stored BYOK key row → seed provider/model from it and
 *           return its `encryptedKey` (today's behaviour, BYOK turn);
 *       (b) else `providerOverride` present → provider/model from it,
 *           `encryptedKey = null` (platform path — the route supplies the env
 *           platform key);
 *       (c) else (no key row AND no `providerOverride`) → throw
 *           `AppError(400, 'MODEL_REQUIRED')` — a request precondition, not a
 *           returned sentinel (mirrors `ModelNotListedError` = 400).
 *
 * Throws on DB connection errors and the path-(c) precondition; ownership is
 * asserted separately by {@link assertOwnsConversation}.
 */
export async function loadStreamContext(args: {
  conversationId: string | null;
  userId: string;
  personaId?: string;
  providerOverride?: { providerId: ProviderId; model: string };
}): Promise<StreamContextRow> {
  const { conversationId, userId, providerOverride } = args;

  // Resolve provider id + model + persona id.
  let providerId: ProviderId;
  let modelId: string;
  let personaId: string | null;
  let history: StreamContextRow['history'] = [];

  if (conversationId !== null) {
    const convRows = await db
      .select({
        providerId: advisorConversations.providerId,
        model: advisorConversations.model,
        personaId: advisorConversations.personaId,
      })
      .from(advisorConversations)
      .where(eq(advisorConversations.id, conversationId))
      .limit(1);
    if (convRows.length === 0) {
      throw new NotFoundError('Conversation', conversationId);
    }
    const conv = convRows[0];
    providerId = conv.providerId as ProviderId;
    modelId = conv.model;
    personaId = conv.personaId;

    const msgRows = await db
      .select({
        role: advisorMessages.role,
        contentParts: advisorMessages.contentParts,
      })
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, conversationId))
      .orderBy(asc(advisorMessages.createdAt), asc(advisorMessages.id));
    history = msgRows.map((m) => ({
      role: m.role as 'user' | 'assistant',
      parts: m.contentParts as StoredContentPart[],
    }));
  } else {
    // New-conversation path (§Component 5 precedence): (a) a single stored
    // provider key seeds provider/model (today's BYOK behaviour); else (b) the
    // request's `providerOverride` seeds them (platform path, no key); else
    // (c) refuse with a MODEL_REQUIRED precondition.
    const keyRows = await db
      .select({
        providerId: advisorProviderKeys.providerId,
        defaultModel: advisorProviderKeys.defaultModel,
      })
      .from(advisorProviderKeys)
      .where(eq(advisorProviderKeys.userId, userId))
      .limit(1);
    if (keyRows.length > 0) {
      providerId = keyRows[0].providerId as ProviderId;
      modelId = keyRows[0].defaultModel;
    } else if (providerOverride) {
      providerId = providerOverride.providerId;
      modelId = providerOverride.model;
    } else {
      throw new AppError(400, 'MODEL_REQUIRED', 'select a provider and model to start');
    }
    personaId = args.personaId ?? null;
  }

  // Load the encrypted BYOK key for the resolved provider, if any. A missing
  // row is the platform path (encryptedKey = null) — NOT an error: the route
  // decides between BYOK (decrypt) and platform (env key). The "configure a
  // key" refusal when no platform key is configured is enforced in the route.
  const encRows = await db
    .select({ encryptedKey: advisorProviderKeys.encryptedKey })
    .from(advisorProviderKeys)
    .where(
      and(eq(advisorProviderKeys.userId, userId), eq(advisorProviderKeys.providerId, providerId)),
    )
    .limit(1);
  const encryptedKey = encRows.length > 0 ? encRows[0].encryptedKey : null;

  // Whether the user has a BYOK key for ANY provider (wallet-billing REQ-4.4 /
  // REQ-6.5). When the resolved provider has no key (`encryptedKey === null`) but
  // the user holds a key for a different provider, the turn falls through to
  // platform billing and the disclosure notice must flag `fellThrough`.
  const hasAnyProviderKey =
    encryptedKey !== null
      ? true
      : (
          await db
            .select({ one: sql`1` })
            .from(advisorProviderKeys)
            .where(eq(advisorProviderKeys.userId, userId))
            .limit(1)
        ).length > 0;

  // Resolve the persona system prompt (if any). Scoped so a user can only read
  // a built-in persona (user_id IS NULL) or one they own (user_id = userId) —
  // referencing another user's custom persona resolves to not-found, in which
  // case persona stays null and assembly proceeds without a system prompt
  // (design §Component 3 step 3 / §Component 7: persona is optional input).
  let persona: { systemPrompt: string } | null = null;
  if (personaId !== null) {
    const personaRows = await db
      .select({ systemPrompt: advisorPersonas.systemPrompt })
      .from(advisorPersonas)
      .where(
        and(
          eq(advisorPersonas.id, personaId),
          sql`(${advisorPersonas.userId} IS NULL OR ${advisorPersonas.userId} = ${userId})`,
        ),
      )
      .limit(1);
    if (personaRows.length > 0) {
      persona = { systemPrompt: personaRows[0].systemPrompt };
    }
  }

  return { providerId, modelId, encryptedKey, hasAnyProviderKey, history, persona, personaId };
}

// ---------------------------------------------------------------------------
// CRUD read/write helpers (REQ-2, REQ-7) — consumed by crud.handler.ts.
//
// Cursor format (REQ-2.4): base64 of `${created_at_iso}|${id}`, encoding the
// `(created_at, id)` tuple of the last-seen row. The list query orders by
// `(created_at DESC, id DESC)` and pages with tuple comparison
// `(created_at, id) < (cursor_created_at, cursor_id)`.
// ---------------------------------------------------------------------------

/** Encode a `(created_at, id)` tuple into the stable base64 cursor. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

/** Decode a base64 cursor into its `(created_at, id)` tuple, or `null` if malformed. */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep === -1) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const createdAt = new Date(iso);
    if (id.length === 0 || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface ConversationListResult {
  items: Array<{
    id: string;
    title: string;
    providerId: ProviderId;
    model: string;
    updatedAt: string;
  }>;
  nextCursor: string | null;
}

/**
 * List the user's conversations sorted by `updatedAt` desc with cursor-based
 * pagination (REQ-2.2). The cursor tuple is `(updated_at, id)`. `limit` is the
 * already-clamped page size (default 25, max 100 — clamped by the handler).
 */
export async function listConversations(args: {
  userId: string;
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
}): Promise<ConversationListResult> {
  const { userId, cursor, limit } = args;
  const where = cursor
    ? and(
        eq(advisorConversations.userId, userId),
        or(
          lt(advisorConversations.updatedAt, cursor.createdAt),
          and(
            eq(advisorConversations.updatedAt, cursor.createdAt),
            lt(advisorConversations.id, cursor.id),
          ),
        ),
      )
    : eq(advisorConversations.userId, userId);

  const rows = await db
    .select({
      id: advisorConversations.id,
      title: advisorConversations.title,
      providerId: advisorConversations.providerId,
      model: advisorConversations.model,
      updatedAt: advisorConversations.updatedAt,
    })
    .from(advisorConversations)
    .where(where)
    .orderBy(desc(advisorConversations.updatedAt), desc(advisorConversations.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      title: r.title,
      providerId: r.providerId as ProviderId,
      model: r.model,
      updatedAt: r.updatedAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : null,
  };
}

/**
 * Return the conversation if owned by the user, else throw NOT_FOUND. The
 * not-found and not-owned cases produce the identical 404 (no IDOR oracle —
 * REQ-2.3).
 */
export async function getConversationOwned(args: {
  conversationId: string;
  userId: string;
}): Promise<{
  id: string;
  userId: string;
  title: string;
  personaId: string | null;
  providerId: ProviderId;
  model: string;
  createdAt: string;
  updatedAt: string;
}> {
  const rows = await db
    .select()
    .from(advisorConversations)
    .where(
      and(
        eq(advisorConversations.id, args.conversationId),
        eq(advisorConversations.userId, args.userId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Conversation', args.conversationId);
  }
  const c = rows[0];
  return {
    id: c.id,
    userId: c.userId,
    title: c.title,
    personaId: c.personaId,
    providerId: c.providerId as ProviderId,
    model: c.model,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Update a conversation's title (REQ-2.5) — ownership-scoped: the row is
 * matched by `(id, userId)`, so a missing OR not-owned conversation produces
 * the identical NOT_FOUND (no IDOR oracle, consistent with the other CRUD
 * helpers). Also bumps `updated_at`. Returns the updated conversation.
 */
export async function updateConversationTitle(args: {
  conversationId: string;
  userId: string;
  title: string;
}): Promise<{
  id: string;
  userId: string;
  title: string;
  personaId: string | null;
  providerId: ProviderId;
  model: string;
  createdAt: string;
  updatedAt: string;
}> {
  const rows = await db
    .update(advisorConversations)
    .set({ title: args.title, updatedAt: new Date() })
    .where(
      and(
        eq(advisorConversations.id, args.conversationId),
        eq(advisorConversations.userId, args.userId),
      ),
    )
    .returning();
  if (rows.length === 0) {
    throw new NotFoundError('Conversation', args.conversationId);
  }
  const c = rows[0];
  return {
    id: c.id,
    userId: c.userId,
    title: c.title,
    personaId: c.personaId,
    providerId: c.providerId as ProviderId,
    model: c.model,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export interface MessageListResult {
  items: Array<{
    id: string;
    conversationId: string;
    role: 'user' | 'assistant';
    contentParts: ResponseMessageContentPart[];
    promptTokens: number | null;
    completionTokens: number | null;
    clientMessageId: string | null;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

/**
 * Client read transform (F2, REQ-2.4): map persisted `StoredContentPart`s to the
 * client `ResponseMessageContentPart` shape, DROPPING the object storage key so
 * it never reaches the client (no IDOR leak). Inline/legacy parts (marker absent)
 * pass through unchanged; a pointer becomes `{ storage: 'object' }` (key removed,
 * type/format kept); an unrecoverable marker becomes `{ storage: 'unrecoverable' }`.
 */
export function toResponseParts(parts: StoredContentPart[]): ResponseMessageContentPart[] {
  return parts.map((part) => {
    if ('storage' in part) {
      // Image-storage marker: keep type/format, never emit the key.
      return part.storage.kind === 'object'
        ? { type: part.type, format: part.format, storage: 'object' as const }
        : { type: part.type, format: part.format, storage: 'unrecoverable' as const };
    }
    // Inline / legacy (text, inline image with dataBase64, tool parts) — unchanged.
    return part;
  });
}

/**
 * List a conversation's messages, newest-first, cursor-paginated (REQ-2.4).
 * Ownership MUST be asserted by the caller before invoking this. The cursor
 * encodes `(created_at, id)`; the query pages with the tuple comparison.
 */
export async function listMessages(args: {
  conversationId: string;
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
}): Promise<MessageListResult> {
  const { conversationId, cursor, limit } = args;
  const where = cursor
    ? and(
        eq(advisorMessages.conversationId, conversationId),
        or(
          lt(advisorMessages.createdAt, cursor.createdAt),
          and(eq(advisorMessages.createdAt, cursor.createdAt), lt(advisorMessages.id, cursor.id)),
        ),
      )
    : eq(advisorMessages.conversationId, conversationId);

  const rows = await db
    .select()
    .from(advisorMessages)
    .where(where)
    .orderBy(desc(advisorMessages.createdAt), desc(advisorMessages.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role as 'user' | 'assistant',
      contentParts: toResponseParts(m.contentParts as StoredContentPart[]),
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      clientMessageId: m.clientMessageId,
      createdAt: m.createdAt.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/**
 * Return the persisted `content_parts` of a message that belongs to the given
 * conversation AND whose conversation is owned by `userId`, or `null` when the
 * message does not exist, is not in that conversation, or the conversation
 * belongs to another user (the cases are deliberately indistinguishable — no
 * IDOR oracle, REQ-2.4). Ownership is enforced in the SQL join, so a guessed
 * conversation/message id can never surface another user's image bytes. Backs
 * the ownership-scoped image proxy (Task 9).
 */
export async function getOwnedMessageParts(args: {
  conversationId: string;
  messageId: string;
  userId: string;
}): Promise<StoredContentPart[] | null> {
  const rows = await db
    .select({ contentParts: advisorMessages.contentParts })
    .from(advisorMessages)
    .innerJoin(advisorConversations, eq(advisorMessages.conversationId, advisorConversations.id))
    .where(
      and(
        eq(advisorMessages.id, args.messageId),
        eq(advisorMessages.conversationId, args.conversationId),
        eq(advisorConversations.userId, args.userId),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0].contentParts as StoredContentPart[];
}

/**
 * Collect the object-storage pointer keys of every image in a conversation owned
 * by `userId` (REQ-2.4 reclamation). Ownership is enforced in the SQL join, so a
 * non-owned/guessed id yields no rows (never reads another user's conversation).
 *
 * MUST be called BEFORE `deleteConversationOwned`: the FK cascade
 * (`advisor.schema.ts:65`) destroys the `advisor_messages` rows on delete and
 * that helper returns void, so these keys are unrecoverable afterwards.
 */
export async function collectConversationObjectKeys(args: {
  conversationId: string;
  userId: string;
}): Promise<string[]> {
  const rows = await db
    .select({ contentParts: advisorMessages.contentParts })
    .from(advisorMessages)
    .innerJoin(advisorConversations, eq(advisorMessages.conversationId, advisorConversations.id))
    .where(
      and(
        eq(advisorMessages.conversationId, args.conversationId),
        eq(advisorConversations.userId, args.userId),
      ),
    );
  const keys: string[] = [];
  for (const row of rows) {
    for (const part of row.contentParts as StoredContentPart[]) {
      if ('storage' in part && part.storage.kind === 'object') {
        keys.push(part.storage.key);
      }
    }
  }
  return keys;
}

/** Delete a conversation owned by the user, else NOT_FOUND. Cascades to messages. */
export async function deleteConversationOwned(args: {
  conversationId: string;
  userId: string;
}): Promise<void> {
  const rows = await db
    .delete(advisorConversations)
    .where(
      and(
        eq(advisorConversations.id, args.conversationId),
        eq(advisorConversations.userId, args.userId),
      ),
    )
    .returning({ id: advisorConversations.id });
  if (rows.length === 0) {
    throw new NotFoundError('Conversation', args.conversationId);
  }
}

// --- Personas ----------------------------------------------------------------

interface PersonaRow {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  systemPrompt: string;
  isBuiltin: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function toPersona(p: typeof advisorPersonas.$inferSelect): PersonaRow {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    isBuiltin: p.isBuiltin,
    isDefault: p.isDefault,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** List the built-in personas plus the personas owned by the user (REQ-7.5). */
export async function listPersonas(userId: string): Promise<PersonaRow[]> {
  const rows = await db
    .select()
    .from(advisorPersonas)
    .where(sql`(${advisorPersonas.userId} IS NULL OR ${advisorPersonas.userId} = ${userId})`)
    .orderBy(desc(advisorPersonas.isBuiltin), asc(advisorPersonas.name));
  return rows.map(toPersona);
}

/**
 * Load a persona that is either built-in or owned by the user, else NOT_FOUND
 * (no cross-user read — REQ-7). Returns the raw row so callers can branch on
 * `isBuiltin` for the 403 rule.
 */
async function loadPersonaScoped(
  personaId: string,
  userId: string,
): Promise<typeof advisorPersonas.$inferSelect> {
  const rows = await db
    .select()
    .from(advisorPersonas)
    .where(
      and(
        eq(advisorPersonas.id, personaId),
        sql`(${advisorPersonas.userId} IS NULL OR ${advisorPersonas.userId} = ${userId})`,
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Persona', personaId);
  }
  return rows[0];
}

/** Create a user-owned persona (REQ-7.7). Returns the inserted row. */
export async function createPersona(args: {
  userId: string;
  name: string;
  description: string | null;
  systemPrompt: string;
}): Promise<PersonaRow> {
  const id = crypto.randomUUID();
  const rows = await db
    .insert(advisorPersonas)
    .values({
      id,
      userId: args.userId,
      name: args.name,
      description: args.description,
      systemPrompt: args.systemPrompt,
      isBuiltin: false,
      isDefault: false,
    })
    .returning();
  return toPersona(rows[0]);
}

/**
 * Update a user-owned persona (REQ-7.7). Built-in personas are rejected with
 * 403 (REQ-7.7-7.9). A non-existent / not-owned persona is NOT_FOUND.
 */
export async function updatePersona(args: {
  personaId: string;
  userId: string;
  patch: { name?: string; description?: string; systemPrompt?: string };
}): Promise<PersonaRow> {
  const existing = await loadPersonaScoped(args.personaId, args.userId);
  if (existing.isBuiltin) {
    throw new ForbiddenError('Built-in personas cannot be edited');
  }
  const rows = await db
    .update(advisorPersonas)
    .set({
      ...(args.patch.name !== undefined ? { name: args.patch.name } : {}),
      ...(args.patch.description !== undefined ? { description: args.patch.description } : {}),
      ...(args.patch.systemPrompt !== undefined ? { systemPrompt: args.patch.systemPrompt } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(advisorPersonas.id, args.personaId), eq(advisorPersonas.userId, args.userId)))
    .returning();
  return toPersona(rows[0]);
}

/**
 * Delete a user-owned persona (REQ-7.7). Built-in → 403. The user's current
 * default → 409 (must change default first). Referencing conversations are
 * left with `persona_id = NULL` via the `ON DELETE SET NULL` FK.
 */
export async function deletePersona(args: { personaId: string; userId: string }): Promise<void> {
  const existing = await loadPersonaScoped(args.personaId, args.userId);
  if (existing.isBuiltin) {
    throw new ForbiddenError('Built-in personas cannot be deleted');
  }
  if (existing.isDefault) {
    throw new ConflictError('Cannot delete the default persona — change the default first');
  }
  await db
    .delete(advisorPersonas)
    .where(and(eq(advisorPersonas.id, args.personaId), eq(advisorPersonas.userId, args.userId)));
}

/**
 * Mark a persona as the user's default for new conversations (REQ-7.9).
 * Atomic flip in one transaction: for user-owned personas, clear the prior
 * default and set the new one; for ALL cases, point `users.advisor_default_persona_id`
 * at the chosen persona. A built-in persona skips the per-persona `is_default`
 * flip (built-ins are shared and never carry `is_default`). The persona must be
 * built-in or owned by the user, else NOT_FOUND.
 */
export async function setDefaultPersona(args: {
  personaId: string;
  userId: string;
}): Promise<void> {
  const existing = await loadPersonaScoped(args.personaId, args.userId);
  await withTransaction(db, async (tx) => {
    if (!existing.isBuiltin) {
      // (a) Flip the user-owned default flag to exactly this persona.
      await tx.execute(sql`
        UPDATE advisor_personas
        SET is_default = (id = ${args.personaId}), updated_at = now()
        WHERE user_id = ${args.userId} AND is_builtin = false
      `);
    } else {
      // Choosing a built-in as default clears any user-owned default flag.
      await tx.execute(sql`
        UPDATE advisor_personas
        SET is_default = false, updated_at = now()
        WHERE user_id = ${args.userId} AND is_builtin = false AND is_default = true
      `);
    }
    // (b) Record the chosen default (built-in or user-owned) on the user row.
    await tx
      .update(users)
      .set({ advisorDefaultPersonaId: args.personaId })
      .where(eq(users.id, args.userId));
  });
}

// --- Provider keys (read-side for GET /models) -------------------------------

/** The user's stored provider keys (encrypted) for the GET /models fan-out. */
export async function listProviderKeyRows(
  userId: string,
): Promise<Array<{ providerId: ProviderId; encryptedKey: string }>> {
  const rows = await db
    .select({
      providerId: advisorProviderKeys.providerId,
      encryptedKey: advisorProviderKeys.encryptedKey,
    })
    .from(advisorProviderKeys)
    .where(eq(advisorProviderKeys.userId, userId));
  return rows.map((r) => ({
    providerId: r.providerId as ProviderId,
    encryptedKey: r.encryptedKey,
  }));
}

/** The wire shape of a stored provider key — NEVER includes the ciphertext or
 * plaintext (REQ-5.7). Used by GET /provider-keys and the PUT response. */
export interface ProviderKeyListRow {
  id: string;
  providerId: ProviderId;
  defaultModel: string;
  keyHintTail: string;
  lastUsedAt: Date | null;
}

const providerKeyListColumns = {
  id: advisorProviderKeys.id,
  providerId: advisorProviderKeys.providerId,
  defaultModel: advisorProviderKeys.defaultModel,
  keyHintTail: advisorProviderKeys.keyHintTail,
  lastUsedAt: advisorProviderKeys.lastUsedAt,
};

function toProviderKeyListRow(r: {
  id: string;
  providerId: string;
  defaultModel: string;
  keyHintTail: string;
  lastUsedAt: Date | null;
}): ProviderKeyListRow {
  return { ...r, providerId: r.providerId as ProviderId };
}

/** List the user's provider keys for GET /provider-keys (no key material). */
export async function listProviderKeysForUser(userId: string): Promise<ProviderKeyListRow[]> {
  const rows = await db
    .select(providerKeyListColumns)
    .from(advisorProviderKeys)
    .where(eq(advisorProviderKeys.userId, userId));
  return rows.map(toProviderKeyListRow);
}

/**
 * Insert or replace (UNIQUE user+provider) the encrypted provider key, returning
 * the wire shape. The plaintext key is encrypted by the caller; only the
 * ciphertext envelope, version hint, and last-4-char hint are persisted.
 */
export async function upsertProviderKey(data: {
  userId: string;
  providerId: ProviderId;
  encryptedKey: string;
  keyVersion: number;
  defaultModel: string;
  keyHintTail: string;
}): Promise<ProviderKeyListRow> {
  const now = new Date();
  const rows = await db
    .insert(advisorProviderKeys)
    .values({
      userId: data.userId,
      providerId: data.providerId,
      encryptedKey: data.encryptedKey,
      keyVersion: data.keyVersion,
      defaultModel: data.defaultModel,
      keyHintTail: data.keyHintTail,
    })
    .onConflictDoUpdate({
      target: [advisorProviderKeys.userId, advisorProviderKeys.providerId],
      set: {
        encryptedKey: data.encryptedKey,
        keyVersion: data.keyVersion,
        defaultModel: data.defaultModel,
        keyHintTail: data.keyHintTail,
        lastUsedAt: null,
        updatedAt: now,
      },
    })
    .returning(providerKeyListColumns);
  return toProviderKeyListRow(rows[0]);
}

/**
 * Update ONLY the default model on an existing key (PATCH /provider-keys).
 * Key material is untouched. NOT_FOUND when no key is configured.
 */
export async function updateProviderKeyDefaultModel(data: {
  userId: string;
  providerId: ProviderId;
  defaultModel: string;
}): Promise<ProviderKeyListRow> {
  const rows = await db
    .update(advisorProviderKeys)
    .set({ defaultModel: data.defaultModel, updatedAt: new Date() })
    .where(
      and(
        eq(advisorProviderKeys.userId, data.userId),
        eq(advisorProviderKeys.providerId, data.providerId),
      ),
    )
    .returning(providerKeyListColumns);
  if (rows.length === 0) {
    throw new NotFoundError('ProviderKey', data.providerId);
  }
  return toProviderKeyListRow(rows[0]);
}

/** Hard-delete the user's key for a provider (REQ-5.6). NOT_FOUND if absent. */
export async function deleteProviderKey(data: {
  userId: string;
  providerId: ProviderId;
}): Promise<void> {
  const rows = await db
    .delete(advisorProviderKeys)
    .where(
      and(
        eq(advisorProviderKeys.userId, data.userId),
        eq(advisorProviderKeys.providerId, data.providerId),
      ),
    )
    .returning({ id: advisorProviderKeys.id });
  if (rows.length === 0) {
    throw new NotFoundError('ProviderKey', data.providerId);
  }
}
