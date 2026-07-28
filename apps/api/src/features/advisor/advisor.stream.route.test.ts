// Streaming route + handler integration tests (Task 24; design §Component 7).
//
// 20 it() cases covering the 13 pinned failure paths + the happy path + the 6
// image-numeric boundaries (each its own it() per v2-3) + the SSE heartbeat
// (Task 28, REQ-3.7). The DB query
// helpers, the streaming orchestrator, the provider registry, and the
// encryption util are mocked at the module boundary so these are deterministic
// unit-level integration tests of the handler's pre-stream sequencing and SSE
// wiring (the mocked-adapter boundary per REQ-11.4). The auth path is exercised
// through the REAL advisorRouter (its authMiddleware rejects before any DB call
// when no session cookie is present).

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_IMAGE_BYTES_DEFAULT } from '@tradr/shared';

// eslint-disable-next-line import-x/order -- import-x/order miscounts groups in this file because some imports are intentionally placed after vi.mock() (hoisting); see the matching disable below.
import { errorHandler } from '@/middleware/error.middleware';

// --- Module mocks ------------------------------------------------------------

const assertOwnsConversation = vi.fn();
const loadStreamContext = vi.fn();
const prepare = vi.fn();
const runStreaming = vi.fn();
const listModels = vi.fn();
const getProvider = vi.fn<(...a: unknown[]) => { id: string; listModels: typeof listModels }>(
  () => ({ id: 'claude', listModels }),
);
const decrypt = vi.fn();

vi.mock('./advisor.query', () => ({
  assertOwnsConversation: (...a: unknown[]) => assertOwnsConversation(...a),
  loadStreamContext: (...a: unknown[]) => loadStreamContext(...a),
}));
vi.mock('./streaming', () => ({
  prepare: (...a: unknown[]) => prepare(...a),
  runStreaming: (...a: unknown[]) => runStreaming(...a),
  // Task 7: the provider-path history resolver. Object storage is unconfigured
  // in this route test, so it is an identity passthrough (matches the real
  // storage-off behavior) — history reaches prepare() unchanged.
  resolveForProvider: (h: unknown) => h,
}));
vi.mock('./providers/registry', () => ({
  getProvider: (...a: unknown[]) => getProvider(...a),
}));
vi.mock('@/lib/encryption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
  return { ...actual, decrypt: (...a: unknown[]) => decrypt(...a) };
});

// eslint-disable-next-line import-x/order
import { EncryptionError } from '@/lib/encryption';

import { HEARTBEAT_MS, streamHandler } from './stream.handler';

// --- Test app: pre-sets userId then runs the handler -------------------------

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp() {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', 'user-1');
    c.set('isAdmin', false);
    await next();
  });
  app.post('/conversations/:id/messages/stream', streamHandler);
  app.post('/conversations/new/messages/stream', streamHandler);
  app.onError(errorHandler);
  return app;
}

const UUID = '11111111-1111-4111-8111-111111111111';

function bodyFor(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ clientMessageId: UUID, text: 'hi', ...overrides });
}

function post(app: Hono<AuthEnv>, path: string, body: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function* genFrames(...frames: { event: string; data: string }[]) {
  for (const f of frames) yield f;
}

const goodModel = { id: 'm1', displayName: 'M1', contextWindow: 200_000, vision: true };

/** Default happy wiring for the mocks. */
function wireHappy() {
  loadStreamContext.mockResolvedValue({
    providerId: 'claude',
    modelId: 'm1',
    encryptedKey: 'enc',
    history: [],
    persona: null,
    personaId: null,
  });
  decrypt.mockReturnValue('plaintext-key');
  listModels.mockResolvedValue([goodModel]);
  prepare.mockResolvedValue({
    prepared: { kind: 'stream' },
    releaseSlot: vi.fn(),
  });
  runStreaming.mockReturnValue(
    genFrames(
      { event: 'token', data: JSON.stringify({ delta: 'he' }) },
      { event: 'done', data: JSON.stringify({ messageId: 'a1' }) },
    ),
  );
}

// b64 of n raw bytes (n must be a multiple of 3 for an exact length).
function b64OfBytes(n: number) {
  return Buffer.alloc(n, 0).toString('base64');
}
function imageOf(n: number) {
  return { type: 'image', format: 'png', dataBase64: b64OfBytes(n) };
}

// The consolidated per-image cap (Task 3/12) is on the ENCODED (base64) length,
// default MAX_IMAGE_BYTES_DEFAULT. imageOf(n) makes n raw bytes → base64 length
// n*4/3 (n a multiple of 3). CAP_RAW is the raw-byte count that encodes to
// EXACTLY the cap — the accept boundary; CAP_RAW + 3 is one quantum over.
const CAP_RAW = (MAX_IMAGE_BYTES_DEFAULT / 4) * 3;

// Turn-level EXIF-strip fixture (Task 15 / REQ-8.2): a minimal valid JPEG whose
// APP1 segment carries a known GPS marker. The unit-level strip proof lives in
// image-metadata.test.ts; here we assert the strip runs at the ingestion seam so
// the bytes that flow to persistTurn (stored) and the provider (forwarded) — i.e.
// the `input.attachments[].dataBase64` handed to prepare() — carry no GPS marker.
const GPS_MARKER = 'GPS_FIXTURE_LAT';
function buildJpegWithGps(): Buffer {
  const exifBody = Buffer.concat([
    Buffer.from('Exif\x00\x00', 'latin1'),
    Buffer.from(GPS_MARKER, 'latin1'),
    Buffer.from('II*\x00rest', 'latin1'),
  ]);
  const app1Len = exifBody.length + 2;
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff]),
    exifBody,
  ]);
  const soi = Buffer.from([0xff, 0xd8]);
  const dqt = Buffer.from([0xff, 0xdb, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0xde, 0xad, 0xbe, 0xef]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, dqt, sos, eoi]);
}

