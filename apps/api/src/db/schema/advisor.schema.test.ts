/**
 * Advisor schema integration tests (Task 9 — pinned count: 4; +1 for advisor-tools
 * Task 1: conversation-delete cascade to advisor_summaries, REQ-9.8).
 *
 * Runs against the real test database via `src/test-setup.ts` (migrations
 * already applied in beforeAll; each test wrapped in a rolled-back
 * transaction). The DB is NOT mocked.
 *
 * Cases:
 *  1. user-row duplicate → UNIQUE violation (advisor_messages_idem)
 *  2. assistant pair-uniqueness → UNIQUE violation (advisor_messages_assistant_pair_uniq)
 *  3. CHECK on role → invalid role rejected (advisor_messages_role_chk)
 *  4. orphan-detection SQL (copied verbatim from 0009_advisor_core.sql step 0)
 *     returns count > 0 (v2-9). Does NOT re-run migration step 0.
 *
 * _Requirements: 4.10, 12.1_
 */
import { eq, sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { advisorConversations, advisorMessages, advisorSummaries, users } from '@/db/schema';

let counter = 0;

async function seedConversation(): Promise<{ id: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `advschema-${Date.now()}-${++counter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  const [conv] = await db
    .insert(advisorConversations)
    .values({
      userId: user!.id,
      title: 'Test conversation',
      providerId: 'openai',
      model: 'gpt-4o',
    })
    .returning();
  return { id: conv!.id };
}

function pgError(err: unknown): { code?: string; message?: string } {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  return { code: e.code ?? e.cause?.code, message: e.message ?? e.cause?.message ?? '' };
}

describe('advisor schema integration', () => {
  it('case 1: duplicate user row → UNIQUE violation (advisor_messages_idem)', async () => {
    const conv = await seedConversation();
    const clientMessageId = crypto.randomUUID();
    await db.insert(advisorMessages).values({
      conversationId: conv.id,
      role: 'user',
      contentParts: [{ type: 'text', text: 'hi' }],
      clientMessageId,
    });

    let caught: { code?: string; message?: string } | null = null;
    try {
      await db.insert(advisorMessages).values({
        conversationId: conv.id,
        role: 'user',
        contentParts: [{ type: 'text', text: 'hi again' }],
        clientMessageId,
      });
    } catch (err) {
      caught = pgError(err);
    }
    expect(caught?.code).toBe('23505');
    expect(caught?.message).toMatch(/advisor_messages_idem/);
  });

  it('case 2: duplicate assistant pair → UNIQUE violation (advisor_messages_assistant_pair_uniq)', async () => {
    const conv = await seedConversation();
    const clientMessageId = crypto.randomUUID();
    await db.insert(advisorMessages).values({
      conversationId: conv.id,
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'reply' }],
      clientMessageId,
    });

    let caught: { code?: string; message?: string } | null = null;
    try {
      await db.insert(advisorMessages).values({
        conversationId: conv.id,
        role: 'assistant',
        contentParts: [{ type: 'text', text: 'reply 2' }],
        clientMessageId,
      });
    } catch (err) {
      caught = pgError(err);
    }
    expect(caught?.code).toBe('23505');
    expect(caught?.message).toMatch(/advisor_messages_assistant_pair_uniq/);
  });

  it('case 3: invalid role → CHECK violation (advisor_messages_role_chk)', async () => {
    const conv = await seedConversation();

    let caught: { code?: string; message?: string } | null = null;
    try {
      await db.insert(advisorMessages).values({
        conversationId: conv.id,
        role: 'system',
        contentParts: [{ type: 'text', text: 'nope' }],
      });
    } catch (err) {
      caught = pgError(err);
    }
    expect(caught?.code).toBe('23514');
    expect(caught?.message).toMatch(/advisor_messages_role_chk/);
  });

  it('case 4: orphan-detection SELECT returns count > 0 (v2-9)', async () => {
    const conv = await seedConversation();
    // Seed an orphan assistant row: an assistant message with a client_message_id
    // that has NO matching user row in the same conversation.
    await db.insert(advisorMessages).values({
      conversationId: conv.id,
      role: 'assistant',
      contentParts: [{ type: 'text', text: 'orphaned' }],
      clientMessageId: crypto.randomUUID(),
    });

    // Orphan-detect SELECT copied from apps/api/src/db/migrations/0009_advisor_core.sql
    // step 0. The ONLY permitted adaptation is `SELECT count(*) INTO orphan_count`
    // (PL/pgSQL) -> `SELECT count(*) AS orphan_count` (standalone query). The
    // WHERE / NOT EXISTS predicate below MUST stay byte-identical to the migration's;
    // keep these two in sync when either changes.
    const rows = await db.execute<{ orphan_count: string }>(sql`
		SELECT count(*) AS orphan_count
		FROM advisor_messages a
		WHERE a.role = 'assistant'
			AND a.client_message_id IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM advisor_messages u
				WHERE u.conversation_id = a.conversation_id
					AND u.client_message_id = a.client_message_id
					AND u.role = 'user'
			)
	`);
    expect(Number(rows[0]!.orphan_count)).toBeGreaterThan(0);
  });

  it('case 5: deleting a conversation cascades to advisor_summaries (REQ-9.8)', async () => {
    const conv = await seedConversation();
    await db.insert(advisorSummaries).values({
      conversationId: conv.id,
      prose: 'rolling summary',
      coveredThroughCreatedAt: new Date(),
    });

    const before = await db
      .select()
      .from(advisorSummaries)
      .where(eq(advisorSummaries.conversationId, conv.id));
    expect(before).toHaveLength(1);

    await db.delete(advisorConversations).where(eq(advisorConversations.id, conv.id));

    const after = await db
      .select()
      .from(advisorSummaries)
      .where(eq(advisorSummaries.conversationId, conv.id));
    expect(after).toHaveLength(0);
  });
});
