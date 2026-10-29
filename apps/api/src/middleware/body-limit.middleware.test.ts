import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import {
  GLOBAL_BODY_LIMIT_BYTES,
  BODY_LIMIT_EXEMPT_ROUTES,
  globalBodyLimitMiddleware,
} from './body-limit.middleware';

/**
 * Contract block — one row per success criterion from tasks.md task 1.
 *
 * | # | Pre-condition | Call (through the seam) | Observable result | Expected-value source |
 * |---|---|---|---|---|
 * | 1 | none | import `GLOBAL_BODY_LIMIT_BYTES` | `=== 1_048_576` | Requirement 1.8 |
 * | 2 | non-exempt path, body = 1,048,576 bytes, Content-Length set | `app.request('/api/tags', { method: 'POST', body, headers })` | 200, handler received 1,048,576 bytes | Requirement 1.1 |
 * | 3 | non-exempt path, body = 1,048,577 bytes, Content-Length set, requestId on context | same | 413, body === exact envelope with `requestId` | Requirement 1.2, design Data Models |
 * | 4 | non-exempt path, ReadableStream body > cap, no Content-Length | same, `body: stream, duplex: 'half'` | 413, exact envelope | Requirement 1.3 |
 * | 5 | ReadableStream that counts how many chunks it yields, far more chunks queued than needed to cross the cap | same | 413, and fewer chunks were pulled than were queued | Requirement 1.3 ("stop reading... at the first byte past the limit"), NFR Performance |
 * | 6 | non-exempt path, body > cap, method PUT / PATCH / DELETE | `app.request(path, { method, body, headers })` | 413 for each method | Requirement 1.6 |
 * | 7 | non-exempt path, no body, method GET | `app.request(path)` | 200, passes unchanged | Requirement 1.6 |
 * | 8 | none | import `BODY_LIMIT_EXEMPT_ROUTES` | `.length === 5` | Requirement 2.6, design Component 1 |
 * | 9 | one of the 5 exempt path patterns, body = 2 MiB, Content-Length set | `app.request(exemptPath, { method: 'POST', body, headers })` | 200, handler received 2 MiB | Requirement 2.6, design exempt table |
 * | 10 | an exempt path, body > cap, but method PUT (not POST) | `app.request(exemptPath, { method: 'PUT', body, headers })` | 413 | Requirement 2.6 |
 * | 11 | an exempt path with a trailing slash appended, body > cap | `app.request(exemptPath + '/', ...)` | 413 | Requirement 2.6 |
 * | 12 | an exempt path with a doubled slash inserted, body > cap | `app.request(doubledSlashPath, ...)` | 413 | Requirement 2.6 |
 *
 * NFR Reliability ("not logged as 5xx, not sent to PostHog error capture") is folded into every
 * 413 case above: each awaits `app.request()` to completion and asserts `status === 413` with no
 * thrown exception, which is only possible if `onError` returns a response rather than throwing
 * (design Component 1, post-condition 4) — a throw here would propagate out of `app.request()`
 * uncaught, since this test app registers no `app.onError`.
 *
 * Requirement 1.9 ("no configuration") is folded in by omission: no test sets any environment
 * variable or touches `is*Configured()`, so every case above already demonstrates the middleware
 * behaving identically with none set.
 */

const CAP = GLOBAL_BODY_LIMIT_BYTES;
const TWO_MIB = 2 * 1024 * 1024;

function bytes(n: number): string {
  return 'a'.repeat(n);
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.use('*', globalBodyLimitMiddleware);
  app.all('*', async (c) => {
    if (c.req.raw.body == null) {
      return c.json({ ok: true, bytesReceived: 0 });
    }
    const text = await c.req.text();
    return c.json({ ok: true, bytesReceived: text.length });
  });
  return app;
}

const expectedEnvelope = {
  error: {
    code: 'PAYLOAD_TOO_LARGE',
    message: `Request body exceeds ${CAP} bytes`,
    requestId: 'test-request-id',
  },
};

describe('globalBodyLimitMiddleware', () => {
  it('GLOBAL_BODY_LIMIT_BYTES is exactly 1,048,576 (1 MiB)', () => {
    expect(GLOBAL_BODY_LIMIT_BYTES).toBe(1_048_576);
  });

  it('a body of exactly 1,048,576 bytes reaches the handler unchanged', async () => {
    const app = makeApp();
    const body = bytes(CAP);
    const res = await app.request('/api/tags', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; bytesReceived: number };
    expect(json.bytesReceived).toBe(CAP);
  });

  it('a body of 1,048,577 bytes gets 413 with the exact envelope and the request id', async () => {
    const app = makeApp();
    const body = bytes(CAP + 1);
    const res = await app.request('/api/tags', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual(expectedEnvelope);
  });

  it('a ReadableStream body over the cap, with no Content-Length, gets 413', async () => {
    const app = makeApp();
    const encoder = new TextEncoder();
    const chunk = encoder.encode('a'.repeat(1024));
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < CAP / 1024 + 10; i++) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const res = await app.request('/api/tags', {
      method: 'POST',
      body: stream,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: 'half',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual(expectedEnvelope);
  });

  it('stops reading the stream once the cap is crossed, rather than draining it (NFR Performance)', async () => {
    const app = makeApp();
    const chunkSize = 1024;
    const chunksNeededToCrossCap = Math.ceil(CAP / chunkSize) + 1;
    const chunksQueued = chunksNeededToCrossCap * 10;
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (pulled >= chunksQueued) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(new Uint8Array(chunkSize).fill(97));
      },
    });
    const res = await app.request('/api/tags', {
      method: 'POST',
      body: stream,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: 'half',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(chunksQueued);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s with a body over the cap gets 413', async (method) => {
    const app = makeApp();
    const body = bytes(CAP + 1);
    const res = await app.request('/api/tags', {
      method,
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual(expectedEnvelope);
  });

  it('a GET with no body passes through unchanged', async () => {
    const app = makeApp();
    const res = await app.request('/api/tags', { method: 'GET' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; bytesReceived: number };
    expect(json.ok).toBe(true);
    expect(json.bytesReceived).toBe(0);
  });

  it('BODY_LIMIT_EXEMPT_ROUTES holds exactly five patterns', () => {
    expect(BODY_LIMIT_EXEMPT_ROUTES.length).toBe(5);
  });

  it.each([
    ['advisor stream', '/api/advisor/conversations/abc123/messages/stream'],
    ['position images', '/api/positions/42/images'],
    ['csv import preview', '/api/csv-import/preview'],
    ['account-data import preview', '/api/account-data/import/preview'],
    ['account-data import', '/api/account-data/import'],
  ])('exempt pattern (%s): a 2 MiB POST reaches the handler', async (_label, path) => {
    const app = makeApp();
    const body = bytes(TWO_MIB);
    const res = await app.request(path, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; bytesReceived: number };
    expect(json.bytesReceived).toBe(TWO_MIB);
  });

  it('a PUT (not POST) to an exempt path over the cap gets 413', async () => {
    const app = makeApp();
    const body = bytes(TWO_MIB);
    const res = await app.request('/api/positions/42/images', {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual(expectedEnvelope);
  });

  it('a trailing slash on an exempt path over the cap gets 413', async () => {
    const app = makeApp();
    const body = bytes(TWO_MIB);
    const res = await app.request('/api/positions/42/images/', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual(expectedEnvelope);
  });

  it('a doubled slash inside an exempt path over the cap gets 413', async () => {
    const app = makeApp();
    const body = bytes(TWO_MIB);
    const res = await app.request('/api/csv-import//preview', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual(expectedEnvelope);
  });
});
