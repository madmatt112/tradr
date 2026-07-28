// Advisor CRUD route + handler integration tests (Task 25; design §Component 7).
//
// EXACTLY 14 it() cases: conversations list/get/get-404/delete/rename/
// rename-404/rename-invalid, messages list, personas
// list/create/built-in-403/delete-not-owned-404, set-default, and
// GET /models. The query/service helpers, the provider registry, and the
// encryption util are mocked at the module boundary (the mocked-adapter
// boundary per REQ-11.4) so these are deterministic handler-level tests of the
// HTTP shape, ownership 404s, and the built-in 403 rule.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/middleware/error.middleware';

// --- Module mocks ------------------------------------------------------------

const listConversations = vi.fn();
const getConversationOwned = vi.fn();
const updateConversationTitle = vi.fn();
const deleteConversationOwned = vi.fn();
const listMessages = vi.fn();
const listPersonas = vi.fn();
const createPersona = vi.fn();
const updatePersona = vi.fn();
const deletePersona = vi.fn();
const setDefaultPersona = vi.fn();
const listProviderKeyRows = vi.fn();
const decodeCursorReal = (raw: string) => {
  const txt = Buffer.from(raw, 'base64').toString('utf8');
  const i = txt.indexOf('|');
  if (i === -1) return null;
  const d = new Date(txt.slice(0, i));
  if (Number.isNaN(d.getTime())) return null;
  return { createdAt: d, id: txt.slice(i + 1) };
};

const listModels = vi.fn();
const getProvider = vi.fn<(...a: unknown[]) => { id: string; listModels: typeof listModels }>(
  () => ({ id: 'claude', listModels }),
);
const decrypt = vi.fn();

vi.mock('./advisor.service', () => ({
  listConversations: (...a: unknown[]) => listConversations(...a),
  getConversationOwned: (...a: unknown[]) => getConversationOwned(...a),
  updateConversationTitle: (...a: unknown[]) => updateConversationTitle(...a),
  deleteConversationOwned: (...a: unknown[]) => deleteConversationOwned(...a),
  listMessages: (...a: unknown[]) => listMessages(...a),
  listPersonas: (...a: unknown[]) => listPersonas(...a),
  createPersona: (...a: unknown[]) => createPersona(...a),
  updatePersona: (...a: unknown[]) => updatePersona(...a),
  deletePersona: (...a: unknown[]) => deletePersona(...a),
  setDefaultPersona: (...a: unknown[]) => setDefaultPersona(...a),
  listProviderKeyRows: (...a: unknown[]) => listProviderKeyRows(...a),
  decodeCursor: (raw: string) => decodeCursorReal(raw),
}));
vi.mock('./providers/registry', () => ({
  getProvider: (...a: unknown[]) => getProvider(...a),
}));
vi.mock('@/lib/encryption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
  return { ...actual, decrypt: (...a: unknown[]) => decrypt(...a) };
});

import {
  createPersonaHandler,
  deleteConversationHandler,
  deletePersonaHandler,
  getConversationHandler,
  listConversationsHandler,
  listMessagesHandler,
  listModelsHandler,
  listPersonasHandler,
  renameConversationHandler,
  setDefaultPersonaHandler,
  updatePersonaHandler,
} from './crud.handler';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', 'user-1');
    c.set('isAdmin', false);
    await next();
  });
  app.get('/conversations', listConversationsHandler);
  app.get('/conversations/:id', getConversationHandler);
  app.patch('/conversations/:id', renameConversationHandler);
  app.delete('/conversations/:id', deleteConversationHandler);
  app.get('/conversations/:id/messages', listMessagesHandler);
  app.get('/personas', listPersonasHandler);
  app.post('/personas', createPersonaHandler);
  app.patch('/personas/:id', updatePersonaHandler);
  app.delete('/personas/:id', deletePersonaHandler);
  app.post('/personas/:id/default', setDefaultPersonaHandler);
  app.get('/models', listModelsHandler);
  app.onError(errorHandler);
  return app;
}

