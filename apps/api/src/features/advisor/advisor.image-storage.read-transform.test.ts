// Client read transform tests (Task 8; design §Component 2 F2, REQ-2.3/2.4).
//
// `toResponseParts` (advisor.query.ts) maps the persisted `StoredContentPart`
// shape to the client `ResponseMessageContentPart` shape, DROPPING the object
// storage key so it never reaches the client (REQ-2.4 — no IDOR leak). The
// transform lives inside `listMessages`'s `.map`, so BOTH read handlers
// (`getConversationHandler` and `listMessagesHandler`) inherit it — proven here
// against the real test DB (no service mock), plus direct unit coverage of the
// three part states.

import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import type { StoredContentPart } from '@tradr/shared';

import { db } from '@/db';
import { advisorConversations, advisorMessages, users } from '@/db/schema';
import { errorHandler } from '@/middleware/error.middleware';

import { toResponseParts } from './advisor.query';
import { getConversationHandler, listMessagesHandler } from './crud.handler';

// --- Unit: the pure transform, all three part states -------------------------

describe('toResponseParts', () => {
  it('passes inline / legacy parts through unchanged (marker absent)', () => {
    const parts: StoredContentPart[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', format: 'png', dataBase64: 'AAAA' },
    ];
    expect(toResponseParts(parts)).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', format: 'png', dataBase64: 'AAAA' },
    ]);
  });

  it('maps a pointer to { storage: "object" } and DROPS the key (REQ-2.4)', () => {
    const parts: StoredContentPart[] = [
      { type: 'image', format: 'jpeg', storage: { kind: 'object', key: 'advisor/u/secret' } },
    ];
    const out = toResponseParts(parts);
    expect(out).toEqual([{ type: 'image', format: 'jpeg', storage: 'object' }]);
    // No key anywhere in the mapped part.
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('key');
  });

  it('maps an unrecoverable marker to { storage: "unrecoverable" }', () => {
    const parts: StoredContentPart[] = [
      { type: 'image', format: 'webp', storage: { kind: 'unrecoverable' } },
    ];
    expect(toResponseParts(parts)).toEqual([
      { type: 'image', format: 'webp', storage: 'unrecoverable' },
    ]);
  });
});

// --- Integration: BOTH read handlers, real DB --------------------------------

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

const OBJECT_KEY = 'advisor/read-transform-user/super-secret-object-key';

// One message carrying all three persisted states, so a single assertion covers
// inline passthrough, pointer key-drop, and unrecoverable.
const STORED_PARTS: StoredContentPart[] = [
  { type: 'text', text: 'chart please' },
  { type: 'image', format: 'png', dataBase64: 'AAAA' },
  { type: 'image', format: 'jpeg', storage: { kind: 'object', key: OBJECT_KEY } },
  { type: 'image', format: 'webp', storage: { kind: 'unrecoverable' } },
];

const EXPECTED_PARTS = [
  { type: 'text', text: 'chart please' },
  { type: 'image', format: 'png', dataBase64: 'AAAA' },
  { type: 'image', format: 'jpeg', storage: 'object' },
  { type: 'image', format: 'webp', storage: 'unrecoverable' },
];

async function seedConversationWithParts(): Promise<{ userId: string; conversationId: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `read-transform-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  const [conv] = await db
    .insert(advisorConversations)
    .values({ userId: user!.id, title: 'read', providerId: 'claude', model: 'm' })
    .returning();
  await db.insert(advisorMessages).values({
    conversationId: conv!.id,
    role: 'user',
    contentParts: STORED_PARTS,
    clientMessageId: crypto.randomUUID(),
  });
  return { userId: user!.id, conversationId: conv!.id };
}

function makeApp(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', userId);
    c.set('isAdmin', false);
    await next();
  });
  app.get('/conversations/:id', getConversationHandler);
  app.get('/conversations/:id/messages', listMessagesHandler);
  app.onError(errorHandler);
  return app;
}

describe('client read transform through both handlers', () => {
  it('getConversationHandler returns { storage: "object" } with NO key', async () => {
    const { userId, conversationId } = await seedConversationWithParts();
    const app = makeApp(userId);
    const res = await app.request(`/conversations/${conversationId}`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    // Hard IDOR guard: the object key never appears in the wire payload.
    expect(raw).not.toContain(OBJECT_KEY);
    const body = JSON.parse(raw);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].contentParts).toEqual(EXPECTED_PARTS);
  });

  it('listMessagesHandler returns { storage: "object" } with NO key', async () => {
    const { userId, conversationId } = await seedConversationWithParts();
    const app = makeApp(userId);
    const res = await app.request(`/conversations/${conversationId}/messages`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(OBJECT_KEY);
    const body = JSON.parse(raw);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].contentParts).toEqual(EXPECTED_PARTS);
  });
});
