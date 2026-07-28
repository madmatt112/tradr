/**
 * Advisor object-storage WRITE-PATH integration tests (hosted-platform Task 6;
 * design §Component 2 "Write sequencing", D9/D10; REQ-2.1, REQ-2.2, REQ-2.5,
 * REQ-2.7, REQ-1.2).
 *
 * Real Postgres (NO DB mocks) via `src/test-setup.ts` — every test runs in a
 * rolled-back drizzle transaction. Two boundaries are stubbed:
 *   - `./providers/registry` (`getProvider`): a scripted adapter that replays a
 *     token/usage/done script AND captures the message list it was handed, so we
 *     can prove the provider received INLINE image bytes this turn.
 *   - `@/lib/object-storage` (`getObjectStorage`): a controllable in-memory fake
 *     that records `put(key, bytes, contentType)`. Flipped on/off per test via
 *     the hoisted `storageMock.enabled` flag. `advisorImageKey` stays REAL.
 *
 * Asserted:
 *  - Storage ON  ⇒ the persisted user-message row carries a `{storage:{kind:'object',key}}`
 *    pointer marker with NO `dataBase64`; the bucket received the EXIF-STRIPPED
 *    bytes (REQ-2.5); the provider call THIS turn still received inline bytes (D10).
 *  - Storage OFF ⇒ the row is byte-for-byte inline (base64), no `put` happened (REQ-1.2).
 *  - The widened persistence helpers behave on the storage-on path: `firstTextPart`
 *    skips the pointer image (conversation title = first text), and
 *    `estimatePartsTokens` still counts a pointer image as an image (FALLBACK cost).
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanonicalMessage, ProviderModel } from '@tradr/shared';

import { db } from '@/db';
import {
  advisorConversations,
  advisorMessages,
  advisorProviderKeys,
  usageRecords,
  users,
  wallets,
} from '@/db/schema';
import { config } from '@/lib/config';
import {
  encrypt,
  ENCRYPTION_KEY_VERSION_CURRENT,
  loadEncryptionKeyMaterial,
} from '@/lib/encryption';
import { errorHandler } from '@/middleware/error.middleware';

// --- Object-storage fake (controllable, hoisted so the vi.mock factory sees it) --

const storageMock = vi.hoisted(() => ({
  enabled: false,
  puts: [] as { key: string; bytes: Uint8Array; contentType: string }[],
}));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  const fake = {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      storageMock.puts.push({ key, bytes, contentType });
    },
    async get() {
      throw new Error('get not exercised on the write path');
    },
    async delete() {},
    async list() {
      return [];
    },
  };
  return {
    ...actual,
    getObjectStorage: () => (storageMock.enabled ? fake : null),
  };
});

// --- Provider adapter stub (captures the provider-bound message list) ------------

type StreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null }
  | { type: 'done' };

let script: StreamEvent[] = [];
let models: ProviderModel[] = [];
let capturedMessages: CanonicalMessage[] | null = null;

const listModels = vi.fn(async () => models);

function makeStubAdapter() {
  return {
    id: 'openai' as const,
    listModels,
    translate: (list: CanonicalMessage[]) => list,
    prepareForTokenCount: (list: { role: string; parts?: { text?: string }[] }[]) =>
      list.map((m) => (m.parts ?? []).map((p) => p.text ?? '').join(' ')).join('\n'),
    async *streamChat(args: { messages: CanonicalMessage[] }) {
      capturedMessages = args.messages;
      for (const evt of script) yield evt;
    },
  };
}

vi.mock('./providers/registry', () => ({
  getProvider: () => makeStubAdapter(),
}));

import { streamHandler } from './stream.handler';

// --- Test app + helpers ----------------------------------------------------------

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', userId);
    c.set('isAdmin', false);
    await next();
  });
  app.post('/conversations/:id/messages/stream', streamHandler);
  app.post('/conversations/new/messages/stream', streamHandler);
  app.onError(errorHandler);
  return app;
}

function post(app: Hono<AuthEnv>, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const PRICED_MODEL = 'gpt-4o';
const GPS_MARKER = 'GPS_FIXTURE_LAT';

/** A minimal valid JPEG whose APP1 segment carries a known GPS marker (mirrors
 *  advisor.stream.route.test.ts). The EXIF strip at ingestion must remove it, so
 *  the STRIPPED bytes are what the bucket stores (REQ-2.5). */
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

