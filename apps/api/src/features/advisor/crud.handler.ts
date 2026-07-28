// Advisor CRUD handlers (design §Component 7; REQ-2, REQ-7).
//
// Covers every advisor endpoint EXCEPT the streaming endpoints (Task 24) and
// the provider-key write endpoints (Task 26):
//   - conversations: list, get (+ first message page), delete
//   - messages: list (cursor-paginated)
//   - personas: list, create, update, delete, set-default
//   - GET /models: the cached ProviderModel[] across the user's provider keys
//
// HTTP shape only. All DB work + ownership scoping + the built-in-persona 403
// rule live in advisor.query.ts (consumed via the advisor.service façade). A
// not-found / not-owned resource is an indistinguishable 404 (no IDOR oracle).

import type { Context } from 'hono';

import { ConversationRenameSchema, PersonaInputSchema } from '@tradr/shared';
import type { ProviderId, ProviderModel } from '@tradr/shared';

import { decrypt, EncryptionError } from '@/lib/encryption';
import { ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getObjectStorage } from '@/lib/object-storage';

import { KeyDecryptFailedError } from './advisor.errors';
import {
  collectConversationObjectKeys,
  createPersona,
  decodeCursor,
  deleteConversationOwned,
  deletePersona,
  getConversationOwned,
  listConversations,
  listMessages,
  listPersonas,
  listProviderKeyRows,
  setDefaultPersona,
  updateConversationTitle,
  updatePersona,
} from './advisor.service';
import { getProvider } from './providers/registry';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

const DEFAULT_CONVERSATION_LIMIT = 25;
const MAX_CONVERSATION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;

/** Parse, clamp, and default the `limit` query param. */
function parseLimit(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('Validation failed', { limit: 'must be a positive integer' });
  }
  return Math.min(n, max);
}

/** Parse a `cursor` query param into its tuple, or null when absent. Malformed → 400. */
function parseCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (raw === undefined || raw === '') return null;
  const decoded = decodeCursor(raw);
  if (decoded === null) {
    throw new ValidationError('Validation failed', { cursor: 'malformed cursor' });
  }
  return decoded;
}

// --- Conversations -----------------------------------------------------------

export async function listConversationsHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const limit = parseLimit(
    c.req.query('limit'),
    DEFAULT_CONVERSATION_LIMIT,
    MAX_CONVERSATION_LIMIT,
  );
  const cursor = parseCursor(c.req.query('cursor'));
  const result = await listConversations({ userId, cursor, limit });
  return c.json(result);
}

export async function getConversationHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const conversationId = c.req.param('id') as string;
  // Ownership-scoped read: throws NOT_FOUND when missing OR not owned.
  const conversation = await getConversationOwned({ conversationId, userId });
  // REQ-2.3: return the conversation and its latest 50 messages (cursor for older pages).
  const messages = await listMessages({
    conversationId,
    cursor: null,
    limit: DEFAULT_MESSAGE_LIMIT,
  });
  return c.json({
    conversation,
    messages: messages.items,
    nextCursor: messages.nextCursor,
  });
}

export async function renameConversationHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const conversationId = c.req.param('id') as string;
  // REQ-2.5: title 1–200 chars, whitespace-only rejected (400).
  const parsed = ConversationRenameSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
  // Ownership-scoped update: throws NOT_FOUND when missing OR not owned.
  const conversation = await updateConversationTitle({
    conversationId,
    userId,
    title: parsed.data.title,
  });
  return c.json(conversation);
}

export async function deleteConversationHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const conversationId = c.req.param('id') as string;

  // REQ-2.4 reclamation: when object storage is on, collect the conversation's
  // image pointer keys BEFORE the delete. The FK cascade destroys the
  // advisor_messages rows and deleteConversationOwned returns void, so the keys
  // are unrecoverable afterwards. The scan is ownership-scoped (no cross-user
  // read). Inert when storage is off — no scan, no deletes.
  const storage = getObjectStorage();
  const keys = storage ? await collectConversationObjectKeys({ conversationId, userId }) : [];

  await deleteConversationOwned({ conversationId, userId });

  // After the delete transaction commits, best-effort delete each object. A
  // failure is warn-logged and NEVER fatal — the request still succeeds (the
  // age-guarded storage gc is the backstop, design §Component 9).
  if (storage) {
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch (err) {
        logger.warn('advisor image reclamation delete failed', {
          event: 'object-store-unreachable',
          userId,
          conversationId,
          key,
          error: (err as Error).message,
        });
      }
    }
  }

  return c.body(null, 204);
}

// --- Messages ----------------------------------------------------------------

export async function listMessagesHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const conversationId = c.req.param('id') as string;
  // Assert ownership first (NOT_FOUND otherwise) so message pages cannot leak
  // across users via a guessed conversation id.
  await getConversationOwned({ conversationId, userId });
  const limit = parseLimit(c.req.query('limit'), DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const cursor = parseCursor(c.req.query('cursor'));
  const result = await listMessages({ conversationId, cursor, limit });
  return c.json(result);
}

// --- Personas ----------------------------------------------------------------

export async function listPersonasHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const personas = await listPersonas(userId);
  return c.json({ items: personas });
}

export async function createPersonaHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const parsed = PersonaInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
  const persona = await createPersona({
    userId,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    systemPrompt: parsed.data.systemPrompt,
  });
  return c.json(persona, 201);
}

const PersonaPatchSchema = PersonaInputSchema.partial();

export async function updatePersonaHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const personaId = c.req.param('id') as string;
  const parsed = PersonaPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
  // Built-in → 403; not-owned / missing → 404 (enforced in updatePersona).
  const persona = await updatePersona({ personaId, userId, patch: parsed.data });
  return c.json(persona);
}

export async function deletePersonaHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const personaId = c.req.param('id') as string;
  // Built-in → 403; default → 409; not-owned / missing → 404.
  await deletePersona({ personaId, userId });
  return c.body(null, 204);
}

export async function setDefaultPersonaHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const personaId = c.req.param('id') as string;
  // not-owned / missing → 404; atomic flip otherwise.
  await setDefaultPersona({ personaId, userId });
  return c.body(null, 204);
}

// --- Models ------------------------------------------------------------------

/**
 * Return the available models across every provider the user has configured a
 * key for, each tagged with its `providerId` so the client can scope a
 * per-provider selector. Each provider's `listModels(apiKey)` is served from
 * the shared `ListModelsCache` (10-minute TTL) — repeat calls within the window
 * hit the cache and never touch the upstream API. A provider whose key fails to
 * decrypt or whose upstream lookup throws is skipped (logged) so one broken key
 * never blocks the rest of the list.
 */
export async function listModelsHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const keys = await listProviderKeyRows(userId);

  const models: (ProviderModel & { providerId: ProviderId })[] = [];
  for (const key of keys) {
    let apiKey: string;
    try {
      apiKey = decrypt(key.encryptedKey);
    } catch (err) {
      if (err instanceof EncryptionError) {
        throw new KeyDecryptFailedError();
      }
      throw err;
    }
    try {
      const adapter = getProvider(key.providerId);
      const list = await adapter.listModels(apiKey);
      models.push(...list.map((m) => ({ ...m, providerId: key.providerId })));
    } catch (err) {
      logger.warn('listModels failed for provider (skipped)', {
        userId,
        providerId: key.providerId,
        error: (err as Error).message,
      });
    }
  }

  return c.json({ items: models });
}
