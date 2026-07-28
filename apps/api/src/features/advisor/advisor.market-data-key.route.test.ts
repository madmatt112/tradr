// Market-data-key (Unusual Whales BYOK) route + handler integration tests
// (Task 9; design §Component 5, REQ-6.2/6.3/6.6, REQ-15.5). Covers:
//   1. PUT save → probe success → verified:true (encrypts before store).
//   2. GET masked → { configured, keyHintTail, verified } only (no key material).
//   3. PUT replace → upserts again (last-4 hint follows the new key).
//   4. PUT save → probe 401 (MARKET_DATA_KEY_INVALID) → 400, code AND bucket,
//      NOT stored.
//   5. PUT save → transient probe failure (MARKET_DATA_UNAVAILABLE) →
//      verified:false, stored anyway.
//   6. DELETE → 204 on delete; 404 when no key configured.
//   7. PUT rate limit → 11th save in the window → 429.
//
// The query helpers, the encryption util, and the UW client are mocked at the
// module boundary so these are deterministic handler-level tests of the HTTP
// shape, the no-plaintext rule, and the verification probe.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/middleware/error.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

// --- Module mocks ------------------------------------------------------------

const upsertUnusualWhalesKey = vi.fn();
const selectUnusualWhalesKeyMasked = vi.fn();
const deleteUnusualWhalesKey = vi.fn();

const getStockQuote = vi.fn();
const createUnusualWhalesClient = vi.fn<(deps: unknown) => { getStockQuote: typeof getStockQuote }>(
  () => ({ getStockQuote }),
);
const encrypt = vi.fn((plaintext: string) => `enc(${plaintext})`);

vi.mock('@/db', () => ({ db: {} }));
vi.mock('./external-keys.query', () => ({
  upsertUnusualWhalesKey: (...a: unknown[]) => upsertUnusualWhalesKey(...a),
  selectUnusualWhalesKeyMasked: (...a: unknown[]) => selectUnusualWhalesKeyMasked(...a),
  deleteUnusualWhalesKey: (...a: unknown[]) => deleteUnusualWhalesKey(...a),
}));
vi.mock('@/lib/encryption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
  return { ...actual, encrypt: (plaintext: string) => encrypt(plaintext) };
});
vi.mock('./lib/unusual-whales.client', async () => {
  const actual = await vi.importActual<typeof import('./lib/unusual-whales.client')>(
    './lib/unusual-whales.client',
  );
  return {
    ...actual,
    createUnusualWhalesClient: (deps: unknown) => createUnusualWhalesClient(deps),
  };
});

import {
  deleteMarketDataKeyHandler,
  getMarketDataKeyHandler,
  saveMarketDataKeyHandler,
} from './external-keys.handler';
import { MarketDataError } from './lib/unusual-whales.client';
import { bucketOf, TOOL_RESULT_CODES } from './tools/error-codes';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', 'user-1');
    c.set('isAdmin', false);
    await next();
  });
  app.get('/market-data-key', getMarketDataKeyHandler);
  app.put(
    '/market-data-key',
    createRateLimiter({
      name: 'market-data-keys',
      max: 10,
      windowMs: 60_000,
      keyGenerator: (c) => c.get('userId'),
    }),
    saveMarketDataKeyHandler,
  );
  app.delete('/market-data-key', deleteMarketDataKeyHandler);
  app.onError(errorHandler);
  return app;
}

const PLAINTEXT_KEY = 'uw-secret-plaintext-7yz9';

