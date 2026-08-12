// Options-chain viewer endpoint tests (Task 35; design §Component 12,
// REQ-12.2/12.3/12.4). Covers:
//   1. No key configured → { configured: false } (empty state, NOT an error).
//   2. Key present + success → { configured: true, chain } from the shared
//      parseOptionChain projection; passes the symbol/expiration through.
//   3. Bad symbol → 400 validation error (shares optionsChainInputSchema).
//   4. UW 401/403 → 400 MARKET_DATA_KEY_INVALID.
//   5. UW 429 → 429 MARKET_DATA_RATE_LIMITED.
//   6. UW 404/empty → 404 SYMBOL_NOT_FOUND.
//   7. UW 5xx/timeout → 503 MARKET_DATA_UNAVAILABLE.
//   8. Platform meter trip → 429 PLATFORM_RATE_LIMITED.
//
// The key query + the UW client constructor are mocked at the module boundary so
// these are deterministic handler-level tests of the HTTP shape and failure map.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/middleware/error.middleware';

// --- Module mocks ------------------------------------------------------------

const selectUnusualWhalesKeyCiphertext = vi.fn();
const getExpiryBreakdown = vi.fn();
const getOptionContracts = vi.fn();
const createUnusualWhalesClient = vi.fn(() => ({ getExpiryBreakdown, getOptionContracts }));

vi.mock('@/db', () => ({ db: {} }));
vi.mock('./external-keys.query', () => ({
  selectUnusualWhalesKeyCiphertext: (...a: unknown[]) => selectUnusualWhalesKeyCiphertext(...a),
}));
vi.mock('@/lib/encryption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
  return { ...actual, decrypt: (envelope: string) => envelope.replace(/^enc\(|\)$/g, '') };
});
vi.mock('./lib/unusual-whales.client', async () => {
  const actual = await vi.importActual<typeof import('./lib/unusual-whales.client')>(
    './lib/unusual-whales.client',
  );
  return {
    ...actual,
    createUnusualWhalesClient: () => createUnusualWhalesClient(),
  };
});

import { MarketDataError, PlatformRateLimitedError } from './lib/unusual-whales.client';
import { getOptionsChainHandler } from './options-chain.handler';
import { bucketOf, TOOL_RESULT_CODES } from './tools/error-codes';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', 'user-1');
    c.set('isAdmin', false);
    await next();
  });
  app.get('/options-chain', getOptionsChainHandler);
  app.onError(errorHandler);
  return app;
}

