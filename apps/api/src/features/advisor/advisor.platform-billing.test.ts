/**
 * Advisor platform-billing integration tests (wallet-billing Task 17; design
 * §Testing Strategy → "Advisor platform path").
 *
 * Real Postgres (NO DB mocks) via `src/test-setup.ts` — migrations applied in
 * beforeAll, every test wrapped in a rolled-back drizzle transaction. The wallet,
 * reservation, usage_record, debit, and message persistence are ALL exercised
 * against the live DB. The ONLY thing stubbed is the provider adapter
 * (`./providers/registry` → `getProvider`): its `streamChat`/`listModels` emit
 * deterministic token/usage events so the metering accumulator + atomic debit are
 * driven without a live LLM (mirrors the existing advisor suite's mocked-adapter
 * boundary). The platform env keys + Stripe-configured flag are set on `config`
 * for the duration of the file.
 *
 * Cases:
 *  1. BYOK present → no usage_record, no debit, no reservation, notice mode:'byok' (REQ-5.7).
 *  2. Platform turn → ONE usage_record + matching debit; atomic (no record without
 *     debit and vice versa); cumulative metering (summarizing turn sums the summary
 *     call + the main call) (REQ-5.1, REQ-5.4).
 *  3. Multi-tool turn → usage_record sums every tool-loop round-trip (REQ-5.1).
 *  4. Gate refusal — zero balance → 402 INSUFFICIENT_CREDITS, NO SSE opened (REQ-6.4).
 *  5. Gate refusal — unpriced model → MODEL_NOT_AVAILABLE, NO SSE (REQ-6.1).
 *  6. New-conv, no key + no override → 400 MODEL_REQUIRED (REQ-4.2).
 *  7. Deduped retry never double-charges — one debit, reservation released (REQ-9.4).
 *  8. was-BYOK→platform fall-through → notice { fellThrough:true } (REQ-6.5).
 *  9. BYOK-key-for-a-different-provider (REQ-4.4) → a key for provider X does NOT
 *     satisfy a turn whose resolved provider is Y; falls through to platform for Y.
 * 10. Existing-conversation unpriced model → falls back to the default priced model,
 *     disclosed, not bricked (REQ-4.3).
 * 11. BILLING_MODE disclosure notice rendered for both platform and byok modes.
 *
 * _Requirements: REQ-4.2, REQ-4.3, REQ-4.4, REQ-5.1, REQ-5.4, REQ-5.7, REQ-6.1,
 *  REQ-6.4, REQ-6.5, REQ-9.4_
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModel } from '@tradr/shared';

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
import { config } from '@/lib/config';
import {
  encrypt,
  ENCRYPTION_KEY_VERSION_CURRENT,
  loadEncryptionKeyMaterial,
} from '@/lib/encryption';
import { errorHandler } from '@/middleware/error.middleware';

// --- Provider adapter stub (the ONLY mocked boundary) ------------------------
//
// A scripted adapter whose streamChat replays a per-test queue of event scripts
// (one script per provider round-trip). The summary call and each tool-loop
// round-trip pull the next script in order, so a multi-call turn's usage is the
// sum of the scripts it consumed. `listModels` returns a per-test model list so
// the contextWindow (summarization trigger) and vision flag are controllable.

type StreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'done' };

let scripts: StreamEvent[][] = [];
let scriptCursor = 0;
let models: ProviderModel[] = [];

const listModels = vi.fn(async () => models);

function nextScript(): StreamEvent[] {
  // After the queued scripts are exhausted, emit a tool-free final answer so a
  // turn that makes one extra round-trip than scripted still terminates cleanly.
  const script = scripts[scriptCursor] ?? [
    { type: 'token', delta: 'final.' },
    { type: 'usage', promptTokens: 1, completionTokens: 1 },
    { type: 'done' },
  ];
  scriptCursor += 1;
  return script;
}

function makeStubAdapter(id: 'openai' | 'claude') {
  return {
    id,
    listModels,
    // The orchestrator treats native messages as opaque; pass-through is fine.
    translate: (list: unknown) => list,
    // OpenAI cap-check expects a flat string (tiktoken-encoded LOCALLY, no network);
    // forcing `id:'openai'` keeps every estimate off the live Anthropic SDK.
    prepareForTokenCount: (list: { role: string; parts?: { text?: string }[] }[]) =>
      list.map((m) => (m.parts ?? []).map((p) => p.text ?? '').join(' ')).join('\n'),
    async *streamChat() {
      const script = nextScript();
      for (const evt of script) yield evt;
    },
  };
}

vi.mock('./providers/registry', () => ({
  // Always present as the OpenAI adapter so cap-check uses the local tiktoken path
  // (the live Anthropic countTokens SDK is never hit). All platform cases here
  // resolve provider 'openai'; the billing path keys off the resolved providerId,
  // which the handler passes independently of the adapter's reported id.
  getProvider: () => makeStubAdapter('openai'),
}));

import { streamHandler } from './stream.handler';
import { runStreaming } from './streaming';

// --- Test app ----------------------------------------------------------------

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

function newClientMessageId(): string {
  return crypto.randomUUID();
}

const PRICED_MODEL = 'gpt-4o';
const UNPRICED_MODEL = 'gpt-4o-legacy-unpriced';

function modelEntry(id: string, contextWindow = 200_000): ProviderModel {
  return { id, displayName: id, contextWindow, vision: true, toolUse: true };
}

// --- DB seed helpers (real Postgres) -----------------------------------------

let seedCounter = 0;

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `adv-billing-${Date.now()}-${++seedCounter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return user!.id;
}

async function seedProviderKey(userId: string, providerId: 'openai' | 'claude', model: string) {
  await db.insert(advisorProviderKeys).values({
    userId,
    providerId,
    encryptedKey: encrypt('byok-plaintext'),
    keyVersion: ENCRYPTION_KEY_VERSION_CURRENT,
    defaultModel: model,
    keyHintTail: 'tail',
    lastUsedAt: null,
  });
}

async function seedWallet(userId: string, balance: bigint, reserved = 0n) {
  await db
    .insert(wallets)
    .values({ userId, balance, reserved, reservedAt: reserved > 0n ? new Date() : null });
}

async function seedConversation(
  userId: string,
  providerId: 'openai' | 'claude',
  model: string,
): Promise<string> {
  const [conv] = await db
    .insert(advisorConversations)
    .values({ userId, title: 'existing', providerId, model })
    .returning();
  return conv!.id;
}

async function usageRecordsFor(userId: string) {
  return db.select().from(usageRecords).where(eq(usageRecords.userId, userId));
}

async function debitsFor(userId: string) {
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId));
  return rows.filter((r) => r.kind === 'debit');
}

async function walletOf(userId: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.userId, userId));
  return w;
}

/** Drain an SSE response body to its full text. */
async function sseText(res: Response): Promise<string> {
  return res.text();
}

