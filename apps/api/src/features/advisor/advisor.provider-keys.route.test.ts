// Provider-key route + handler integration tests (Task 26; design §Component 7,
// REQ-5.5–5.9 + REQ-6.4 server-side default-model selection):
//   1. GET   list — status + keyHintTail only, NEVER the plaintext/ciphertext.
//   2. PUT   save — listModels success → verified: true (encrypts before store).
//   3. PUT   save — listModels 401     → PROVIDER_KEY_INVALID, NOT stored.
//   4. PUT   save — listModels timeout → verified: false (stored anyway, REQ-5.8).
//   5. PUT   save without defaultModel → server picks the REQ-6.4 default from
//      the probe's models (nominal default when the probe timed out).
//   6. PATCH — change defaultModel only: 200 without touching key material or
//      running the probe; 400 on empty model; 404 when no key configured.
//   7. DELETE — 204 on delete; 404 when no key for the provider.
//
// The query/service helpers, the provider registry, and the encryption util are
// mocked at the module boundary so these are deterministic handler-level tests
// of the HTTP shape, the no-plaintext rule, and the validation roundtrip.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/middleware/error.middleware';

// --- Module mocks ------------------------------------------------------------

const listProviderKeysForUser = vi.fn();
const upsertProviderKey = vi.fn();
const updateProviderKeyDefaultModel = vi.fn();
const deleteProviderKey = vi.fn();

const listModels = vi.fn();
const getProvider = vi.fn<(...a: unknown[]) => { id: string; listModels: typeof listModels }>(
  () => ({ id: 'claude', listModels }),
);
const encrypt = vi.fn((plaintext: string) => `enc(${plaintext})`);

vi.mock('./advisor.service', () => ({
  listProviderKeysForUser: (...a: unknown[]) => listProviderKeysForUser(...a),
  upsertProviderKey: (...a: unknown[]) => upsertProviderKey(...a),
  updateProviderKeyDefaultModel: (...a: unknown[]) => updateProviderKeyDefaultModel(...a),
  deleteProviderKey: (...a: unknown[]) => deleteProviderKey(...a),
}));
vi.mock('./providers/registry', () => ({
  getProvider: (...a: unknown[]) => getProvider(...a),
}));
vi.mock('@/lib/encryption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
  return { ...actual, encrypt: (plaintext: string) => encrypt(plaintext) };
});

import {
  deleteProviderKeyHandler,
  listProviderKeysHandler,
  patchProviderKeyHandler,
  saveProviderKeyHandler,
} from './provider-keys.handler';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', 'user-1');
    c.set('isAdmin', false);
    await next();
  });
  app.get('/provider-keys', listProviderKeysHandler);
  app.put('/provider-keys/:providerId', saveProviderKeyHandler);
  app.patch('/provider-keys/:providerId', patchProviderKeyHandler);
  app.delete('/provider-keys/:providerId', deleteProviderKeyHandler);
  app.onError(errorHandler);
  return app;
}