function putKey(app: ReturnType<typeof makeApp>, apiKey = PLAINTEXT_KEY) {
  return app.request('/market-data-key', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createUnusualWhalesClient.mockReturnValue({ getStockQuote });
  encrypt.mockImplementation((plaintext: string) => `enc(${plaintext})`);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('advisor market-data-key routes', () => {
  // --- 1. save — probe success → verified:true, encrypts before store --------
  it('encrypts and stores the key, returning verified:true on a successful probe', async () => {
    getStockQuote.mockResolvedValue({ data: { ticker: 'AAPL' } });
    upsertUnusualWhalesKey.mockResolvedValue(undefined);

    const app = makeApp();
    const res = await putKey(app);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: true, keyHintTail: '7yz9', verified: true });
    expect(encrypt).toHaveBeenCalledWith(PLAINTEXT_KEY);
    expect(upsertUnusualWhalesKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        encryptedKey: `enc(${PLAINTEXT_KEY})`,
        keyHintTail: '7yz9',
        verified: true,
      }),
    );
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_KEY);
  });

  // --- 2. get — masked status only, never the key material -------------------
  it('returns the masked status (hint tail + verified) but never the key material', async () => {
    selectUnusualWhalesKeyMasked.mockResolvedValue({
      configured: true,
      keyHintTail: '7yz9',
      verified: true,
    });
    const app = makeApp();
    const res = await app.request('/market-data-key');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLAINTEXT_KEY);
    expect(text).not.toContain('encryptedKey');
    expect(JSON.parse(text)).toEqual({ configured: true, keyHintTail: '7yz9', verified: true });
  });

  it('reports configured:false when no market-data key is stored', async () => {
    selectUnusualWhalesKeyMasked.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/market-data-key');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  // --- 3. replace — upserts again, hint tail follows the new key -------------
  it('replaces an existing key (upsert) with the new last-4 hint', async () => {
    getStockQuote.mockResolvedValue({ data: { ticker: 'AAPL' } });
    upsertUnusualWhalesKey.mockResolvedValue(undefined);

    const app = makeApp();
    const res = await putKey(app, 'uw-other-secret-abcd');
    expect(res.status).toBe(200);
    expect((await res.json()).keyHintTail).toBe('abcd');
    expect(upsertUnusualWhalesKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyHintTail: 'abcd', encryptedKey: 'enc(uw-other-secret-abcd)' }),
    );
  });

  // --- 4. save — probe 401 → MARKET_DATA_KEY_INVALID (code + bucket), not stored
  it('returns 400 MARKET_DATA_KEY_INVALID (tool_result bucket) and does not store on a 401 probe', async () => {
    getStockQuote.mockRejectedValue(
      new MarketDataError(TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID, 'rejected'),
    );
    const app = makeApp();
    const res = await putKey(app);

    expect(res.status).toBe(400);
    const code = (await res.json()).error.code;
    expect(code).toBe('MARKET_DATA_KEY_INVALID');
    // REQ-15.5: the surfaced code belongs to the continue (tool_result) bucket.
    expect(bucketOf(code)).toBe('tool_result');
    expect(upsertUnusualWhalesKey).not.toHaveBeenCalled();
  });

  // --- 5. save — transient probe failure → verified:false, stored anyway -----
  it('stores the key with verified:false on a transient probe failure', async () => {
    getStockQuote.mockRejectedValue(
      new MarketDataError(TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE, 'down'),
    );
    upsertUnusualWhalesKey.mockResolvedValue(undefined);

    const app = makeApp();
    const res = await putKey(app);

    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(false);
    expect(upsertUnusualWhalesKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ verified: false }),
    );
  });

  // --- 6. delete — 204 on success, 404 when no key configured ----------------
  it('deletes the key (204) and returns 404 when none is configured', async () => {
    deleteUnusualWhalesKey.mockResolvedValueOnce(true);
    const app = makeApp();
    const ok = await app.request('/market-data-key', { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(deleteUnusualWhalesKey).toHaveBeenCalledWith(expect.anything(), 'user-1');

    deleteUnusualWhalesKey.mockResolvedValueOnce(false);
    const missing = await app.request('/market-data-key', { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });

  // --- 7. rate limit — 11th save in the window → 429 -------------------------
  it('rate limits saves to 10 per window (11th → 429)', async () => {
    getStockQuote.mockResolvedValue({ data: { ticker: 'AAPL' } });
    upsertUnusualWhalesKey.mockResolvedValue(undefined);
    const app = makeApp();

    for (let i = 0; i < 10; i++) {
      const res = await putKey(app);
      expect(res.status).toBe(200);
    }
    const limited = await putKey(app);
    expect(limited.status).toBe(429);
  });
});