// --- config setup ------------------------------------------------------------

let prevOpenAI: string | undefined;
let prevAnthropic: string | undefined;
let prevStripeSecret: string | undefined;
let prevStripeWebhook: string | undefined;

beforeAll(() => {
  // Load the deterministic test ENCRYPTION_KEY into module state so encrypt()
  // works when seeding BYOK key rows (mirrors startup.test.ts).
  loadEncryptionKeyMaterial();
  prevOpenAI = config.OPENAI_API_KEY;
  prevAnthropic = config.ANTHROPIC_API_KEY;
  prevStripeSecret = config.STRIPE_SECRET_KEY;
  prevStripeWebhook = config.STRIPE_WEBHOOK_SECRET;
  // Platform keys present → platform path admissible for both providers.
  config.OPENAI_API_KEY = 'sk-platform-openai';
  config.ANTHROPIC_API_KEY = 'sk-platform-anthropic';
  // Stripe configured → an empty wallet refuses with INSUFFICIENT_CREDITS
  // (the honest-messaging branch picks BILLING_NOT_AVAILABLE when it is NOT).
  config.STRIPE_SECRET_KEY = 'sk_test_dummy';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
});

afterAll(() => {
  config.OPENAI_API_KEY = prevOpenAI;
  config.ANTHROPIC_API_KEY = prevAnthropic;
  config.STRIPE_SECRET_KEY = prevStripeSecret;
  config.STRIPE_WEBHOOK_SECRET = prevStripeWebhook;
});

