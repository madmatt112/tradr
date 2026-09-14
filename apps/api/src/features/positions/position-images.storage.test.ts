import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { positionImages, users } from '@/db/schema';
import { ObjectUnreachableError, type ObjectStorage } from '@/lib/object-storage';

// Hold the fake bucket in a hoisted ref so the vi.mock factory (below) reads the
// instance the current test installs. `getObjectStorage` is swapped for a getter
// that returns it; everything else in the module stays real (D19 helpers, the
// key builder, the error class).
const bucket = vi.hoisted(() => ({ current: null as ObjectStorage | null }));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  return { ...actual, getObjectStorage: () => bucket.current };
});

// --- Controllable in-memory bucket (storage-maintenance.integration.test.ts:76-109) ---

class FakeStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string; lastModified: Date }>();
  deleted: string[] = [];

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType, lastModified: new Date() });
    return Promise.resolve();
  }

  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const o = this.objects.get(key);
    // A plain miss folds into a causeless ObjectUnreachableError, which the
    // discriminator reads as 503; the gone-404 case overrides `get` explicitly.
    if (!o) throw new ObjectUnreachableError(`gone: ${key}`);
    return Promise.resolve({ bytes: o.bytes, contentType: o.contentType });
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, lastModified: o.lastModified })),
    );
  }
}

let fake: FakeStorage;
beforeEach(() => {
  fake = new FakeStorage();
  bucket.current = fake;
});

// --- Harness (own copies of positions.tags.test.ts:20-92) --------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `posimgstore-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.99.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string; userId: string }> {
  const email = uniqueEmail();
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { cookie, userId: user.id };
}

function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = {
    Cookie: `session=${cookie}`,
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createTestAccount(cookie: string) {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: 'Test Account',
    currency: 'USD',
    timezone: 'UTC',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestPosition(cookie: string, accountId: string) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function newPosition(): Promise<{ cookie: string; userId: string; positionId: string }> {
  const { cookie, userId } = await registerAndGetCookie();
  const account = await createTestAccount(cookie);
  const position = await createTestPosition(cookie, account.id);
  return { cookie, userId, positionId: position.id };
}

// --- Image fixture ------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([0, 0, 0, 0])]);
}

function buildPng(): Buffer {
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk('IDAT', Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
}

function uploadImage(cookie: string, positionId: string) {
  return authedRequest('POST', `/api/positions/${positionId}/images`, cookie, {
    format: 'png',
    dataBase64: buildPng().toString('base64'),
  });
}

// --- Tests (object storage configured — pointer path) -------------------------

describe('position images route (object storage configured)', () => {
  it('puts the bytes and persists a pointer (put before insert)', async () => {
    const { cookie, userId, positionId } = await newPosition();
    const res = await uploadImage(cookie, positionId);
    expect(res.status).toBe(201);

    expect(fake.objects.size).toBe(1);
    const [key] = [...fake.objects.keys()];
    expect(key.startsWith(`positions/${userId}/`)).toBe(true);

    const rows = await db
      .select()
      .from(positionImages)
      .where(eq(positionImages.positionId, positionId));
    expect(rows).toHaveLength(1);
    const part = rows[0].part as { storage: { kind: string; key: string } };
    expect(part.storage.kind).toBe('object');
    expect(part.storage.key).toBe(key);
  });

  it('put failure returns 503 and writes no row', async () => {
    const { cookie, positionId } = await newPosition();
    fake.put = vi.fn().mockRejectedValue(new ObjectUnreachableError('store down'));

    const res = await uploadImage(cookie, positionId);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('OBJECT_UNREACHABLE');

    const rows = await db
      .select()
      .from(positionImages)
      .where(eq(positionImages.positionId, positionId));
    expect(rows).toHaveLength(0);
  });

  it('never returns the object-storage key in any response', async () => {
    const { cookie, positionId } = await newPosition();
    const created = await (await uploadImage(cookie, positionId)).json();
    const [key] = [...fake.objects.keys()];

    expect(JSON.stringify(created)).not.toContain(key);
    const detail = await (
      await authedRequest('GET', `/api/positions/${positionId}`, cookie)
    ).json();
    expect(JSON.stringify(detail)).not.toContain(key);
  });

  it('DELETE removes the object from the bucket after commit', async () => {
    const { cookie, positionId } = await newPosition();
    const { id } = await (await uploadImage(cookie, positionId)).json();
    const [key] = [...fake.objects.keys()];

    const del = await authedRequest('DELETE', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(del.status).toBe(204);
    expect(fake.deleted).toContain(key);
    expect(fake.objects.has(key)).toBe(false);
  });

  it('deleting the position deletes its collected keys from the bucket after commit', async () => {
    const { cookie, positionId } = await newPosition();
    await (await uploadImage(cookie, positionId)).json();
    await (await uploadImage(cookie, positionId)).json();
    const keys = [...fake.objects.keys()];
    expect(keys).toHaveLength(2);

    const del = await authedRequest('DELETE', `/api/positions/${positionId}`, cookie);
    expect(del.status).toBe(204);

    for (const key of keys) {
      expect(fake.deleted).toContain(key);
      expect(fake.objects.has(key)).toBe(false);
    }
  });

  it('serves 404 when the pointer object is genuinely gone (NoSuchKey cause)', async () => {
    const { cookie, positionId } = await newPosition();
    const { id } = await (await uploadImage(cookie, positionId)).json();

    const noSuchKey = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    fake.get = vi.fn().mockRejectedValue(new ObjectUnreachableError('gone', noSuchKey));

    const res = await authedRequest('GET', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('serves 503 when the store is unreachable (causeless failure)', async () => {
    const { cookie, positionId } = await newPosition();
    const { id } = await (await uploadImage(cookie, positionId)).json();

    fake.get = vi.fn().mockRejectedValue(new ObjectUnreachableError('store down'));

    const res = await authedRequest('GET', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('OBJECT_UNREACHABLE');
  });
});