function pngBytes(n = 12): string {
  return Buffer.alloc(n, 7).toString('base64');
}

let seedCounter = 0;

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `adv-imgstore-${Date.now()}-${++seedCounter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return user!.id;
}

async function seedProviderKey(userId: string) {
  await db.insert(advisorProviderKeys).values({
    userId,
    providerId: 'openai',
    encryptedKey: encrypt('byok-plaintext'),
    keyVersion: ENCRYPTION_KEY_VERSION_CURRENT,
    defaultModel: PRICED_MODEL,
    keyHintTail: 'tail',
    lastUsedAt: null,
  });
}

async function seedWallet(userId: string, balance: bigint) {
  await db.insert(wallets).values({ userId, balance, reserved: 0n, reservedAt: null });
}

async function seedConversation(userId: string): Promise<string> {
  const [conv] = await db
    .insert(advisorConversations)
    .values({ userId, title: 'existing', providerId: 'openai', model: PRICED_MODEL })
    .returning();
  return conv!.id;
}

async function userRowOf(conversationId: string) {
  const [row] = await db
    .select()
    .from(advisorMessages)
    .where(
      and(eq(advisorMessages.conversationId, conversationId), eq(advisorMessages.role, 'user')),
    );
  return row!;
}

type StoredPart =
  | { type: 'text'; text: string }
  | { type: 'image'; format: string; dataBase64?: string; storage?: { kind: string; key: string } };

// --- config ----------------------------------------------------------------------

let prev: Record<string, string | undefined> = {};

beforeAll(() => {
  loadEncryptionKeyMaterial();
  prev = {
    OPENAI_API_KEY: config.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
    STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET,
  };
  config.OPENAI_API_KEY = 'sk-platform-openai';
  config.ANTHROPIC_API_KEY = 'sk-platform-anthropic';
  config.STRIPE_SECRET_KEY = 'sk_test_dummy';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
});

afterAll(() => {
  config.OPENAI_API_KEY = prev.OPENAI_API_KEY;
  config.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
  config.STRIPE_SECRET_KEY = prev.STRIPE_SECRET_KEY;
  config.STRIPE_WEBHOOK_SECRET = prev.STRIPE_WEBHOOK_SECRET;
});

beforeEach(() => {
  storageMock.enabled = false;
  storageMock.puts = [];
  capturedMessages = null;
  models = [
    {
      id: PRICED_MODEL,
      displayName: PRICED_MODEL,
      contextWindow: 200_000,
      vision: true,
      toolUse: true,
    },
  ];
  script = [
    { type: 'token', delta: 'answer' },
    { type: 'usage', promptTokens: 10, completionTokens: 5 },
    { type: 'done' },
  ];
  listModels.mockClear();
});

describe('advisor object-storage write path (real Postgres)', () => {
  it('storage ON: persists a pointer marker (no base64), stores EXIF-stripped bytes, provider gets inline bytes (REQ-2.1/2.2/2.5/2.7, D10)', async () => {
    storageMock.enabled = true;
    const userId = await seedUser();
    await seedProviderKey(userId); // BYOK path — no wallet needed

    const app = makeApp(userId);
    const res = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: crypto.randomUUID(),
      text: 'hello world',
      attachments: [
        { type: 'image', format: 'jpeg', dataBase64: buildJpegWithGps().toString('base64') },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');

    const [conv] = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.userId, userId));
    // firstTextPart (widened to StoredContentPart[]) skips the pointer image and
    // seeds the title from the first TEXT part.
    expect(conv!.title).toBe('hello world');

    const userRow = await userRowOf(conv!.id);
    const parts = userRow.contentParts as StoredPart[];
    const img = parts.find((p) => p.type === 'image') as Extract<StoredPart, { type: 'image' }>;
    // Persisted as a pointer marker with NO inline base64 (REQ-2.2).
    expect(img.storage).toEqual({ kind: 'object', key: expect.any(String) });
    expect(img.dataBase64).toBeUndefined();
    expect(img.storage!.key).toMatch(new RegExp(`^advisor/${userId}/`));

    // Exactly one bucket put, keyed identically, image/jpeg, holding the
    // EXIF-STRIPPED bytes (no GPS marker) — REQ-2.5.
    expect(storageMock.puts).toHaveLength(1);
    expect(storageMock.puts[0]!.key).toBe(img.storage!.key);
    expect(storageMock.puts[0]!.contentType).toBe('image/jpeg');
    expect(Buffer.from(storageMock.puts[0]!.bytes).includes(GPS_MARKER)).toBe(false);

    // D10 trap check: the provider call THIS turn received INLINE bytes (not a
    // pointer), also EXIF-stripped.
    const provMsg = capturedMessages!.find(
      (m): m is Extract<CanonicalMessage, { role: 'user' }> =>
        m.role === 'user' && m.parts.some((p) => p.type === 'image'),
    );
    const provImg = provMsg!.parts.find((p) => p.type === 'image') as {
      type: 'image';
      dataBase64?: string;
      storage?: unknown;
    };
    expect(typeof provImg.dataBase64).toBe('string');
    expect(provImg.storage).toBeUndefined();
    expect(Buffer.from(provImg.dataBase64!, 'base64').includes(GPS_MARKER)).toBe(false);
  });

  it('storage OFF: persists inline base64 byte-for-byte and never calls the bucket (REQ-1.2)', async () => {
    storageMock.enabled = false;
    const userId = await seedUser();
    await seedProviderKey(userId);
    const b64 = pngBytes();

    const app = makeApp(userId);
    const res = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: crypto.randomUUID(),
      text: 'chart please',
      attachments: [{ type: 'image', format: 'png', dataBase64: b64 }],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');

    expect(storageMock.puts).toHaveLength(0);

    const [conv] = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.userId, userId));
    const userRow = await userRowOf(conv!.id);
    const parts = userRow.contentParts as StoredPart[];
    const img = parts.find((p) => p.type === 'image') as Extract<StoredPart, { type: 'image' }>;
    // Byte-for-byte inline (a PNG carries no EXIF to strip, so bytes are unchanged).
    expect(img.dataBase64).toBe(b64);
    expect(img.storage).toBeUndefined();
  });

  it('storage ON platform turn: estimatePartsTokens counts a pointer image as an image (REQ-2.2)', async () => {
    storageMock.enabled = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId); // platform (no BYOK key)
    await seedWallet(userId, 100_000_000n);
    // Provider reports zero prompt tokens → the metering estimate-fallback runs
    // over the persisted user-message parts (which now hold a pointer image).
    script = [
      { type: 'token', delta: 'ok' },
      { type: 'usage', promptTokens: 0, completionTokens: 40 },
      { type: 'done' },
    ];

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'x',
      attachments: [{ type: 'image', format: 'png', dataBase64: pngBytes() }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"mode":"platform"');
    expect(text).toContain('event: done');

    const userRow = await userRowOf(convId);
    const parts = userRow.contentParts as StoredPart[];
    expect((parts.find((p) => p.type === 'image') as { storage?: unknown }).storage).toEqual({
      kind: 'object',
      key: expect.any(String),
    });

    const [rec] = await db.select().from(usageRecords).where(eq(usageRecords.userId, userId));
    // The pointer image kept `type:'image'`, so the flat FALLBACK_IMAGE_TOKENS
    // (1500) estimate is preserved — a text-only 'x' would be ~1 token.
    expect(Number(rec!.inputTokens)).toBeGreaterThanOrEqual(1500);
    expect(rec!.outputTokens).toBe(40n);
  });
});
