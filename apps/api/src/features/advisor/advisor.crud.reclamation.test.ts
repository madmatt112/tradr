/**
 * Advisor conversation-delete reclamation tests (hosted-platform Task 10;
 * design §Component 2 "Reclamation (REQ-2.4)").
 *
 * Real Postgres (NO DB mocks) via `src/test-setup.ts` — every test runs in a
 * rolled-back drizzle transaction, so `collectConversationObjectKeys`, the FK
 * cascade, and `deleteConversationOwned` are all exercised against the live DB.
 * The ONLY stubbed boundary is `@/lib/object-storage` (`getObjectStorage`): a
 * controllable in-memory fake that records `delete(key)` calls and can be made
 * to reject. Flipped on/off per test via the hoisted `storageMock.enabled` flag.
 *
 * Asserted:
 *  - deleting a conversation with pointer images collects the keys PRE-delete
 *    (the rows are cascade-destroyed, yet `delete()` is still called per key —
 *    only possible if collected before the delete) and calls `storage.delete`
 *    once per pointer key AFTER the delete commits; inline / unrecoverable parts
 *    carry no key and are skipped;
 *  - a `storage.delete` failure is non-fatal — the request still returns 204,
 *    the failure is warn-logged, the remaining keys are still attempted, and the
 *    conversation is gone;
 *  - inert when storage is off — no scan, no `delete()` calls;
 *  - the pre-delete scan is ownership-scoped — an attacker's DELETE 404s and
 *    reclaims NOTHING (never reads/deletes another user's objects).
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { advisorConversations, advisorMessages, users } from '@/db/schema';
import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/error.middleware';

// --- Object-storage fake (controllable, hoisted so the vi.mock factory sees it) --

const storageMock = vi.hoisted(() => ({
  enabled: true,
  deletes: [] as string[],
  failKeys: new Set<string>(),
}));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  const fake = {
    async put() {},
    async get() {
      throw new Error('get not exercised on the reclamation path');
    },
    async delete(key: string) {
      storageMock.deletes.push(key);
      if (storageMock.failKeys.has(key)) throw new Error('delete boom');
    },
    async list() {
      return [];
    },
  };
  return { ...actual, getObjectStorage: () => (storageMock.enabled ? fake : null) };
});

// Imported AFTER the mock so the handler resolves the fake `getObjectStorage`.
import { deleteConversationHandler } from './crud.handler';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', userId);
    c.set('isAdmin', false);
    await next();
  });
  app.delete('/conversations/:id', deleteConversationHandler);
  app.onError(errorHandler);
  return app;
}

let seedCounter = 0;

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `adv-reclaim-${Date.now()}-${++seedCounter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return user!.id;
}

async function seedConversation(userId: string): Promise<string> {
  const [conv] = await db
    .insert(advisorConversations)
    .values({ userId, title: 't', providerId: 'openai', model: 'gpt-4o' })
    .returning();
  return conv!.id;
}

async function seedMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  contentParts: unknown,
) {
  await db.insert(advisorMessages).values({ conversationId, role, contentParts });
}

beforeEach(() => {
  storageMock.enabled = true;
  storageMock.deletes = [];
  storageMock.failKeys = new Set();
  vi.restoreAllMocks();
});

describe('advisor conversation-delete reclamation (real Postgres, REQ-2.4)', () => {
  it('collects pointer keys pre-delete and deletes each object AFTER commit', async () => {
    const userId = await seedUser();
    const convId = await seedConversation(userId);
    await seedMessage(convId, 'user', [
      { type: 'text', text: 'look at this' },
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/u/k1' } },
    ]);
    await seedMessage(convId, 'assistant', [
      { type: 'image', format: 'jpeg', storage: { kind: 'object', key: 'advisor/u/k2' } },
      { type: 'image', format: 'png', dataBase64: 'aW5s' }, // inline — no key
      { type: 'image', format: 'jpeg', storage: { kind: 'unrecoverable' } }, // no key
    ]);

    const res = await makeApp(userId).request(`/conversations/${convId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    // Exactly the two pointer keys — inline/unrecoverable parts skipped.
    expect(storageMock.deletes.sort()).toEqual(['advisor/u/k1', 'advisor/u/k2']);

    // The conversation + its messages are gone (FK cascade). The keys were still
    // deleted, which is only possible if collected BEFORE the delete.
    const convs = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, convId));
    expect(convs).toHaveLength(0);
    const msgs = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, convId));
    expect(msgs).toHaveLength(0);
  });

  it('a storage.delete failure does not fail the request (warn-logged, others still attempted)', async () => {
    const userId = await seedUser();
    const convId = await seedConversation(userId);
    await seedMessage(convId, 'user', [
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/u/fail' } },
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/u/ok' } },
    ]);
    storageMock.failKeys = new Set(['advisor/u/fail']);
    const warnSpy = vi.spyOn(logger, 'warn');

    const res = await makeApp(userId).request(`/conversations/${convId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    // Both attempted; the failing one is warn-logged, the other still deleted.
    expect(storageMock.deletes.sort()).toEqual(['advisor/u/fail', 'advisor/u/ok']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ key: 'advisor/u/fail' }),
    );
    const convs = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, convId));
    expect(convs).toHaveLength(0);
  });

  it('is inert when object storage is off — no scan, no deletes', async () => {
    storageMock.enabled = false;
    const userId = await seedUser();
    const convId = await seedConversation(userId);
    await seedMessage(convId, 'user', [
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/u/k' } },
    ]);

    const res = await makeApp(userId).request(`/conversations/${convId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(storageMock.deletes).toEqual([]);
    const convs = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, convId));
    expect(convs).toHaveLength(0);
  });

  it("does not reclaim another user's objects — the pre-delete scan is ownership-scoped", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const convId = await seedConversation(owner);
    await seedMessage(convId, 'user', [
      { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/owner/secret' } },
    ]);

    const res = await makeApp(attacker).request(`/conversations/${convId}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(storageMock.deletes).toEqual([]);

    // The owner's conversation is untouched.
    const convs = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, convId));
    expect(convs).toHaveLength(1);
  });
});
