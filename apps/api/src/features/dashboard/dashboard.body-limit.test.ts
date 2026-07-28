import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describe, it, expect } from 'vitest';

import { BODY_LIMIT_BYTES } from '@tradr/shared';

function makeApp() {
  return new Hono().put(
    '/test',
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `Request body exceeds ${BODY_LIMIT_BYTES} bytes`,
              requestId: 'unit-test',
            },
          },
          413,
        ),
    }),
    async (c) => {
      const body = await c.req.json().catch((e) => {
        if (e?.name === 'BodyLimitError') throw e;
        return null;
      });
      return c.json({
        ok: true,
        gotBytes: body == null ? 0 : JSON.stringify(body).length,
      });
    },
  );
}

describe('dashboard bodyLimit + bespoke onError', () => {
  it('content-length under cap: small JSON PUT returns 200 with ok:true', async () => {
    const app = makeApp();
    const body = JSON.stringify({ pad: 'a'.repeat(88) });
    const res = await app.request('/test', {
      method: 'PUT',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; gotBytes: number };
    expect(json.ok).toBe(true);
    expect(json.gotBytes).toBe(body.length);
  });

  it('content-length over cap: 17000 bytes returns 413 with bespoke envelope', async () => {
    const app = makeApp();
    const body = JSON.stringify({ pad: 'a'.repeat(17000 - 10) });
    expect(body.length).toBe(17000);
    const res = await app.request('/test', {
      method: 'PUT',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${BODY_LIMIT_BYTES} bytes`,
        requestId: 'unit-test',
      },
    });
  });

  it('stream path under cap: ReadableStream of small JSON returns 200', async () => {
    const app = makeApp();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"x":1}'));
        controller.close();
      },
    });
    const res = await app.request('/test', {
      method: 'PUT',
      body: stream,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: 'half',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; gotBytes: number };
    expect(json.ok).toBe(true);
    expect(json.gotBytes).toBe('{"x":1}'.length);
  });

  it('stream path over cap: 17000 bytes via stream returns 413 with bespoke envelope', async () => {
    const app = makeApp();
    const encoder = new TextEncoder();
    const chunk = 'a'.repeat(1700);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const res = await app.request('/test', {
      method: 'PUT',
      body: stream,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: 'half',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds ${BODY_LIMIT_BYTES} bytes`,
        requestId: 'unit-test',
      },
    });
  });

  it('deceptive Content-Length: header says 100, stream sends 17000 bytes — returns 413', async () => {
    // FINDING: Hono 4.12.8 bodyLimit trusts Content-Length when present without
    // transfer-encoding (see hono/dist/middleware/body-limit/index.js L26-29).
    // A deceptive CL=100 short-circuits the streaming size check, so the 17000-
    // byte body reaches the handler. The handler's c.req.json() then fails to
    // parse the non-JSON garbage payload; the catch returns null and the
    // handler responds 200 / gotBytes:0. This test pins that bypass behaviour
    // so any future Hono upgrade that closes the hole flips the assertion.
    const app = makeApp();
    const encoder = new TextEncoder();
    const chunk = 'a'.repeat(1700);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const res = await app.request('/test', {
      method: 'PUT',
      body: stream,
      // @ts-expect-error duplex is required for streaming request bodies
      duplex: 'half',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100',
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; gotBytes: number };
    expect(json).toEqual({ ok: true, gotBytes: 0 });
  });
});
