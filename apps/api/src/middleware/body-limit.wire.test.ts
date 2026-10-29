import crypto from 'node:crypto';
import net from 'node:net';

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalBodyLimitMiddleware, GLOBAL_BODY_LIMIT_BYTES } from './body-limit.middleware';

/**
 * Contract block — one row per success criterion from tasks.md task 2 (wire cases).
 *
 * | # | Pre-condition | Call (through the seam) | Observable result | Expected-value source |
 * |---|---|---|---|---|
 * | case 3 | real socket, chunked body of exactly 1,048,576 bytes, `Connection: close` | raw HTTP write to a `serve({ fetch, port: 0 })` socket | 200, handler received 1,048,576 bytes | Requirement 1.3, design Error Handling case 4 / Testing Strategy |
 * | case 4 | real socket, chunked body of 1,048,577 bytes | same | 413 `PAYLOAD_TOO_LARGE` | Requirement 1.3, design Error Handling case 4 |
 * | case 5 | real socket, declared `Content-Length: 100`, socket later sends far more bytes | same, two staggered writes on one socket | handler's byte count === 100 (never more than declared) | Requirement 1.4, design Error Handling case 3 |
 * | case 6 | real socket, `Content-Length` and `Transfer-Encoding` both set | same | 400, before any handler runs | Requirement 1.4, design Error Handling case 4 |
 * | case 18 | real socket, identical webhook-style JSON body sent once chunked and once with `Content-Length` | same, two separate sockets | both reach the handler with an equal SHA-256 | Requirement 3.2, design Error Handling case 7 |
 *
 * All five cases are regression guards, not red tests (tasks.md task 2): task 1 already ships
 * `globalBodyLimitMiddleware`, and cases 5, 6 and 18 are Node's own HTTP parser framing, which
 * holds with or without that middleware mounted at all.
 */

const CAP = GLOBAL_BODY_LIMIT_BYTES;

function makeApp(): Hono {
  const app = new Hono();
  app.use('*', globalBodyLimitMiddleware);
  app.all('*', async (c) => {
    const buf = await c.req.arrayBuffer();
    const hash = crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
    return c.json({ bytesReceived: buf.byteLength, hash });
  });
  return app;
}

function buildRequest(opts: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): string {
  const headerLines = Object.entries(opts.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  return `${opts.method} ${opts.path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headerLines}\r\n\r\n${opts.body ?? ''}`;
}

function chunkedEncode(payload: Buffer): string {
  const CHUNK_SIZE = 65536;
  const parts: string[] = [];
  for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
    const slice = payload.subarray(i, i + CHUNK_SIZE);
    parts.push(`${slice.length.toString(16)}\r\n${slice.toString('latin1')}\r\n`);
  }
  parts.push('0\r\n\r\n');
  return parts.join('');
}

type RawResponse = { status: number; headers: Record<string, string>; body: string };

function parseFirstResponse(raw: Buffer): RawResponse {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    throw new Error(`no response header terminator in ${raw.length} bytes`);
  }
  const headText = raw.subarray(0, headerEnd).toString('latin1');
  const lines = headText.split('\r\n');
  const status = Number(lines[0].split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const bodyStart = headerEnd + 4;
  const contentLength = headers['content-length'] ? Number(headers['content-length']) : 0;
  const body = raw.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
  return { status, headers, body };
}

describe('global body limit — wire level (@hono/node-server, raw sockets)', () => {
  let server: ServerType;
  let port: number;
  const openSockets = new Set<net.Socket>();

  beforeAll(async () => {
    const app = makeApp();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch.bind(app), port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.destroy();
    }
    openSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function sendOverSocket(parts: string[], delayMs = 0): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      openSockets.add(socket);
      const chunks: Buffer[] = [];
      socket.on('connect', () => {
        void (async () => {
          for (const part of parts) {
            socket.write(part);
            if (delayMs > 0) {
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
        })();
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => {
        openSockets.delete(socket);
        resolve(Buffer.concat(chunks));
      });
      socket.on('error', (err) => {
        openSockets.delete(socket);
        // A socket that already delivered a full response can still reset when
        // bytes written past a declared Content-Length get parsed as a garbage
        // pipelined request (case 5) — that reset is the expected side effect of
        // overflowing the connection, not a failure of the request under test.
        if (chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(err);
        }
      });
    });
  }

  it('case 3 — a chunked body of exactly 1,048,576 bytes reaches the handler', async () => {
    const payload = Buffer.from('a'.repeat(CAP));
    const raw = buildRequest({
      method: 'POST',
      path: '/api/tags',
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        Connection: 'close',
      },
      body: chunkedEncode(payload),
    });
    const res = parseFirstResponse(await sendOverSocket([raw]));
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body) as { bytesReceived: number };
    expect(json.bytesReceived).toBe(CAP);
  }, 20_000);

  it('case 4 — a chunked body of 1,048,577 bytes gets 413', async () => {
    const payload = Buffer.from('a'.repeat(CAP + 1));
    const raw = buildRequest({
      method: 'POST',
      path: '/api/tags',
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        Connection: 'close',
      },
      body: chunkedEncode(payload),
    });
    const res = parseFirstResponse(await sendOverSocket([raw]));
    expect(res.status).toBe(413);
    const json = JSON.parse(res.body) as { error: { code: string } };
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
  }, 20_000);

  it('case 5 — a handler that counts bytes gets at most the declared Content-Length when the socket sends more', async () => {
    const declared = 100;
    const head = buildRequest({
      method: 'POST',
      path: '/api/tags',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(declared),
      },
      body: 'b'.repeat(declared),
    });
    const overflow = 'b'.repeat(50_000);
    const res = parseFirstResponse(await sendOverSocket([head, overflow], 100));
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body) as { bytesReceived: number };
    expect(json.bytesReceived).toBeLessThanOrEqual(declared);
    expect(json.bytesReceived).toBe(declared);
  }, 20_000);

  it('case 6 — a request with both Content-Length and Transfer-Encoding gets 400', async () => {
    const raw = buildRequest({
      method: 'POST',
      path: '/api/tags',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '5',
        'Transfer-Encoding': 'chunked',
      },
      body: '5\r\nhello\r\n0\r\n\r\n',
    });
    const res = parseFirstResponse(await sendOverSocket([raw]));
    expect(res.status).toBe(400);
  }, 20_000);

  it('case 18 — chunked and Content-Length bodies reach the handler with an equal SHA-256', async () => {
    const payload = JSON.stringify({
      id: crypto.randomUUID(),
      type: 'checkout.session.completed',
    });
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

    const chunkedReq = buildRequest({
      method: 'POST',
      path: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        Connection: 'close',
      },
      body: chunkedEncode(Buffer.from(payload)),
    });
    const contentLengthReq = buildRequest({
      method: 'POST',
      path: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        Connection: 'close',
      },
      body: payload,
    });

    const [chunkedRes, contentLengthRes] = await Promise.all([
      sendOverSocket([chunkedReq]).then(parseFirstResponse),
      sendOverSocket([contentLengthReq]).then(parseFirstResponse),
    ]);

    expect(chunkedRes.status).toBe(200);
    expect(contentLengthRes.status).toBe(200);
    const chunkedJson = JSON.parse(chunkedRes.body) as { hash: string };
    const contentLengthJson = JSON.parse(contentLengthRes.body) as { hash: string };
    expect(chunkedJson.hash).toBe(expectedHash);
    expect(contentLengthJson.hash).toBe(expectedHash);
  }, 20_000);
});
