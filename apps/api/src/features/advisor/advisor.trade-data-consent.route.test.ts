// Trade-data-consent route + handler integration tests, plus the per-iteration
// re-read helper (Task 23; design §Component 1/3, REQ-9.1, REQ-1.7). Covers:
//   1. GET  /trade-data-consent → { consent } reflects the stored flag.
//   2. GET  defaults to { consent: false } for a never-set user.
//   3. PUT  /trade-data-consent → persists the flag, echoes it back.
//   4. PUT  with a missing/non-boolean body → 400 validation error.
//   5. reReadAdvisorIterationState → fresh { consent, hasUwKey, uwKeyCiphertext }
//      (ciphertext returned, not just a boolean; hasUwKey derived from it).
//
// The query helpers are mocked at the module boundary so these are deterministic
// handler-level tests of the HTTP shape and the re-read helper's wiring.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/middleware/error.middleware';

// --- Module mocks ------------------------------------------------------------

const getTradeDataConsent = vi.fn();
const setTradeDataConsent = vi.fn();
const selectUnusualWhalesKeyCiphertext = vi.fn();

vi.mock('@/db', () => ({ db: {} }));
vi.mock('./external-keys.query', () => ({
  getTradeDataConsent: (...a: unknown[]) => getTradeDataConsent(...a),
  setTradeDataConsent: (...a: unknown[]) => setTradeDataConsent(...a),
  selectUnusualWhalesKeyCiphertext: (...a: unknown[]) => selectUnusualWhalesKeyCiphertext(...a),
}));

import {
  getTradeDataConsentHandler,
  reReadAdvisorIterationState,
  setTradeDataConsentHandler,
} from './external-keys.handler';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', 'user-1');
    c.set('isAdmin', false);
    await next();
  });
  app.get('/trade-data-consent', getTradeDataConsentHandler);
  app.put('/trade-data-consent', setTradeDataConsentHandler);
  app.onError(errorHandler);
  return app;
}

function putConsent(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.request('/trade-data-consent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('advisor trade-data-consent routes', () => {
  // --- 1. get — reflects the stored flag -------------------------------------
  it('returns the stored consent flag', async () => {
    getTradeDataConsent.mockResolvedValue(true);
    const app = makeApp();
    const res = await app.request('/trade-data-consent');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: true });
    expect(getTradeDataConsent).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });

  // --- 2. get — defaults to false --------------------------------------------
  it('reports consent:false for a user who has never set it', async () => {
    getTradeDataConsent.mockResolvedValue(false);
    const app = makeApp();
    const res = await app.request('/trade-data-consent');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: false });
  });

  // --- 3. put — persists and echoes ------------------------------------------
  it('persists the consent flag and echoes it back', async () => {
    setTradeDataConsent.mockResolvedValue(undefined);
    const app = makeApp();

    const on = await putConsent(app, { consent: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ consent: true });
    expect(setTradeDataConsent).toHaveBeenCalledWith(expect.anything(), 'user-1', true);

    const off = await putConsent(app, { consent: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ consent: false });
    expect(setTradeDataConsent).toHaveBeenLastCalledWith(expect.anything(), 'user-1', false);
  });

  // --- 4. put — validation ----------------------------------------------------
  it('rejects a missing or non-boolean consent with 400', async () => {
    const app = makeApp();

    const missing = await putConsent(app, {});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('VALIDATION_ERROR');

    const wrongType = await putConsent(app, { consent: 'yes' });
    expect(wrongType.status).toBe(400);
    expect(setTradeDataConsent).not.toHaveBeenCalled();
  });
});

describe('reReadAdvisorIterationState (REQ-1.7 per-iteration re-read)', () => {
  it('returns fresh consent + ciphertext, deriving hasUwKey when a key exists', async () => {
    getTradeDataConsent.mockResolvedValue(true);
    selectUnusualWhalesKeyCiphertext.mockResolvedValue({ encryptedKey: 'enc-abc', keyVersion: 2 });

    const state = await reReadAdvisorIterationState('user-1');

    expect(state).toEqual({
      consent: true,
      hasUwKey: true,
      uwKeyCiphertext: { encryptedKey: 'enc-abc', keyVersion: 2 },
    });
    expect(getTradeDataConsent).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(selectUnusualWhalesKeyCiphertext).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });

  it('reports hasUwKey:false and null ciphertext when no key is stored', async () => {
    getTradeDataConsent.mockResolvedValue(false);
    selectUnusualWhalesKeyCiphertext.mockResolvedValue(null);

    const state = await reReadAdvisorIterationState('user-1');

    expect(state).toEqual({ consent: false, hasUwKey: false, uwKeyCiphertext: null });
  });
});
