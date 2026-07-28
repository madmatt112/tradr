/**
 * Advisor persistTurn integration tests.
 *
 * Runs against the real test database via `src/test-setup.ts` (migrations
 * applied in beforeAll; each test wrapped in a rolled-back transaction). The DB
 * is NOT mocked.
 *
 * Cases (design §Component 4 / §4.3):
 *  1. new conversation + turn persisted (REQ-4.2)
 *  2. idempotent duplicate user message → no duplicate row, deduped result
 *     (REQ-3.12 Layer-1 / ON CONFLICT DO NOTHING)
 *  3. assistant inherits the user message's client_message_id (REQ-4.3)
 *  4. missing paired assistant on dedupe hit → InvariantViolationError
 *  5. provider key last_used_at bumped post-commit (REQ-6.6)
 *  6. conversation updated_at bumped on the inserted path
 *  7. existing-conversation append reuses the row (ownership/listing)
 *  8. multi-iteration tool turn → ONE user + ONE assistant row, ordered
 *     text/tool_call/tool_result parts on the single assistant row
 *     (REQ-3.8, REQ-4.3, REQ-4.5)
 *  9-10. estimate-fallback metering (wallet-billing REQ-5.6)
 *  11-14. plan-tiers Task 9: platform-only turn counting (credits +
 *     allowance), the allowance persist branch (creditCost 0 / true rawCost /
 *     no wallet lock), and the all-source image counter with dedupe safety
 *     (plan-tiers REQ-8.3, REQ-8.5, REQ-9.1)
 *
 * _Requirements: 4.2, 4.3, 4.5, 4.9, 3.8, 3.12, 6.6, 12.1; plan-tiers 8.3,
 * 8.5, 9.1_
 */
import { and, eq } from 'drizzle-orm';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { db } from '@/db';
import {
  advisorConversations,
  advisorMessages,
  advisorProviderKeys,
  usageRecords,
  users,
  walletTransactions,
  wallets,
} from '@/db/schema';
import {
  currentPeriodKeyUtc,
  getAllowanceUsage,
  getImageCount,
  getTurnCount,
} from '@/features/admin/gating.query';
import { priceTurnUsage, priceTurnUsageParts } from '@/features/billing/pricing';
import * as posthog from '@/lib/posthog';

import { InvariantViolationError } from './advisor.errors';
import { persistTurn, type PersistTurnArgs } from './persistence';

