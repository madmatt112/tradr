import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { POSITION_IMAGE_MAX_BYTES, POSITION_IMAGE_MAX_COUNT } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';
import { stripImageMetadata } from '@/lib/image-metadata';

// --- Harness (own copies of positions.tags.test.ts:20-92) -------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `posimg-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.98.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
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
  expect(cookie).toBeDefined();
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

async function createTestAccount(cookie: string, name = 'Test Account') {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name,
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

async function newPosition(): Promise<{ cookie: string; positionId: string }> {
  const { cookie } = await registerAndGetCookie();
  const account = await createTestAccount(cookie);
  const position = await createTestPosition(cookie, account.id);
  return { cookie, positionId: position.id };
}

// --- Image fixtures (hand-built containers, no image library) -----------------
// Reproduced from image-metadata.test.ts:27-71 (its builders are not exported).

const EXIF_MARKER = Buffer.from('Exif\x00\x00', 'latin1');

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  const head = Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Minimal JPEG carrying an APP1 EXIF segment (SOI, APP1(Exif), DQT, SOS, EOI). */
function buildJpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app1 = jpegSegment(
    0xe1,
    Buffer.concat([
      EXIF_MARKER,
      Buffer.from('GPS_FIXTURE_LAT', 'latin1'),
      Buffer.from('II*\x00rest', 'latin1'),
    ]),
  );
  const dqt = jpegSegment(0xdb, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]),
    Buffer.from([0xde, 0xad]),
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, dqt, sos, eoi]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([0, 0, 0, 0])]);
}

/** Minimal clean PNG (sig, IHDR, IDAT, IEND). */
function buildPng(): Buffer {
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk('IDAT', Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
}

function uploadImage(cookie: string, positionId: string, format: string, bytes: Buffer) {
  return authedRequest('POST', `/api/positions/${positionId}/images`, cookie, {
    format,
    dataBase64: bytes.toString('base64'),
  });
}

// --- Tests (storage unconfigured — inline base64 path) ------------------------

describe('position images route (storage unconfigured)', () => {
  it('POST returns a 201 record with only id, format and createdAt', async () => {
    const { cookie, positionId } = await newPosition();
    const res = await uploadImage(cookie, positionId, 'png', buildPng());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'format', 'id']);
    expect(body.format).toBe('png');
    expect(typeof body.id).toBe('string');
    expect(typeof body.createdAt).toBe('string');
  });

  it('detail carries the images without a stored key or unavailable flag', async () => {
    const { cookie, positionId } = await newPosition();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await uploadImage(cookie, positionId, 'png', buildPng());
      expect(res.status).toBe(201);
      ids.push((await res.json()).id);
    }
    const detail = await (
      await authedRequest('GET', `/api/positions/${positionId}`, cookie)
    ).json();
    expect(detail.images).toHaveLength(3);
    expect(new Set(detail.images.map((im: { id: string }) => im.id))).toEqual(new Set(ids));
    for (const im of detail.images) {
      expect(Object.keys(im).sort()).toEqual(['createdAt', 'format', 'id']);
    }
  });

  it('GET round-trips the bytes with Content-Type and Cache-Control', async () => {
    const { cookie, positionId } = await newPosition();
    const png = buildPng();
    const { id } = await (await uploadImage(cookie, positionId, 'png', png)).json();

    const res = await authedRequest('GET', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(stripImageMetadata('png', png))).toBe(true);
  });

  it('strips container metadata: a JPEG reads back without an Exif marker', async () => {
    const { cookie, positionId } = await newPosition();
    const jpeg = buildJpegWithExif();
    expect(jpeg.includes(EXIF_MARKER)).toBe(true);
    const { id } = await (await uploadImage(cookie, positionId, 'jpeg', jpeg)).json();

    const res = await authedRequest('GET', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.includes(EXIF_MARKER)).toBe(false);
  });

  it('rejects bytes that do not match the declared format (400 IMAGE_FORMAT_MISMATCH)', async () => {
    const { cookie, positionId } = await newPosition();
    const res = await uploadImage(cookie, positionId, 'jpeg', buildPng());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('IMAGE_FORMAT_MISMATCH');
  });

  it('rejects an over-cap dataBase64 with 400 IMAGE_TOO_LARGE', async () => {
    const { cookie, positionId } = await newPosition();
    // One over the encoded cap, but the whole body stays under the route limit.
    const res = await authedRequest('POST', `/api/positions/${positionId}/images`, cookie, {
      format: 'png',
      dataBase64: 'A'.repeat(POSITION_IMAGE_MAX_BYTES + 1),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('rejects a body over the route limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const { cookie, positionId } = await newPosition();
    // Past the cap + framing margin (4,096), so bodyLimit rejects before parsing.
    const res = await authedRequest('POST', `/api/positions/${positionId}/images`, cookie, {
      format: 'png',
      dataBase64: 'A'.repeat(POSITION_IMAGE_MAX_BYTES + 5_000),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects the eleventh screenshot with 409 POSITION_IMAGE_LIMIT', async () => {
    const { cookie, positionId } = await newPosition();
    for (let i = 0; i < POSITION_IMAGE_MAX_COUNT; i++) {
      expect((await uploadImage(cookie, positionId, 'png', buildPng())).status).toBe(201);
    }
    const res = await uploadImage(cookie, positionId, 'png', buildPng());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('POSITION_IMAGE_LIMIT');
  });

  it('returns 404 to another user on GET, DELETE and POST', async () => {
    const owner = await newPosition();
    const { id } = await (
      await uploadImage(owner.cookie, owner.positionId, 'png', buildPng())
    ).json();

    const { cookie: other } = await registerAndGetCookie();
    const post = await uploadImage(other, owner.positionId, 'png', buildPng());
    expect(post.status).toBe(404);
    const get = await authedRequest(
      'GET',
      `/api/positions/${owner.positionId}/images/${id}`,
      other,
    );
    expect(get.status).toBe(404);
    const del = await authedRequest(
      'DELETE',
      `/api/positions/${owner.positionId}/images/${id}`,
      other,
    );
    expect(del.status).toBe(404);
  });

  it('DELETE returns 204 and the image then 404s', async () => {
    const { cookie, positionId } = await newPosition();
    const { id } = await (await uploadImage(cookie, positionId, 'png', buildPng())).json();

    const del = await authedRequest('DELETE', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(del.status).toBe(204);

    const get = await authedRequest('GET', `/api/positions/${positionId}/images/${id}`, cookie);
    expect(get.status).toBe(404);
  });
});