beforeEach(() => {
  assertOwnsConversation.mockReset();
  loadStreamContext.mockReset();
  prepare.mockReset();
  runStreaming.mockReset();
  listModels.mockReset();
  decrypt.mockReset();
  getProvider.mockReturnValue({ id: 'claude', listModels });
  wireHappy();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('advisor streaming route', () => {
  // --- 1. auth ---------------------------------------------------------------
  it('rejects an unauthed request with 401 (router auth)', async () => {
    const { advisorRouter } = await import('./advisor.route');
    const app = new Hono();
    app.route('/api/advisor', advisorRouter);
    app.onError(errorHandler);
    const res = await app.request('/api/advisor/conversations/new/messages/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyFor(),
    });
    expect(res.status).toBe(401);
  });

  // --- 2. happy path ---------------------------------------------------------
  it('streams token + done frames on the happy path', async () => {
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const text = await res.text();
    expect(text).toContain('event: token');
    expect(text).toContain('event: done');
  });

  // --- 3. validation error ---------------------------------------------------
  it('returns 400 VALIDATION_ERROR for a non-UUID clientMessageId', async () => {
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ clientMessageId: 'not-a-uuid' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  // --- 4. ownership / NOT_FOUND ---------------------------------------------
  it('returns 404 NOT_FOUND when ownership check fails', async () => {
    const { NotFoundError } = await import('@/lib/errors');
    assertOwnsConversation.mockRejectedValue(new NotFoundError('Conversation', UUID));
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  // --- 5. key-decrypt --------------------------------------------------------
  it('returns 500 KEY_DECRYPT_FAILED when the BYOK key cannot be decrypted', async () => {
    decrypt.mockImplementation(() => {
      throw new EncryptionError('gcm-tag-mismatch');
    });
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('KEY_DECRYPT_FAILED');
  });

  // --- 6. concurrency cap ----------------------------------------------------
  it('returns 429 STREAM_IN_PROGRESS when the concurrency slot is taken', async () => {
    const { StreamInProgressError } = await import('./advisor.errors');
    prepare.mockRejectedValue(new StreamInProgressError());
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('STREAM_IN_PROGRESS');
  });

  // --- 7. retry-while-in-flight ---------------------------------------------
  it('returns 429 RETRY_WHILE_IN_FLIGHT on a same-id retry while in flight', async () => {
    const { RetryWhileInFlightError } = await import('./advisor.errors');
    prepare.mockRejectedValue(new RetryWhileInFlightError());
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('RETRY_WHILE_IN_FLIGHT');
  });

  // --- 8. Layer-2 dedupe -----------------------------------------------------
  it('emits a synthetic Layer-2 done frame on a dedupe hit', async () => {
    prepare.mockResolvedValue({
      prepared: { kind: 'synthetic-done', messageId: 'a9', source: 'layer-2' },
      releaseSlot: vi.fn(),
    });
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).toContain('"source":"layer-2"');
    expect(runStreaming).not.toHaveBeenCalled();
  });

  // --- 9. Layer-1 dedupe (mid-stream done with source layer-1) ---------------
  it('passes through a Layer-1 deduped done frame from runStreaming', async () => {
    runStreaming.mockReturnValue(
      genFrames({
        event: 'done',
        data: JSON.stringify({ messageId: 'a1', deduped: true, source: 'layer-1' }),
      }),
    );
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    const text = await res.text();
    expect(text).toContain('"source":"layer-1"');
  });

  // --- 10. persistence-failure (mid-stream error frame) ----------------------
  it('writes a PERSISTENCE_FAILED error frame mid-stream (status stays 200)', async () => {
    runStreaming.mockReturnValue(
      genFrames({
        event: 'error',
        data: JSON.stringify({ code: 'PERSISTENCE_FAILED', upstreamStatus: null }),
      }),
    );
    const app = makeApp();
    const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).toContain('PERSISTENCE_FAILED');
  });

  // --- 11. rate-limit (PER-USER isolation) -----------------------------------
  it('rate-limits per authenticated user with separate buckets', async () => {
    const appFor = await buildRateLimitedApp();
    // User A burns through 30 then 429s on the 31st.
    const appA = appFor('user-A');
    let lastA: Response | undefined;
    for (let i = 0; i < 31; i++) {
      lastA = await post(appA, '/conversations/new/messages/stream', bodyFor());
    }
    expect(lastA!.status).toBe(429);
    expect((await lastA!.json()).error.code).toBe('RATE_LIMITED');

    // User B shares the same limiter store (same IP) but a DIFFERENT bucket:
    // A hitting the limit must NOT 429 B's first request.
    const appB = appFor('user-B');
    const resB = await post(appB, '/conversations/new/messages/stream', bodyFor());
    expect(resB.status).toBe(200);
  });

  // --- 12. vision capability -------------------------------------------------
  it('returns 400 MODEL_DOES_NOT_SUPPORT_VISION for images on a non-vision model', async () => {
    listModels.mockResolvedValue([{ ...goodModel, vision: false }]);
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ attachments: [imageOf(3)] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('MODEL_DOES_NOT_SUPPORT_VISION');
  });

  // --- 12b. EXIF strip at ingestion (Task 15 / REQ-8.2) ----------------------
  it('strips GPS/EXIF before the bytes flow to persist/forward (prepare input)', async () => {
    const gpsJpeg = buildJpegWithGps();
    expect(gpsJpeg.toString('latin1')).toContain(GPS_MARKER); // sanity: marker present pre-strip

    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({
        attachments: [{ type: 'image', format: 'jpeg', dataBase64: gpsJpeg.toString('base64') }],
      }),
    );
    expect(res.status).toBe(200);

    // prepare() receives the SAME validated body that buildNewMessageParts reads
    // for both persistTurn (stored) and the provider call (forwarded). Its image
    // bytes must already be stripped of the GPS marker.
    const preparedInput = prepare.mock.calls[0]![0] as {
      input: { attachments?: { dataBase64: string }[] };
    };
    const forwarded = Buffer.from(preparedInput.input.attachments![0]!.dataBase64, 'base64');
    expect(forwarded.toString('latin1')).not.toContain(GPS_MARKER);
  });

  // --- 13. new-conversation happy path ---------------------------------------
  it('streams on the new-conversation path (conversationId null)', async () => {
    const app = makeApp();
    const res = await post(app, '/conversations/new/messages/stream', bodyFor());
    expect(res.status).toBe(200);
    expect(loadStreamContext).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: null }),
    );
    expect(assertOwnsConversation).not.toHaveBeenCalled();
  });

  // --- 14-19. image-numerics boundaries (each its own it() per v2-3) ---------
  it('accepts 4 images (per-count cap)', async () => {
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ attachments: [imageOf(3), imageOf(3), imageOf(3), imageOf(3)] }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects 5 images (per-count cap) with VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ attachments: [imageOf(3), imageOf(3), imageOf(3), imageOf(3), imageOf(3)] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a single image at the per-image cap boundary', async () => {
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ attachments: [imageOf(CAP_RAW)] }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a single image one quantum over the per-image cap with IMAGE_TOO_LARGE', async () => {
    // +3 raw bytes → +4 base64 chars, exactly one quantum over the encoded cap.
    // Rejected at schema validation, before any base64 decode (REQ-4.2).
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ attachments: [imageOf(CAP_RAW + 3)] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('accepts 4 images each at the per-image cap', async () => {
    // The consolidated cap is per-image (schema .max) × the count cap of 4; there
    // is no separate combined sum-cap. Four images each at the cap all pass.
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({
        attachments: [imageOf(CAP_RAW), imageOf(CAP_RAW), imageOf(CAP_RAW), imageOf(CAP_RAW)],
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a message where one of several images is over the per-image cap', async () => {
    // The consolidated cap is per-image (schema .max), enforced before decode. A
    // single oversized image trips IMAGE_TOO_LARGE regardless of the others; the
    // three at-cap images are individually fine.
    const app = makeApp();
    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({
        attachments: [imageOf(CAP_RAW), imageOf(CAP_RAW), imageOf(CAP_RAW), imageOf(CAP_RAW + 3)],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('IMAGE_TOO_LARGE');
  });

  // --- 20. SSE heartbeat (REQ-3.7) -------------------------------------------
  // Simulates a long tool-silent window between two real frames: the route-side
  // setInterval must emit a `:`-comment keepalive every HEARTBEAT_MS of silence,
  // reset the window on every real frame, clear on completion, and never emit a
  // spurious `data:` line for a heartbeat.
  it('emits comment keepalives during a tool-silent window, reset by real frames', async () => {
    vi.useFakeTimers();
    try {
      // A gate the generator awaits between the first real frame and the second,
      // modelling the silent window while a tool runs (the generator is blocked
      // on this await and cannot yield a heartbeat itself).
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      async function* gatedFrames() {
        yield { event: 'token', data: JSON.stringify({ delta: 'he' }) };
        await gate; // silent window — only heartbeats should flow here
        yield { event: 'token', data: JSON.stringify({ delta: 'llo' }) };
        yield { event: 'done', data: JSON.stringify({ messageId: 'a1' }) };
      }
      runStreaming.mockReturnValue(gatedFrames());

      const app = makeApp();
      const res = await post(app, `/conversations/${UUID}/messages/stream`, bodyFor());
      expect(res.status).toBe(200);

      // Drain the SSE body incrementally so we can advance timers mid-stream.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const pump = async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      };
      const pumping = pump();

      // Let the first real frame flush.
      await vi.advanceTimersByTimeAsync(0);
      expect(text).toContain(JSON.stringify({ delta: 'he' }));
      // No heartbeat yet — the first frame just reset the window.
      expect(text.match(/: keepalive/g) ?? []).toHaveLength(0);

      // 2.5 × HEARTBEAT_MS of silence → exactly 2 keepalives.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2.5);
      expect(text.match(/: keepalive/g) ?? []).toHaveLength(2);

      // Release the gate: the next real frame must reset the window.
      openGate();
      await vi.advanceTimersByTimeAsync(0);
      const keepalivesAfterResume = (text.match(/: keepalive/g) ?? []).length;

      // A further sub-HEARTBEAT_MS window after the reset adds no keepalive.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
      expect(text.match(/: keepalive/g) ?? []).toHaveLength(keepalivesAfterResume);

      await pumping;

      // Both real frames + done present; interval cleared on completion.
      expect(text).toContain(JSON.stringify({ delta: 'he' }));
      expect(text).toContain(JSON.stringify({ delta: 'llo' }));
      expect(text).toContain('event: done');
      // Heartbeats never carry a data: line.
      expect(text).not.toMatch(/data:\s*keepalive/);
      // Comment lines start with `:` and have no event/data — count holds steady
      // after close (interval cleared in finally).
      const finalCount = (text.match(/: keepalive/g) ?? []).length;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
      expect(text.match(/: keepalive/g) ?? []).toHaveLength(finalCount);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- 21. request-body floor (Task 12; design §Component 3, SF-3, REQ-4) -----
  // The stream route mounts `hono/bodyLimit` FIRST so an oversized request body
  // is rejected with 413 before it is buffered and before the handler runs. This
  // mirrors that wiring (bodyLimit → streamHandler) with a small cap and asserts
  // the 413 short-circuits ahead of any handler work.
  it('returns 413 PAYLOAD_TOO_LARGE when the request body exceeds the floor', async () => {
    const { bodyLimit } = await import('hono/body-limit');
    const app = new Hono<AuthEnv>();
    app.use(async (c, next) => {
      c.set('userId', 'user-1');
      c.set('isAdmin', false);
      await next();
    });
    app.post(
      '/conversations/:id/messages/stream',
      bodyLimit({
        maxSize: 500,
        onError: (c) => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'too large' } }, 413),
      }),
      streamHandler,
    );
    app.onError(errorHandler);

    const res = await post(
      app,
      `/conversations/${UUID}/messages/stream`,
      bodyFor({ text: 'x'.repeat(2000) }),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    // Rejected before the handler — no downstream work happened.
    expect(loadStreamContext).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});

// Build a factory over ONE shared limiter (same store) that mounts the real
// streaming rate limiter keyed on the authenticated userId — mirroring
// advisor.route.ts. Each returned app stubs auth to a given userId. Under
// app.request the client IP is constant (127.0.0.1), so distinct buckets prove
// the limiter keys on userId, NOT IP (per-user billing cap, REQ-3).
async function buildRateLimitedApp() {
  const { createRateLimiter } = await import('@/middleware/rate-limit.middleware');
  const limiter = createRateLimiter({
    name: 'stream',
    max: 30,
    windowMs: 60_000,
    keyGenerator: (c) => c.get('userId'),
  });
  return (userId: string) => {
    const app = new Hono<AuthEnv>();
    app.use(async (c, next) => {
      c.set('userId', userId);
      c.set('isAdmin', false);
      await next();
    });
    app.post('/conversations/new/messages/stream', limiter, streamHandler);
    app.onError(errorHandler);
    return app;
  };
}