const UUID = '11111111-1111-4111-8111-111111111111';
const PLAINTEXT_KEY = 'sk-ant-secret-plaintext-3akj';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  getProvider.mockReturnValue({ id: 'claude', listModels });
  encrypt.mockImplementation((plaintext: string) => `enc(${plaintext})`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('advisor provider-key routes', () => {
  // --- 1. list — status + keyHintTail only, never the plaintext --------------
  it('lists provider keys returning the hint tail but never the key material', async () => {
    listProviderKeysForUser.mockResolvedValue([
      {
        id: UUID,
        providerId: 'claude',
        defaultModel: 'claude-opus-4-7',
        keyHintTail: '3akj',
        lastUsedAt: null,
      },
    ]);
    const app = makeApp();
    const res = await app.request('/provider-keys');
    expect(res.status).toBe(200);
    const text = await res.text();
    // The wire payload must not contain plaintext or ciphertext anywhere.
    expect(text).not.toContain(PLAINTEXT_KEY);
    expect(text).not.toContain('encryptedKey');
    const body = JSON.parse(text);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].keyHintTail).toBe('3akj');
    expect(body.items[0].providerId).toBe('claude');
  });

  // --- 2. save — listModels success → verified: true, encrypts before store --
  it('encrypts and stores a key, returning verified:true on a successful probe', async () => {
    listModels.mockResolvedValue([{ id: 'claude-opus-4-7' }]);
    upsertProviderKey.mockResolvedValue({
      id: UUID,
      providerId: 'claude',
      defaultModel: 'claude-opus-4-7',
      keyHintTail: '3akj',
      lastUsedAt: null,
    });
    const app = makeApp();
    const res = await app.request('/provider-keys/claude', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: PLAINTEXT_KEY, defaultModel: 'claude-opus-4-7' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.keyHintTail).toBe('3akj');
    // Plaintext is encrypted, never stored raw; hint tail = last 4 chars.
    expect(encrypt).toHaveBeenCalledWith(PLAINTEXT_KEY);
    expect(upsertProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        providerId: 'claude',
        encryptedKey: `enc(${PLAINTEXT_KEY})`,
        keyHintTail: '3akj',
        defaultModel: 'claude-opus-4-7',
      }),
    );
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_KEY);
  });

  // --- 3. save — listModels 401 → PROVIDER_KEY_INVALID, NOT stored -----------
  it('returns 400 PROVIDER_KEY_INVALID and does not store when the probe is 401', async () => {
    listModels.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const app = makeApp();
    const res = await app.request('/provider-keys/claude', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: PLAINTEXT_KEY, defaultModel: 'claude-opus-4-7' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('PROVIDER_KEY_INVALID');
    expect(upsertProviderKey).not.toHaveBeenCalled();
  });

  // --- 4. save — listModels timeout → verified: false, stored anyway ---------
  it('saves the key with verified:false when the validation probe times out', async () => {
    vi.useFakeTimers();
    // listModels never resolves within the 5s window → timeout path.
    listModels.mockReturnValue(new Promise(() => {}));
    upsertProviderKey.mockResolvedValue({
      id: UUID,
      providerId: 'claude',
      defaultModel: 'claude-opus-4-7',
      keyHintTail: '3akj',
      lastUsedAt: null,
    });
    const app = makeApp();
    const reqPromise = app.request('/provider-keys/claude', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: PLAINTEXT_KEY, defaultModel: 'claude-opus-4-7' }),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await reqPromise;
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(false);
    expect(upsertProviderKey).toHaveBeenCalledTimes(1);
  });

  // --- 5. save without defaultModel → REQ-6.4 server-side selection ----------
  it('picks the deterministic default model when the body omits defaultModel', async () => {
    listModels.mockResolvedValue([
      { id: 'claude-sonnet-4-6', displayName: 'x', contextWindow: 200_000, vision: true },
      { id: 'claude-opus-4-8-20260210', displayName: 'x', contextWindow: 200_000, vision: true },
    ]);
    upsertProviderKey.mockResolvedValue({
      id: UUID,
      providerId: 'claude',
      defaultModel: 'claude-opus-4-8-20260210',
      keyHintTail: '3akj',
      lastUsedAt: null,
    });
    const app = makeApp();
    const res = await app.request('/provider-keys/claude', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: PLAINTEXT_KEY }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).defaultModel).toBe('claude-opus-4-8-20260210');
    expect(upsertProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-opus-4-8-20260210' }),
    );
  });

  it('falls back to the nominal default model when omitted and the probe times out', async () => {
    vi.useFakeTimers();
    listModels.mockReturnValue(new Promise(() => {}));
    upsertProviderKey.mockResolvedValue({
      id: UUID,
      providerId: 'claude',
      defaultModel: 'claude-opus-4-8',
      keyHintTail: '3akj',
      lastUsedAt: null,
    });
    const app = makeApp();
    const reqPromise = app.request('/provider-keys/claude', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: PLAINTEXT_KEY }),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await reqPromise;
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(false);
    expect(upsertProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-opus-4-8' }),
    );
  });

  // --- 6. patch — model-only update, no key material, no probe ---------------
  it('changes only the default model via PATCH without touching the key', async () => {
    updateProviderKeyDefaultModel.mockResolvedValue({
      id: UUID,
      providerId: 'claude',
      defaultModel: 'claude-sonnet-4-6',
      keyHintTail: '3akj',
      lastUsedAt: null,
    });
    const app = makeApp();
    const res = await app.request('/provider-keys/claude', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaultModel).toBe('claude-sonnet-4-6');
    expect(body.verified).toBeUndefined();
    expect(updateProviderKeyDefaultModel).toHaveBeenCalledWith({
      userId: 'user-1',
      providerId: 'claude',
      defaultModel: 'claude-sonnet-4-6',
    });
    // Key material untouched: no probe, no encryption, no upsert.
    expect(listModels).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(upsertProviderKey).not.toHaveBeenCalled();
  });

  it('rejects a PATCH with an empty model (400) and 404s when no key exists', async () => {
    const app = makeApp();
    const invalid = await app.request('/provider-keys/claude', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: '' }),
    });
    expect(invalid.status).toBe(400);
    expect(updateProviderKeyDefaultModel).not.toHaveBeenCalled();

    const { NotFoundError } = await import('@/lib/errors');
    updateProviderKeyDefaultModel.mockRejectedValueOnce(new NotFoundError('ProviderKey', 'openai'));
    const missing = await app.request('/provider-keys/openai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'gpt-4o' }),
    });
    expect(missing.status).toBe(404);
  });

  // --- 7. delete — 204 on success, 404 when no key for the provider ----------
  it('deletes a provider key (204) and returns 404 when none is configured', async () => {
    deleteProviderKey.mockResolvedValueOnce(undefined);
    const app = makeApp();
    const ok = await app.request('/provider-keys/claude', { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(deleteProviderKey).toHaveBeenCalledWith({ userId: 'user-1', providerId: 'claude' });

    const { NotFoundError } = await import('@/lib/errors');
    deleteProviderKey.mockRejectedValueOnce(new NotFoundError('ProviderKey', 'openai'));
    const missing = await app.request('/provider-keys/openai', { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });
});