function get(app: ReturnType<typeof makeApp>, query: string) {
  return app.request(`/options-chain${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  createUnusualWhalesClient.mockReturnValue({ getExpiryBreakdown, getOptionContracts });
  getExpiryBreakdown.mockResolvedValue({ data: [{ expires: '2030-06-21' }] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('advisor options-chain route', () => {
  // --- 1. no key → empty state (REQ-12.2) ------------------------------------
  it('returns { configured: false } when no Unusual Whales key is stored', async () => {
    selectUnusualWhalesKeyCiphertext.mockResolvedValue(null);
    const app = makeApp();
    const res = await get(app, '?symbol=AAPL');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
    expect(getOptionContracts).not.toHaveBeenCalled();
  });

  // --- 2. key + success → parsed chain (REQ-12.4) ----------------------------
  it('returns the parsed chain from the shared projection on success', async () => {
    selectUnusualWhalesKeyCiphertext.mockResolvedValue({ encryptedKey: 'enc(k)', keyVersion: 1 });
    getExpiryBreakdown.mockResolvedValue({ data: [{ expires: '2030-06-21' }] });
    // An `option-contracts` row: no strike/type/expiry fields, prices as
    // decimal strings. The projection decodes the OCC symbol and numifies.
    getOptionContracts.mockResolvedValue({
      data: [
        {
          option_symbol: 'AAPL300621C00150000',
          last_price: '3.2',
          nbbo_bid: '3.1',
          nbbo_ask: '3.3',
          volume: 100,
          open_interest: 2000,
          extra_field_dropped: 'x',
        },
      ],
    });

    const app = makeApp();
    const res = await get(app, '?symbol=AAPL&expiration=2030-06-21');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.chain.symbol).toBe('AAPL');
    expect(body.expiration).toBe('2030-06-21');
    expect(body.chain.count).toBe(1);
    expect(body.chain.contracts[0]).toMatchObject({
      strike: 150,
      option_type: 'call',
      expiry: '2030-06-21',
      bid: 3.1,
      ask: 3.3,
      last_price: 3.2,
      premium: 3.2,
    });
    // Compact projection drops unknown fields.
    expect(body.chain.contracts[0].extra_field_dropped).toBeUndefined();
    expect(getOptionContracts).toHaveBeenCalledWith('AAPL', '2030-06-21', undefined);
  });

  // --- 2b. expiry resolution + picker payload --------------------------------
  it('defaults to the nearest expiry and returns the list for the picker', async () => {
    selectUnusualWhalesKeyCiphertext.mockResolvedValue({ encryptedKey: 'enc(k)', keyVersion: 1 });
    getExpiryBreakdown.mockResolvedValue({
      data: [{ expires: '2030-09-20' }, { expires: '2030-06-21' }],
    });
    getOptionContracts.mockResolvedValue({ data: [{ option_symbol: 'AAPL300621C00150000' }] });

    const app = makeApp();
    const res = await get(app, '?symbol=AAPL');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expiration).toBe('2030-06-21');
    expect(body.expirations).toEqual(['2030-06-21', '2030-09-20']);
    expect(getOptionContracts).toHaveBeenCalledWith('AAPL', '2030-06-21', undefined);
  });

  // The bug this guards: `option-chains?date=` is a MARKET day, not an expiry,
  // so a future expiry there returned an empty envelope and surfaced as a bare
  // "Symbol not found." for a symbol that plainly exists.
  it('reports an unavailable expiry without calling the contracts endpoint', async () => {
    selectUnusualWhalesKeyCiphertext.mockResolvedValue({ encryptedKey: 'enc(k)', keyVersion: 1 });
    getExpiryBreakdown.mockResolvedValue({ data: [{ expires: '2030-06-21' }] });

    const app = makeApp();
    const res = await get(app, '?symbol=AAPL&expiration=2030-06-22');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('SYMBOL_NOT_FOUND');
    expect(body.error.message).toContain('expire on that date');
    expect(getOptionContracts).not.toHaveBeenCalled();
  });

  // --- 3. bad symbol → 400 validation ----------------------------------------
  it('returns 400 on an invalid symbol (shared input schema)', async () => {
    const app = makeApp();
    const res = await get(app, '?symbol=not-a-symbol');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(selectUnusualWhalesKeyCiphertext).not.toHaveBeenCalled();
  });

  // --- 4-7. UW failure mapping (REQ-12.3) ------------------------------------
  it.each([
    [TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID, 400],
    [TOOL_RESULT_CODES.MARKET_DATA_RATE_LIMITED, 429],
    [TOOL_RESULT_CODES.SYMBOL_NOT_FOUND, 404],
    [TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE, 503],
  ])('maps UW %s to HTTP %i', async (code, status) => {
    selectUnusualWhalesKeyCiphertext.mockResolvedValue({ encryptedKey: 'enc(k)', keyVersion: 1 });
    getOptionContracts.mockRejectedValue(new MarketDataError(code, 'msg'));
    const app = makeApp();
    const res = await get(app, '?symbol=AAPL');
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error.code).toBe(code);
    // REQ-15.5: every surfaced UW code stays in the tool_result bucket.
    expect(bucketOf(body.error.code)).toBe('tool_result');
  });

  // --- 8. platform meter trip → 429 PLATFORM_RATE_LIMITED --------------------
  it('maps a platform meter trip to 429 PLATFORM_RATE_LIMITED', async () => {
    selectUnusualWhalesKeyCiphertext.mockResolvedValue({ encryptedKey: 'enc(k)', keyVersion: 1 });
    getOptionContracts.mockRejectedValue(new PlatformRateLimitedError());
    const app = makeApp();
    const res = await get(app, '?symbol=AAPL');
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('PLATFORM_RATE_LIMITED');
  });
});