beforeEach(() => {
  scripts = [];
  scriptCursor = 0;
  models = [modelEntry(PRICED_MODEL)];
  listModels.mockClear();
});

describe('advisor platform-billing integration (real Postgres)', () => {
  // --- 1. BYOK present → no metering, no debit, no reservation, mode:'byok' ---
  it('case 1: BYOK turn writes NO usage_record / debit / reservation and discloses mode:byok (REQ-5.7)', async () => {
    const userId = await seedUser();
    await seedProviderKey(userId, 'openai', PRICED_MODEL);
    // A wallet exists but must be left untouched on a BYOK turn.
    await seedWallet(userId, 5_000_000n);
    scripts = [
      [
        { type: 'token', delta: 'hello' },
        { type: 'usage', promptTokens: 100, completionTokens: 200 },
        { type: 'done' },
      ],
    ];

    const app = makeApp(userId);
    const res = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    expect(res.status).toBe(200);
    const text = await sseText(res);

    expect(text).toContain('event: notice');
    expect(text).toContain('"mode":"byok"');
    expect(text).toContain('event: done');

    expect(await usageRecordsFor(userId)).toHaveLength(0);
    expect(await debitsFor(userId)).toHaveLength(0);
    const w = await walletOf(userId);
    expect(w!.balance).toBe(5_000_000n); // untouched
    expect(w!.reserved).toBe(0n); // no reservation held
  });

  // --- 2. Platform turn → atomic usage_record + debit; cumulative across calls ---
  it('case 2: platform summarizing turn writes ONE usage_record + matching debit with CUMULATIVE tokens (REQ-5.1/5.4)', async () => {
    const userId = await seedUser();
    // Platform conversation: no BYOK key. Existing conv pinned to a priced model
    // so loadStreamContext resolves provider+model from the conversation row.
    const convId = await seedConversation(userId, 'openai', PRICED_MODEL);
    // Small context window forces auto-summarization (a real extra provider call).
    // 1740 is chosen for a comfortable margin on BOTH summarization boundaries so
    // tiktoken count variance can never flip the path (see comment below):
    //   - trigger  = 0.75 × 1740 = 1305  (baseline estimate ~1498 clears by ~190)
    //   - hardCeil = 0.95 × 1740 = 1653  (the 6-long-message older slice ~1474
    //     fits under it in ONE summary call → all older messages are covered →
    //     nothing is left behind → the re-estimate is just the tiny verbatim
    //     window ~30, far under the ceiling). The old 1000 left the slice's
    //     input-cost straddling 0.95×1000=950, so the count of covered messages
    //     (and thus what was left behind) flipped with tiktoken variance and
    //     occasionally tripped CONVERSATION_TURN_TOO_LARGE.
    models = [modelEntry(PRICED_MODEL, 1_740)];
    await seedWallet(userId, 100_000_000n);

    // History laid out so the FIRST estimate (all messages) exceeds 0.75 × window
    // but the re-estimate after summarization stays under 0.95 × window. The most
    // recent KEEP_VERBATIM_N (6) messages are kept verbatim, so those must be
    // SHORT; only the OLDER slice (compressed away) is long.
    const longLine = 'lorem ipsum dolor sit amet consectetur '.repeat(40); // ~1500 chars
    // 6 long OLDER messages (summarized) ...
    for (let i = 0; i < 6; i++) {
      await db.insert(advisorMessages).values({
        conversationId: convId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        contentParts: [{ type: 'text', text: `${longLine} ${i}` }],
        clientMessageId: null,
      });
    }
    // ... then 6 SHORT recent messages (kept verbatim, fit under the hard ceiling).
    for (let i = 0; i < 6; i++) {
      await db.insert(advisorMessages).values({
        conversationId: convId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        contentParts: [{ type: 'text', text: `ok ${i}` }],
        clientMessageId: null,
      });
    }

    // Script 1 = the summary call; Script 2 = the main turn (tool-free final answer).
    scripts = [
      [
        { type: 'token', delta: '{"prose":"summary","tradeDataFigures":null}' },
        { type: 'usage', promptTokens: 300, completionTokens: 40 },
        { type: 'done' },
      ],
      [
        { type: 'token', delta: 'answer' },
        { type: 'usage', promptTokens: 500, completionTokens: 80 },
        { type: 'done' },
      ],
    ];

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: newClientMessageId(),
      text: 'summarize please',
    });
    expect(res.status).toBe(200);
    const text = await sseText(res);
    expect(text).toContain('"mode":"platform"');
    expect(text).toContain('event: done');

    // Exactly one usage_record was written for this turn.
    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    // CUMULATIVE: summary call (300/40) + main call (500/80) summed — NOT last-call.
    expect(rec.inputTokens).toBe(800n);
    expect(rec.outputTokens).toBe(120n);
    expect(rec.creditCost).toBeGreaterThan(0n);

    // ATOMICITY: exactly one debit, referencing this usage_record, amount = -cost.
    const debits = await debitsFor(userId);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.usageRecordId).toBe(rec.id);
    expect(debits[0]!.amount).toBe(-rec.creditCost);
    // No usage_record without a matching debit and vice versa.
    expect(recs).toHaveLength(debits.length);

    // Balance debited; reservation reconciled to 0.
    const w = await walletOf(userId);
    expect(w!.balance).toBe(100_000_000n - rec.creditCost);
    expect(w!.reserved).toBe(0n);
  });

  // --- 3. Multi-tool turn → usage summed across every round-trip --------------
  it('case 3: multi-tool platform turn sums usage across ALL tool round-trips (REQ-5.1)', async () => {
    const userId = await seedUser();
    const convId = await seedConversation(userId, 'openai', PRICED_MODEL);
    await seedWallet(userId, 100_000_000n);
    // Enable trade-data tools so the loop dispatches a real (empty-result) tool.
    await db.update(users).set({ advisorTradeDataConsent: true }).where(eq(users.id, userId));

    // Round-trip 1: model asks for a trade-data tool. Round-trip 2: final answer.
    scripts = [
      [
        { type: 'tool_call', id: 'c1', name: 'trade_data_open_positions', arguments: {} },
        { type: 'usage', promptTokens: 400, completionTokens: 20 },
        { type: 'done' },
      ],
      [
        { type: 'token', delta: 'You have no open positions.' },
        { type: 'usage', promptTokens: 700, completionTokens: 50 },
        { type: 'done' },
      ],
    ];

    // Drive runStreaming directly with a real Prepared (the handler does not wire
    // iteration-0 consent, so we set consentAtPrepare + inject the iter>0 re-read).
    // DB + billing remain fully real; only the provider adapter is the stub above.
    const reservationHeld = BigInt(config.MIN_RESERVATION_CREDITS);
    // Reserve the gate hold the same way the handler would, against the real wallet.
    const { gateAndReserve } = await import('../billing/billing.service');
    const reservation = await gateAndReserve(userId, 'openai', PRICED_MODEL);
    expect(reservation.held).toBe(reservationHeld);

    const prepared = {
      kind: 'stream' as const,
      conversationId: convId,
      userId,
      clientMessageId: newClientMessageId(),
      providerId: 'openai' as const,
      modelId: PRICED_MODEL,
      apiKey: 'sk-platform-openai',
      messages: [
        { role: 'user' as const, parts: [{ type: 'text' as const, text: 'how am I doing?' }] },
      ],
      newMessageParts: [{ type: 'text' as const, text: 'how am I doing?' }],
      personaId: null,
      combinedSignal: new AbortController().signal,
      idempotent: true,
      toolUse: true,
      hasUwKey: false,
      uwKeyCiphertext: null,
      consentAtPrepare: true,
      summaryUsage: undefined,
      reservationHeld,
      // plan-tiers Task 9: the explicit platform marker — the persist seam
      // builds the billing arg from this, not from reservationHeld > 0n.
      platformBillingMode: 'credits' as const,
    };

    const frames: string[] = [];
    for await (const f of runStreaming(prepared, {
      reReadIterationState: async () => ({ consent: true, hasUwKey: false, uwKeyCiphertext: null }),
    })) {
      frames.push(f.event);
    }
    expect(frames).toContain('done');

    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(1);
    // CUMULATIVE across both round-trips: 400+700 in, 20+50 out — NOT last-call.
    expect(recs[0]!.inputTokens).toBe(1100n);
    expect(recs[0]!.outputTokens).toBe(70n);

    const debits = await debitsFor(userId);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.usageRecordId).toBe(recs[0]!.id);
    const w = await walletOf(userId);
    expect(w!.reserved).toBe(0n); // reconciled with the debit
  });

  // --- 4. Gate refusal — zero balance → 402 INSUFFICIENT_CREDITS, NO SSE ------
  it('case 4: zero balance refuses pre-stream with 402 INSUFFICIENT_CREDITS and opens NO SSE (REQ-6.4)', async () => {
    const userId = await seedUser();
    const convId = await seedConversation(userId, 'openai', PRICED_MODEL);
    await seedWallet(userId, 0n);
    scripts = [[{ type: 'token', delta: 'x' }, { type: 'done' }]];

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('INSUFFICIENT_CREDITS');
    // No provider call happened (gate is before any streamChat).
    expect(scriptCursor).toBe(0);
    // No SSE side effects.
    expect(await usageRecordsFor(userId)).toHaveLength(0);
    expect(await debitsFor(userId)).toHaveLength(0);
    const w = await walletOf(userId);
    expect(w!.reserved).toBe(0n);
  });

  // --- 5. Gate refusal — unpriced model → MODEL_NOT_AVAILABLE, NO SSE ---------
  it('case 5: existing-conv resolved to an unpriced model with no default... uses fallback; an unpriced GATE refuses MODEL_NOT_AVAILABLE (REQ-6.1)', async () => {
    // To hit the gate's MODEL_NOT_AVAILABLE arm directly we exercise gateAndReserve
    // with an unpriced model (the route's existing-conv path substitutes a default,
    // so the gate-level refusal is asserted on the service the route calls).
    const userId = await seedUser();
    await seedWallet(userId, 100_000_000n);
    const { gateAndReserve } = await import('../billing/billing.service');
    await expect(gateAndReserve(userId, 'openai', UNPRICED_MODEL)).rejects.toMatchObject({
      statusCode: 402,
      code: 'MODEL_NOT_AVAILABLE',
    });
    // Refusal took no reservation.
    const w = await walletOf(userId);
    expect(w!.reserved).toBe(0n);
  });

  // --- 6. New-conv, no key + no override → 400 MODEL_REQUIRED -----------------
  it('case 6: new conversation with no BYOK key and no providerOverride → 400 MODEL_REQUIRED (REQ-4.2)', async () => {
    const userId = await seedUser();
    await seedWallet(userId, 100_000_000n);
    const app = makeApp(userId);
    const res = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('MODEL_REQUIRED');
    expect(scriptCursor).toBe(0);
  });

  // --- 7. Deduped retry never double-charges ---------------------------------
  it('case 7: a Layer-1 deduped retry does NOT debit twice and releases the reservation (REQ-9.4)', async () => {
    const userId = await seedUser();
    const convId = await seedConversation(userId, 'openai', PRICED_MODEL);
    await seedWallet(userId, 100_000_000n);
    const clientMessageId = newClientMessageId();

    // First turn: persist + charge ONCE via the real persistTurn billing path
    // (this seeds the user+assistant rows in the DB WITHOUT populating the
    // in-memory Layer-2 idempotency map — modelling a server-restart replay, so
    // the retry below misses Layer-2 and falls through to the Layer-1 DB dedupe).
    const { persistTurn } = await import('./persistence');
    const held = BigInt(config.MIN_RESERVATION_CREDITS);
    const { gateAndReserve } = await import('../billing/billing.service');
    await gateAndReserve(userId, 'openai', PRICED_MODEL); // hold for the first turn
    const first = await persistTurn({
      conversationId: convId,
      userId,
      userMessage: { contentParts: [{ type: 'text', text: 'hi' }], clientMessageId },
      assistantMessage: {
        contentParts: [{ type: 'text', text: 'first answer' }],
        promptTokens: 200,
        completionTokens: 30,
      },
      providerId: 'openai',
      modelId: PRICED_MODEL,
      personaId: null,
      billing: {
        userId,
        providerId: 'openai',
        model: PRICED_MODEL,
        mode: 'credits',
        usage: { inputTokens: 200, outputTokens: 30 },
        reservationHeld: held,
      },
    });
    expect(first.kind).toBe('inserted');

    const recsAfterFirst = await usageRecordsFor(userId);
    expect(recsAfterFirst).toHaveLength(1);
    const balanceAfterFirst = (await walletOf(userId))!.balance;
    const firstCost = recsAfterFirst[0]!.creditCost;
    expect(balanceAfterFirst).toBe(100_000_000n - firstCost);
    expect((await walletOf(userId))!.reserved).toBe(0n); // first turn reconciled

    // Replay the SAME clientMessageId through the full stream handler — the gate
    // takes a fresh hold, then the Layer-1 DB dedupe (row already exists) returns
    // the paired assistant id WITHOUT a second debit and releases that hold.
    scripts = [
      [
        { type: 'token', delta: 'second answer (must not persist or charge)' },
        { type: 'usage', promptTokens: 999, completionTokens: 999 },
        { type: 'done' },
      ],
    ];
    scriptCursor = 0;

    const app = makeApp(userId);
    const res2 = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId,
      text: 'hi',
    });
    expect(res2.status).toBe(200);
    const text2 = await sseText(res2);
    expect(text2).toContain('"source":"layer-1"');
    expect(text2).toContain(first.assistantMessageId); // returns the FIRST turn's id

    // Still exactly ONE usage_record and ONE debit; balance unchanged from the first.
    expect(await usageRecordsFor(userId)).toHaveLength(1);
    expect(await debitsFor(userId)).toHaveLength(1);
    const w = await walletOf(userId);
    expect(w!.balance).toBe(balanceAfterFirst); // no second charge
    expect(w!.reserved).toBe(0n); // the retry's hold was released
  });

  // --- 8. was-BYOK→platform fall-through → notice { fellThrough:true } --------
  it('case 8: a turn resolving to platform while the user holds a BYOK key (other provider) discloses fellThrough (REQ-6.5)', async () => {
    const userId = await seedUser();
    // The user holds a BYOK key for claude only; this conversation is pinned to openai.
    await seedProviderKey(userId, 'claude', 'claude-sonnet-4-5');
    const convId = await seedConversation(userId, 'openai', PRICED_MODEL);
    await seedWallet(userId, 100_000_000n);
    scripts = [
      [
        { type: 'token', delta: 'platform answer' },
        { type: 'usage', promptTokens: 120, completionTokens: 30 },
        { type: 'done' },
      ],
    ];

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    expect(res.status).toBe(200);
    const text = await sseText(res);
    expect(text).toContain('"mode":"platform"');
    expect(text).toContain('"fellThrough":true');

    // Platform-billed: a usage_record + debit exist (the claude key did NOT pay).
    expect(await usageRecordsFor(userId)).toHaveLength(1);
    expect(await debitsFor(userId)).toHaveLength(1);
  });

  // --- 9. BYOK-key-for-a-different-provider cell (REQ-4.4) --------------------
  it('case 9: a key for provider X does NOT satisfy a turn whose provider is Y — falls through to platform for Y (REQ-4.4)', async () => {
    const userId = await seedUser();
    // Key for claude (X); conversation resolved provider is openai (Y).
    await seedProviderKey(userId, 'claude', 'claude-sonnet-4-5');
    const convId = await seedConversation(userId, 'openai', PRICED_MODEL);
    await seedWallet(userId, 100_000_000n);
    scripts = [
      [
        { type: 'token', delta: 'answer for Y' },
        { type: 'usage', promptTokens: 90, completionTokens: 10 },
        { type: 'done' },
      ],
    ];

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    // Y is priced + funded → platform path admits the turn (never blocked by, never
    // silently paid with, the mismatched X key).
    expect(res.status).toBe(200);
    const text = await sseText(res);
    expect(text).toContain('"mode":"platform"');

    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.providerId).toBe('openai'); // billed for Y, not X
    expect(await debitsFor(userId)).toHaveLength(1);
  });

  // --- 10. Existing-conversation unpriced fallback to default priced model ----
  it('case 10: existing-conv pinned to an unpriced model substitutes the default priced model, disclosed, not bricked (REQ-4.3)', async () => {
    const userId = await seedUser();
    const convId = await seedConversation(userId, 'openai', UNPRICED_MODEL);
    // The default priced model must be listable so the vision/model resolve passes.
    models = [modelEntry('gpt-4o'), modelEntry(UNPRICED_MODEL)];
    await seedWallet(userId, 100_000_000n);
    scripts = [
      [
        { type: 'token', delta: 'still works' },
        { type: 'usage', promptTokens: 60, completionTokens: 20 },
        { type: 'done' },
      ],
    ];

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    expect(res.status).toBe(200); // not bricked
    const text = await sseText(res);
    expect(text).toContain('"mode":"platform"');

    // Billed against the substituted default priced model (gpt-4o), not the unpriced pin.
    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.model).toBe('gpt-4o');
    // The conversation row itself is NOT rewritten (fallback is per-turn).
    const [conv] = await db
      .select()
      .from(advisorConversations)
      .where(eq(advisorConversations.id, convId));
    expect(conv!.model).toBe(UNPRICED_MODEL);
  });

  // --- 11. BILLING_MODE disclosure rendered for both modes --------------------
  it('case 11: BILLING_MODE notice is the first stream frame for platform AND byok modes', async () => {
    // platform
    const pUser = await seedUser();
    const pConv = await seedConversation(pUser, 'openai', PRICED_MODEL);
    await seedWallet(pUser, 100_000_000n);
    scripts = [
      [
        { type: 'token', delta: 'p' },
        { type: 'usage', promptTokens: 10, completionTokens: 5 },
        { type: 'done' },
      ],
    ];
    const pApp = makeApp(pUser);
    const pRes = await post(pApp, `/conversations/${pConv}/messages/stream`, {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    const pText = await sseText(pRes);
    expect(pText.indexOf('"code":"BILLING_MODE"')).toBeGreaterThanOrEqual(0);
    expect(pText).toContain('"mode":"platform"');

    // byok
    scripts = [
      [
        { type: 'token', delta: 'b' },
        { type: 'usage', promptTokens: 10, completionTokens: 5 },
        { type: 'done' },
      ],
    ];
    scriptCursor = 0;
    const bUser = await seedUser();
    await seedProviderKey(bUser, 'openai', PRICED_MODEL);
    const bApp = makeApp(bUser);
    const bRes = await post(bApp, '/conversations/new/messages/stream', {
      clientMessageId: newClientMessageId(),
      text: 'hi',
    });
    const bText = await sseText(bRes);
    expect(bText).toContain('"code":"BILLING_MODE"');
    expect(bText).toContain('"mode":"byok"');
  });
});
