/**
 * `getOwnedMessageParts` ownership-scoping tests (hosted-platform Task 9;
 * REQ-2.4). Runs against the real test database via `src/test-setup.ts` (each
 * test wrapped in a rolled-back transaction). Proves the SQL join makes
 * cross-user image access impossible (no IDOR): the owner reads the parts; a
 * different user, a wrong message id, and a wrong conversation id each return
 * the identical `null` (no existence oracle).
 */
import { randomUUID } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import type { StoredContentPart } from '@tradr/shared';

import { db } from '@/db';
import { advisorConversations, advisorMessages, users } from '@/db/schema';

import { getOwnedMessageParts } from './advisor.query';

const IMAGE_PARTS: StoredContentPart[] = [
  { type: 'text', text: 'look at this chart' },
  { type: 'image', format: 'png', storage: { kind: 'object', key: 'advisor/owner/key-1' } },
];

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `img-proxy-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning();
  return user!.id;
}

async function seedMessage(userId: string): Promise<{ conversationId: string; messageId: string }> {
  const [conv] = await db
    .insert(advisorConversations)
    .values({ userId, title: 'chart talk', providerId: 'openai', model: 'gpt-4o' })
    .returning();
  const [msg] = await db
    .insert(advisorMessages)
    .values({ conversationId: conv!.id, role: 'user', contentParts: IMAGE_PARTS })
    .returning();
  return { conversationId: conv!.id, messageId: msg!.id };
}

describe('getOwnedMessageParts — SQL-level ownership scoping (REQ-2.4)', () => {
  it('returns the parts for the owning user', async () => {
    const owner = await seedUser();
    const { conversationId, messageId } = await seedMessage(owner);

    const parts = await getOwnedMessageParts({ conversationId, messageId, userId: owner });

    expect(parts).toEqual(IMAGE_PARTS);
  });

  it('returns null for a DIFFERENT user (cross-user access impossible)', async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const { conversationId, messageId } = await seedMessage(owner);

    const parts = await getOwnedMessageParts({ conversationId, messageId, userId: attacker });

    expect(parts).toBeNull();
  });

  it('returns null for a message id not in the conversation', async () => {
    const owner = await seedUser();
    const { conversationId } = await seedMessage(owner);

    const parts = await getOwnedMessageParts({
      conversationId,
      messageId: randomUUID(),
      userId: owner,
    });

    expect(parts).toBeNull();
  });

  it('returns null when the conversation id does not match the message', async () => {
    const owner = await seedUser();
    const { messageId } = await seedMessage(owner);

    const parts = await getOwnedMessageParts({
      conversationId: randomUUID(),
      messageId,
      userId: owner,
    });

    expect(parts).toBeNull();
  });
});