const UUID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  getProvider.mockReturnValue({ id: 'claude', listModels });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('advisor CRUD routes', () => {
  // --- 1. conversations list (pagination passthrough) ------------------------
  it('lists conversations and clamps the limit, returning items + nextCursor', async () => {
    listConversations.mockResolvedValue({
      items: [{ id: UUID, title: 't', providerId: 'claude', model: 'm', updatedAt: 'x' }],
      nextCursor: 'cur',
    });
    const app = makeApp();
    const res = await app.request('/conversations?limit=500');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe('cur');
    // limit clamped to the 100 maximum.
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', limit: 100, cursor: null }),
    );
  });

  // --- 2. conversation get (conversation + latest message page) --------------
  it('returns a conversation with its newest message page', async () => {
    getConversationOwned.mockResolvedValue({ id: UUID, title: 't' });
    listMessages.mockResolvedValue({ items: [{ id: 'm1' }], nextCursor: null });
    const app = makeApp();
    const res = await app.request(`/conversations/${UUID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.id).toBe(UUID);
    expect(body.messages).toHaveLength(1);
    expect(getConversationOwned).toHaveBeenCalledWith({ conversationId: UUID, userId: 'user-1' });
  });

  // --- 3. conversation get — ownership 404 (IDOR guard) ----------------------
  it('returns 404 NOT_FOUND when the conversation is not owned', async () => {
    const { NotFoundError } = await import('@/lib/errors');
    getConversationOwned.mockRejectedValue(new NotFoundError('Conversation', UUID));
    const app = makeApp();
    const res = await app.request(`/conversations/${UUID}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  // --- 4. messages list (ownership asserted, then paginate) ------------------
  it('lists messages after asserting ownership, returning 404 if not owned', async () => {
    const { NotFoundError } = await import('@/lib/errors');
    getConversationOwned.mockRejectedValue(new NotFoundError('Conversation', UUID));
    const app = makeApp();
    const res = await app.request(`/conversations/${UUID}/messages`);
    expect(res.status).toBe(404);
    expect(listMessages).not.toHaveBeenCalled();
  });

  // --- 5. conversation delete ------------------------------------------------
  it('deletes a conversation and returns 204', async () => {
    deleteConversationOwned.mockResolvedValue(undefined);
    const app = makeApp();
    const res = await app.request(`/conversations/${UUID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleteConversationOwned).toHaveBeenCalledWith({
      conversationId: UUID,
      userId: 'user-1',
    });
  });

  // --- 5b. conversation rename — success (REQ-2.5) ---------------------------
  it('renames a conversation and returns the updated title', async () => {
    updateConversationTitle.mockResolvedValue({ id: UUID, title: 'New title' });
    const app = makeApp();
    const res = await app.request(`/conversations/${UUID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('New title');
    expect(updateConversationTitle).toHaveBeenCalledWith({
      conversationId: UUID,
      userId: 'user-1',
      title: 'New title',
    });
  });

  // --- 5c. conversation rename — ownership 404 -------------------------------
  it('returns 404 NOT_FOUND when renaming a conversation that is not owned', async () => {
    const { NotFoundError } = await import('@/lib/errors');
    updateConversationTitle.mockRejectedValue(new NotFoundError('Conversation', UUID));
    const app = makeApp();
    const res = await app.request(`/conversations/${UUID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  // --- 5d. conversation rename — invalid title 400 (REQ-2.5 bounds) ----------
  it('returns 400 for an empty/whitespace or over-length title', async () => {
    const app = makeApp();
    // Whitespace-only → rejected.
    const blank = await app.request(`/conversations/${UUID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(blank.status).toBe(400);
    // Over the 200-char bound → rejected.
    const tooLong = await app.request(`/conversations/${UUID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201) }),
    });
    expect(tooLong.status).toBe(400);
    expect(updateConversationTitle).not.toHaveBeenCalled();
  });

  // --- 6. personas list ------------------------------------------------------
  it('lists built-in plus user-owned personas', async () => {
    listPersonas.mockResolvedValue([
      { id: 'default-trading-advisor', isBuiltin: true },
      { id: 'p1', isBuiltin: false },
    ]);
    const app = makeApp();
    const res = await app.request('/personas');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
  });

  // --- 7. persona create -----------------------------------------------------
  it('creates a persona and returns 201', async () => {
    createPersona.mockResolvedValue({ id: 'p2', name: 'Coach', isBuiltin: false });
    const app = makeApp();
    const res = await app.request('/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Coach', systemPrompt: 'be helpful' }),
    });
    expect(res.status).toBe(201);
    expect(createPersona).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', name: 'Coach', systemPrompt: 'be helpful' }),
    );
  });

  // --- 8. persona update — built-in 403 (REQ-7.7-7.9) ------------------------
  it('returns 403 FORBIDDEN when editing a built-in persona', async () => {
    const { ForbiddenError } = await import('@/lib/errors');
    updatePersona.mockRejectedValue(new ForbiddenError('Built-in personas cannot be edited'));
    const app = makeApp();
    const res = await app.request('/personas/default-trading-advisor', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  // --- 9. persona delete — ownership 404 -------------------------------------
  it('returns 404 NOT_FOUND when deleting a persona that is not owned', async () => {
    const { NotFoundError } = await import('@/lib/errors');
    deletePersona.mockRejectedValue(new NotFoundError('Persona', 'p9'));
    const app = makeApp();
    const res = await app.request('/personas/p9', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  // --- 10. set default persona -----------------------------------------------
  it('sets a persona as default and returns 204', async () => {
    setDefaultPersona.mockResolvedValue(undefined);
    const app = makeApp();
    const res = await app.request('/personas/p1/default', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(setDefaultPersona).toHaveBeenCalledWith({ personaId: 'p1', userId: 'user-1' });
  });

  // --- 11. GET /models — cached ProviderModel[] across the user's keys --------
  it('returns the cached models across the user provider keys', async () => {
    listProviderKeyRows.mockResolvedValue([{ providerId: 'claude', encryptedKey: 'enc' }]);
    decrypt.mockReturnValue('plaintext-key');
    listModels.mockResolvedValue([
      { id: 'claude-opus-4-7', displayName: 'Opus', contextWindow: 1_000_000, vision: true },
    ]);
    const app = makeApp();
    const res = await app.request('/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('claude-opus-4-7');
    expect(listModels).toHaveBeenCalledWith('plaintext-key');
  });
});