let counter = 0;

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `adv-persist-${Date.now()}-${++counter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return user!.id;
}

async function seedProviderKey(userId: string): Promise<void> {
  await db.insert(advisorProviderKeys).values({
    userId,
    providerId: 'openai',
    encryptedKey: 'enc',
    keyVersion: 1,
    defaultModel: 'gpt-4o',
    keyHintTail: 'abcd',
    lastUsedAt: null,
  });
}

function makeArgs(userId: string, overrides?: Partial<PersistTurnArgs>): PersistTurnArgs {
  return {
    conversationId: null,
    userId,
    userMessage: {
      contentParts: [{ type: 'text', text: 'What is my P&L?' }],
      clientMessageId: crypto.randomUUID(),
    },
    assistantMessage: {
      contentParts: [{ type: 'text', text: 'Here is your P&L.' }],
      promptTokens: 12,
      completionTokens: 34,
    },
    providerId: 'openai',
    modelId: 'gpt-4o',
    personaId: null,
    ...overrides,
  };
}

describe('advisor persistTurn integration', () => {
  it('case 1: new conversation + exchange persisted atomically', async () => {
    const userId = await seedUser();
    const result = await persistTurn(makeArgs(userId));

    expect(result.kind).toBe('inserted');
    if (result.kind !== 'inserted') throw new Error('unreachable');

    const conv = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, result.conversationId));
    expect(conv).toHaveLength(1);
    expect(conv[0]!.userId).toBe(userId);
    // Title seeded from first text part (≤ 60 chars).
    expect(conv[0]!.title).toBe('What is my P&L?');

    const msgs = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, result.conversationId));
    expect(msgs).toHaveLength(2);
    const roles = msgs.map((m) => m.role).sort();
    expect(roles).toEqual(['assistant', 'user']);
  });

  it('case 2: duplicate user message is deduped — no second user row', async () => {
    const userId = await seedUser();
    const args = makeArgs(userId);

    const first = await persistTurn(args);
    expect(first.kind).toBe('inserted');
    if (first.kind !== 'inserted') throw new Error('unreachable');

    // Replay the SAME clientMessageId against the now-existing conversation.
    const second = await persistTurn({
      ...args,
      conversationId: first.conversationId,
    });

    expect(second.kind).toBe('deduped');
    if (second.kind !== 'deduped') throw new Error('unreachable');
    // The replay returns the SAME paired assistant id from the first insert.
    expect(second.assistantMessageId).toBe(first.assistantMessageId);

    // Only ONE user row exists for that client_message_id (ON CONFLICT DO NOTHING).
    const userRows = await db
      .select()
      .from(advisorMessages)
      .where(
        and(
          eq(advisorMessages.conversationId, first.conversationId),
          eq(advisorMessages.clientMessageId, args.userMessage.clientMessageId),
          eq(advisorMessages.role, 'user'),
        ),
      );
    expect(userRows).toHaveLength(1);

    // And no extra assistant row was written on the replay.
    const allMsgs = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, first.conversationId));
    expect(allMsgs).toHaveLength(2);
  });

  it('case 3: assistant message inherits the user client_message_id', async () => {
    const userId = await seedUser();
    const args = makeArgs(userId);
    const result = await persistTurn(args);
    if (result.kind !== 'inserted') throw new Error('unreachable');

    const assistant = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.id, result.assistantMessageId));
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.clientMessageId).toBe(args.userMessage.clientMessageId);
    expect(assistant[0]!.role).toBe('assistant');
  });

  it('case 4: missing paired assistant on dedupe hit → InvariantViolationError', async () => {
    const userId = await seedUser();
    const clientMessageId = crypto.randomUUID();

    // Create a conversation with ONLY a user row carrying this clientMessageId —
    // simulating a crashed write where the assistant pair never landed.
    const [conv] = await db
      .insert(advisorConversations)
      .values({ userId, title: 'orphan', providerId: 'openai', model: 'gpt-4o' })
      .returning();
    await db.insert(advisorMessages).values({
      conversationId: conv!.id,
      role: 'user',
      contentParts: [{ type: 'text', text: 'orphaned' }],
      clientMessageId,
    });

    // Replaying the same clientMessageId hits the dedupe branch, finds no paired
    // assistant row, and must throw the invariant violation.
    const args = makeArgs(userId, {
      conversationId: conv!.id,
      userMessage: { contentParts: [{ type: 'text', text: 'orphaned' }], clientMessageId },
    });
    await expect(persistTurn(args)).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('case 5: provider key last_used_at is bumped post-commit', async () => {
    const userId = await seedUser();
    await seedProviderKey(userId);

    const before = await db
      .select()
      .from(advisorProviderKeys)
      .where(eq(advisorProviderKeys.userId, userId));
    expect(before[0]!.lastUsedAt).toBeNull();

    await persistTurn(makeArgs(userId));

    const after = await db
      .select()
      .from(advisorProviderKeys)
      .where(eq(advisorProviderKeys.userId, userId));
    expect(after[0]!.lastUsedAt).not.toBeNull();
  });

  it('case 6: conversation updated_at is bumped on insert', async () => {
    const userId = await seedUser();

    // Seed an existing conversation with a deliberately old updated_at.
    const old = new Date('2020-01-01T00:00:00Z');
    const [conv] = await db
      .insert(advisorConversations)
      .values({
        userId,
        title: 'existing',
        providerId: 'openai',
        model: 'gpt-4o',
        updatedAt: old,
      })
      .returning();

    await persistTurn(makeArgs(userId, { conversationId: conv!.id }));

    const after = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, conv!.id));
    expect(after[0]!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('case 7: append to existing conversation reuses the row (no new conversation)', async () => {
    const userId = await seedUser();

    const first = await persistTurn(makeArgs(userId));
    if (first.kind !== 'inserted') throw new Error('unreachable');

    const second = await persistTurn(makeArgs(userId, { conversationId: first.conversationId }));
    expect(second.kind).toBe('inserted');
    if (second.kind !== 'inserted') throw new Error('unreachable');
    expect(second.conversationId).toBe(first.conversationId);

    // Exactly one conversation for this user; four messages in it (2 exchanges).
    const convs = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.userId, userId));
    expect(convs).toHaveLength(1);

    const msgs = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, first.conversationId));
    expect(msgs).toHaveLength(4);
  });

  it('case 8: multi-iteration tool turn persists one user + one assistant row with ordered parts', async () => {
    const userId = await seedUser();

    // A 3-iteration tool turn: two tool round-trips then a final answer,
    // expressed as the full ordered assistant part sequence (design §4.3).
    const assistantParts: PersistTurnArgs['assistantMessage']['contentParts'] = [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', id: 'c1', name: 'get_quote', arguments: { symbol: 'AAPL' } },
      { type: 'tool_result', toolCallId: 'c1', status: 'ok', content: { price: 100 } },
      { type: 'tool_call', id: 'c2', name: 'get_quote', arguments: { symbol: 'TSLA' } },
      { type: 'tool_result', toolCallId: 'c2', status: 'ok', content: { price: 200 } },
      { type: 'text', text: 'AAPL is 100 and TSLA is 200.' },
    ];

    const result = await persistTurn(
      makeArgs(userId, {
        assistantMessage: { contentParts: assistantParts, promptTokens: 50, completionTokens: 60 },
      }),
    );
    expect(result.kind).toBe('inserted');
    if (result.kind !== 'inserted') throw new Error('unreachable');

    // EXACTLY one user row + one assistant row — no 'tool' rows (REQ-4.5).
    const msgs = await db
      .select()
      .from(advisorMessages)
      .where(eq(advisorMessages.conversationId, result.conversationId));
    expect(msgs).toHaveLength(2);
    const roles = msgs.map((m) => m.role).sort();
    expect(roles).toEqual(['assistant', 'user']);

    // The done.messageId is the single assistant row id, holding the full
    // ordered part sequence in content_parts.
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.id).toBe(result.assistantMessageId);
    expect(assistant.contentParts).toEqual(assistantParts);
  });

  // ─── Component 7 / REQ-5.6: estimate-fallback so a no-usage turn is never charged 0 ───

  async function seedWallet(userId: string, balance: bigint, reserved: bigint): Promise<void> {
    await db.insert(wallets).values({ userId, balance, reserved, reservedAt: new Date() });
  }

  function platformBilling(
    reservationHeld: bigint,
    usage: { inputTokens: number; outputTokens: number },
  ) {
    return {
      userId: '', // filled per-test
      providerId: 'openai' as const,
      model: 'gpt-4o',
      mode: 'credits' as const,
      usage,
      reservationHeld,
    };
  }

  it('case 9: platform turn with NO usage event is charged a non-zero ESTIMATED cost', async () => {
    const userId = await seedUser();
    const held = 1_000_000n;
    await seedWallet(userId, 10_000_000n, held);

    const result = await persistTurn(
      makeArgs(userId, {
        assistantMessage: {
          contentParts: [{ type: 'text', text: 'Your realized P&L this month is +$1,234.' }],
          promptTokens: null,
          completionTokens: null,
        },
        billing: { ...platformBilling(held, { inputTokens: 0, outputTokens: 0 }), userId },
      }),
    );
    if (result.kind !== 'inserted') throw new Error('unreachable');

    const [rec] = await db.select().from(usageRecords).where(eq(usageRecords.userId, userId));
    expect(rec).toBeDefined();
    // Both dimensions estimated from the persisted text (never 0) → non-zero cost.
    expect(rec!.inputTokens).toBeGreaterThan(0n);
    expect(rec!.outputTokens).toBeGreaterThan(0n);
    expect(rec!.creditCost).toBeGreaterThan(0n);

    const [w] = await db.select().from(wallets).where(eq(wallets.userId, userId));
    expect(w!.balance).toBe(10_000_000n - rec!.creditCost); // debited the estimate, not 0
    expect(w!.reserved).toBe(0n); // gate hold reconciled
  });

  it('case 10: platform turn WITH usage uses CAPTURED counts (estimate not applied)', async () => {
    const userId = await seedUser();
    const held = 1_000_000n;
    await seedWallet(userId, 10_000_000n, held);

    const captured = { inputTokens: 500, outputTokens: 800 };
    const result = await persistTurn(
      makeArgs(userId, {
        billing: { ...platformBilling(held, captured), userId },
      }),
    );
    if (result.kind !== 'inserted') throw new Error('unreachable');

    const [rec] = await db.select().from(usageRecords).where(eq(usageRecords.userId, userId));
    // Exactly the captured counts — estimate path not taken.
    expect(rec!.inputTokens).toBe(BigInt(captured.inputTokens));
    expect(rec!.outputTokens).toBe(BigInt(captured.outputTokens));
    expect(rec!.creditCost).toBe(
      priceTurnUsage({ provider: 'openai', model: 'gpt-4o', ...captured }),
    );
  });

  // ─── plan-tiers Task 9 (D11 / REQ-8.3, REQ-8.5, REQ-9.1): platform-only turn
  // counting, the allowance persist branch, and the all-source image counter ───

  it('case 11: platform-credits turn increments turn_count but NOT allowance_turns (REQ-8.3)', async () => {
    const userId = await seedUser();
    const held = 1_000_000n;
    await seedWallet(userId, 10_000_000n, held);

    const result = await persistTurn(
      makeArgs(userId, {
        billing: { ...platformBilling(held, { inputTokens: 100, outputTokens: 200 }), userId },
      }),
    );
    expect(result.kind).toBe('inserted');

    const periodKey = currentPeriodKeyUtc();
    expect(await getTurnCount(db, userId, periodKey)).toBe(1);
    expect(await getAllowanceUsage(db, userId, periodKey)).toBe(0);
  });

  it('case 12: BYOK turn (no billing arg) increments NO turn counter (REQ-8.3)', async () => {
    const userId = await seedUser();

    const result = await persistTurn(makeArgs(userId)); // no billing — BYOK
    expect(result.kind).toBe('inserted');

    const periodKey = currentPeriodKeyUtc();
    expect(await getTurnCount(db, userId, periodKey)).toBe(0);
    expect(await getAllowanceUsage(db, userId, periodKey)).toBe(0);
  });

  it('case 13: allowance-mode persist writes creditCost 0 + true rawCost + allowance_turns, takes NO wallet lock/debit (REQ-8.5)', async () => {
    const userId = await seedUser();
    // Deliberately NO wallet row: getWalletForUpdate/applyBalanceDelta would
    // blow up on a missing row, so success here proves neither ran (D11).

    const captured = { inputTokens: 500, outputTokens: 800 };
    const result = await persistTurn(
      makeArgs(userId, {
        billing: {
          userId,
          providerId: 'openai',
          model: 'gpt-4o',
          mode: 'allowance',
          usage: captured,
          reservationHeld: 0n, // no reservation is taken on an allowance turn (D10)
        },
      }),
    );
    expect(result.kind).toBe('inserted');

    // Usage record: true pre-markup rawCost, subsidized creditCost 0 marker.
    const [rec] = await db.select().from(usageRecords).where(eq(usageRecords.userId, userId));
    expect(rec).toBeDefined();
    const expected = priceTurnUsageParts({ provider: 'openai', model: 'gpt-4o', ...captured });
    expect(rec!.rawCost).toBe(expected.rawCost);
    expect(rec!.rawCost!).toBeGreaterThan(0n);
    expect(rec!.creditCost).toBe(0n);
    expect(rec!.inputTokens).toBe(BigInt(captured.inputTokens));
    expect(rec!.outputTokens).toBe(BigInt(captured.outputTokens));

    // No debit (no wallet_transactions row of any kind), no wallet row created.
    const txns = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, userId));
    expect(txns).toHaveLength(0);
    const w = await db.select().from(wallets).where(eq(wallets.userId, userId));
    expect(w).toHaveLength(0);

    // Counters: the allowance turn is a platform turn (turn_count) AND a
    // within-allowance one (allowance_turns) — one upsert set both.
    const periodKey = currentPeriodKeyUtc();
    expect(await getTurnCount(db, userId, periodKey)).toBe(1);
    expect(await getAllowanceUsage(db, userId, periodKey)).toBe(1);
  });

  it('case 14: image counter counts ALL credential sources on the inserted branch; a deduped replay never double-counts (REQ-9.1)', async () => {
    const userId = await seedUser();
    const periodKey = currentPeriodKeyUtc();

    // BYOK turn (no billing) carrying two images — images count regardless of
    // credential source.
    const clientMessageId = crypto.randomUUID();
    const args = makeArgs(userId, {
      userMessage: {
        contentParts: [
          { type: 'text', text: 'what do these charts say?' },
          { type: 'image', format: 'png', dataBase64: 'aGVsbG8=' },
          { type: 'image', format: 'jpeg', dataBase64: 'aGVsbG8=' },
        ],
        clientMessageId,
      },
    });
    const first = await persistTurn(args);
    expect(first.kind).toBe('inserted');
    expect(await getImageCount(db, userId, periodKey)).toBe(2);
    // BYOK: still no turn counter (the image counter is independent of it).
    expect(await getTurnCount(db, userId, periodKey)).toBe(0);

    // Deduped replay of the SAME clientMessageId returns before any counter —
    // the image count is unchanged.
    if (first.kind !== 'inserted') throw new Error('unreachable');
    const replay = await persistTurn({ ...args, conversationId: first.conversationId });
    expect(replay.kind).toBe('deduped');
    expect(await getImageCount(db, userId, periodKey)).toBe(2);

    // A text-only turn writes no image-counter row at all.
    const textOnly = await persistTurn(makeArgs(userId, { conversationId: first.conversationId }));
    expect(textOnly.kind).toBe('inserted');
    expect(await getImageCount(db, userId, periodKey)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Telemetry capture — advisor_conversation_started (Task 7, design Component 4).
// Spies the fire-and-forget captureServerEvent: a new-conversation turn
// (conversationId === null) emits exactly one event after commit with the
// opaque distinctId; appending to an existing conversation stays silent; a
// thrown capture never fails the persisted turn.
// ---------------------------------------------------------------------------

describe('advisor persistTurn — telemetry capture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('new conversation fires advisor_conversation_started once with opaque distinctId, after commit', async () => {
    const userId = await seedUser();
    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});

    const result = await persistTurn(makeArgs(userId)); // conversationId: null
    expect(result.kind).toBe('inserted');
    if (result.kind !== 'inserted') throw new Error('unreachable');

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith('advisor_conversation_started', {
      distinctId: userId,
    });

    // After-commit: the conversation row exists.
    const conv = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, result.conversationId));
    expect(conv).toHaveLength(1);
  });

  it('appending to an existing conversation does NOT capture', async () => {
    const userId = await seedUser();
    const first = await persistTurn(makeArgs(userId));
    if (first.kind !== 'inserted') throw new Error('unreachable');

    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});
    const second = await persistTurn(makeArgs(userId, { conversationId: first.conversationId }));
    expect(second.kind).toBe('inserted');

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('a thrown capture does not fail persistTurn (fire-and-forget)', async () => {
    const userId = await seedUser();
    vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {
      throw new Error('posthog boom');
    });

    const result = await persistTurn(makeArgs(userId));
    expect(result.kind).toBe('inserted');
    if (result.kind !== 'inserted') throw new Error('unreachable');

    // The turn committed despite the capture throwing.
    const conv = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, result.conversationId));
    expect(conv).toHaveLength(1);
  });
});
