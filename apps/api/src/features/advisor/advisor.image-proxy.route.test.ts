/**
 * Advisor image-proxy route/handler tests (hosted-platform Task 9; design
 * §Component 2, D1; REQ-2.4/12.3).
 *
 * Deterministic handler-level tests of the HTTP shape at the mocked-adapter
 * boundary (REQ-11.4): the ownership-scoped DB read (`getOwnedMessageParts`) and
 * the object store (`getObjectStorage`) are mocked so the status matrix is
 * exercised without a database. The real SQL-level ownership scoping is locked
 * in separately against Postgres in `advisor.image-proxy.query.test.ts`.
 *
 * Covered: owner inline → 200; owner pointer → 200 (key never leaks); cross-user
 * / not-owned → 404; unrecoverable → 404; out-of-range → 404; non-image → 404;
 * missing-object (NoSuchKey / httpStatusCode 404) → 404; store-down (transport
 * failure) → 503 + a §19 warn.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/error.middleware';

// --- Module mocks ------------------------------------------------------------

const getOwnedMessageParts = vi.fn();
const storageGet = vi.fn();
const getObjectStorage = vi.fn<() => { get: typeof storageGet } | null>(() => ({
  get: storageGet,
}));

vi.mock('./advisor.service', () => ({
  getOwnedMessageParts: (...a: unknown[]) => getOwnedMessageParts(...a),
}));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  return { ...actual, getObjectStorage: () => getObjectStorage() };
});

// Imported AFTER the mocks so the handler resolves the fakes.
// eslint-disable-next-line import-x/order
import { getMessageImageHandler } from './image-proxy.handler';
// eslint-disable-next-line import-x/order
import { ObjectUnreachableError } from '@/lib/object-storage';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

const CID = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';

function makeApp(userId = 'user-1') {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', userId);
    c.set('isAdmin', false);
    await next();
  });
  app.get(
    '/conversations/:conversationId/messages/:messageId/images/:index',
    getMessageImageHandler,
  );
  app.onError(errorHandler);
  return app;
}

const url = (index: number | string = 0, cid = CID, mid = MID) =>
  `/conversations/${cid}/messages/${mid}/images/${index}`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  getObjectStorage.mockReturnValue({ get: storageGet });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('advisor image-proxy route', () => {
  // --- owner, inline image → 200 with correct Content-Type + Cache-Control ----
  it('streams an inline image with image/<format> Content-Type and private cache', async () => {
    getOwnedMessageParts.mockResolvedValue([{ type: 'image', format: 'png', dataBase64: PNG_B64 }]);
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(storageGet).not.toHaveBeenCalled();
    expect(getOwnedMessageParts).toHaveBeenCalledWith({
      conversationId: CID,
      messageId: MID,
      userId: 'user-1',
    });
  });

  // --- owner, pointer image → 200; key resolved server-side, never leaked -----
  it('streams a pointer image via storage.get without leaking the key', async () => {
    getOwnedMessageParts.mockResolvedValue([
      {
        type: 'image',
        format: 'png',
        storage: { kind: 'object', key: 'advisor/user-1/secret-key' },
      },
    ]);
    storageGet.mockResolvedValue({ bytes: PNG_BYTES, contentType: 'image/webp' });
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(200);
    // Content-Type comes from the stored object, not the format hint.
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PNG_BYTES);
    expect(storageGet).toHaveBeenCalledWith('advisor/user-1/secret-key');
    // The object key never appears in any response header.
    for (const [, value] of res.headers.entries()) {
      expect(value).not.toContain('secret-key');
    }
  });

  // --- cross-user / not owned → 404 (IDOR guard) ------------------------------
  it('returns 404 when the message is not owned (null from the scoped read)', async () => {
    getOwnedMessageParts.mockResolvedValue(null);
    const res = await makeApp('attacker').request(url(0));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(storageGet).not.toHaveBeenCalled();
  });

  // --- unrecoverable marker → 404 --------------------------------------------
  it('returns 404 for an unrecoverable image part', async () => {
    getOwnedMessageParts.mockResolvedValue([
      { type: 'image', format: 'jpeg', storage: { kind: 'unrecoverable' } },
    ]);
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(404);
    expect(storageGet).not.toHaveBeenCalled();
  });

  // --- index out of range → 404 ----------------------------------------------
  it('returns 404 when the index is out of range', async () => {
    getOwnedMessageParts.mockResolvedValue([{ type: 'text', text: 'hi' }]);
    const res = await makeApp().request(url(5));
    expect(res.status).toBe(404);
  });

  // --- non-image part → 404 ---------------------------------------------------
  it('returns 404 when the indexed part is not an image', async () => {
    getOwnedMessageParts.mockResolvedValue([{ type: 'text', text: 'hi' }]);
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(404);
    expect(storageGet).not.toHaveBeenCalled();
  });

  // --- negative / non-numeric index → 404 ------------------------------------
  it('returns 404 for a non-numeric index without touching the DB', async () => {
    const res = await makeApp().request(url('abc'));
    expect(res.status).toBe(404);
    expect(getOwnedMessageParts).not.toHaveBeenCalled();
  });

  // --- missing object (NoSuchKey) → 404 (discrimination) ----------------------
  it('returns 404 when the pointer object is genuinely gone (NoSuchKey cause)', async () => {
    getOwnedMessageParts.mockResolvedValue([
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/user-1/gone' } },
    ]);
    const noSuchKey = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    storageGet.mockRejectedValue(new ObjectUnreachableError('gone', noSuchKey));
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when the cause carries only httpStatusCode 404', async () => {
    getOwnedMessageParts.mockResolvedValue([
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/user-1/gone' } },
    ]);
    const gone = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
    storageGet.mockRejectedValue(new ObjectUnreachableError('gone', gone));
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(404);
  });

  // --- store-down (transport failure) → 503 + a §19 warn (discrimination) -----
  it('returns 503 + a warn when the store is genuinely unreachable (transport failure)', async () => {
    getOwnedMessageParts.mockResolvedValue([
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/user-1/k' } },
    ]);
    const warnSpy = vi.spyOn(logger, 'warn');
    const transport = Object.assign(new Error('connection reset'), { name: 'TimeoutError' });
    storageGet.mockRejectedValue(new ObjectUnreachableError('unreachable', transport));
    const res = await makeApp().request(url(0));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('OBJECT_UNREACHABLE');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'object-store-unreachable' }),
    );
  });
});
