/**
 * Advisor tier-gating end-to-end integration tests (plan-tiers Task 13; design
 * D10/D12/D17 — L4 allowance/credits split + L5 image quota in the stream
 * handler; `advisorTurnGate` retired).
 *
 * Real Postgres (NO DB mocks) via `src/test-setup.ts` — every test wrapped in a
 * rolled-back drizzle transaction. The stream endpoints mount `streamHandler`
 * directly, exactly as advisor.route.ts does after the gate retirement (the
 * in-memory `perUserRateLimit` is omitted as in the platform-billing
 * precedent), so the tier-context read, the L4/L5 checks, the stream pipeline,
 * and the `persistTurn` counter increments are ALL exercised against the live
 * DB. The ONLY mocked boundary is the provider adapter
 * (`./providers/registry`) — scripted token/usage events, no live LLM.
 * `captureServerEvent` is spied (fire-and-forget analytics, D17). Config is
 * toggled by direct `config` mutation, restored in beforeEach/afterAll. Free
 * tier throughout (no subscription rows), so the caps are
 * `getTierLimits('free')`.
 *
 * Cases:
 *  1. Allowance turn end-to-end: NO wallet row, Stripe UNCONFIGURED → 200; a
 *     `creditCost 0` usage record with the TRUE rawCost; no debit, no wallet
 *     created; turn_count AND allowance_turns advance; the BILLING_MODE notice
 *     still says 'platform' (credential-source wire contract) (REQ-8.1/8.5/8.6).
 *  2. Boundary + overflow: allowance_turns = limit−1 → the limit-th turn is
 *     allowance-billed; the next is credit-billed BYTE-IDENTICAL to today's
 *     debit path (debit ↔ usage record, reservation reconciled), allowance_turns
 *     frozen at the limit; `allowance_credits_fallback` fires on the overflow
 *     turn only (REQ-8.2, REQ-13.1).
 *  3. Allowance exhausted + credits insufficient on the allowance model →
 *     pre-stream 402 ALLOWANCE_EXHAUSTED + tier_limit_hit{platformTurns} (D12).
 *  4. Credits insufficient on a NON-allowance model with allowance headroom →
 *     402 INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE disclosing the allowance
 *     model + tier_limit_hit{platformTurns} (D12, REQ-8.9c).
 *  5. Credits insufficient on a non-allowance model with NO headroom → plain
 *     402 INSUFFICIENT_CREDITS, unenriched, no tier_limit_hit (D12).
 *  6. BYOK turns are never counted and never refused by any tier gate —
 *     at-limit counters + empty wallet are irrelevant (REQ-8.3).
 *  7. L5 platform: an exact-fit image turn commits (counter advances); the next
 *     image turn refuses 403 TIER_LIMIT_IMAGES + tier_limit_hit{images} (REQ-9.1/9.2).
 *  8. L5: text-only turns pass AT the image limit (REQ-9.2).
 *  9. L5 BYOK: images on committed BYOK turns are counted (turn_count is not);
 *     an over-quota BYOK image turn refuses 403 TIER_LIMIT_IMAGES (REQ-9.1).
 * 10. Gating OFF → exactly today: platform turns wallet-billed even on the
 *     allowance model, no image quota, allowance_turns untouched (REQ-8.8).
 * 11. Gating OFF + Stripe unconfigured + empty wallet → 402 BILLING_NOT_AVAILABLE
 *     (the pre-existing honest posture, untouched) (REQ-8.8).
 * 12. Admin exempt: gating ON, every counter at/over its cap → 200, credit-billed
 *     as today; no allowance concept for exempt users (REQ-6.5-doctrine).
 * 13. A deduped Layer-1 replay of an allowance turn does NOT double-count either
 *     counter or duplicate the usage record (REQ-9.1 dedupe inheritance).
 * 14. Deleting a conversation does NOT reset the counters — the exhausted-state
 *     refusal survives deletion (non-evasion).
 *
 * _Requirements: REQ-8.1–8.8, REQ-9.1–9.4, REQ-13.1_
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModel } from '@tradr/shared';

import { db } from '@/db';
import {
  advisorConversations,
  advisorImageCounters,
  advisorProviderKeys,
  advisorTurnCounters,
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
import { priceTurnUsageParts } from '@/features/billing/pricing';
import { ALLOWANCE_MODEL, getTierLimits } from '@/features/billing/tier-limits.constants';
import { config } from '@/lib/config';
import {
  encrypt,
  ENCRYPTION_KEY_VERSION_CURRENT,
  loadEncryptionKeyMaterial,
} from '@/lib/encryption';
import * as posthog from '@/lib/posthog';
import { errorHandler } from '@/middleware/error.middleware';

// --- Provider adapter stub (the ONLY mocked boundary) ------------------------
// Mirrors advisor.platform-billing.test.ts: streamChat replays a per-test queue
// of event scripts; listModels returns a per-test model list.

type StreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null }
  | { type: 'done' };

let scripts: StreamEvent[][] = [];
let scriptCursor = 0;
let models: ProviderModel[] = [];

function nextScript(): StreamEvent[] {
  const script = scripts[scriptCursor] ?? [
    { type: 'token', delta: 'final.' },
    { type: 'usage', promptTokens: 1, completionTokens: 1 },
    { type: 'done' },
  ];
  scriptCursor += 1;
  return script;
}

vi.mock('./providers/registry', () => ({
  getProvider: () => ({
    id: 'openai',
    listModels: async () => models,
    translate: (list: unknown) => list,
    prepareForTokenCount: (list: { role: string; parts?: { text?: string }[] }[]) =>
      list.map((m) => (m.parts ?? []).map((p) => p.text ?? '').join(' ')).join('\n'),
    async *streamChat() {
      const script = nextScript();
      for (const evt of script) yield evt;
    },
  }),
}));

import { deleteConversationOwned } from './advisor.query';
import { streamHandler } from './stream.handler';

// --- Test app: the REAL stream-endpoint chain (post-Task-13: handler only) ----

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

function makeApp(userId: string, isAdmin = false) {
  const app = new Hono<AuthEnv>();
  app.use(async (c, next) => {
    c.set('userId', userId);
    c.set('isAdmin', isAdmin);
    await next();
  });
  // streamHandler directly — the advisorTurnGate middleware is retired (D9);
  // all tier logic lives inside the handler now, exactly as advisor.route.ts mounts it.
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

// ALLOWANCE_MODEL['openai'] — the allowance-eligible model for the stubbed provider.
// (Non-null: the Partial map — BYOK-only providers carry no entry — is pinned
// to cover openai by tier-limits.constants.test.ts.)
const ALLOWANCE = ALLOWANCE_MODEL.openai!;
// A priced OpenAI model that is NOT the allowance designation (pricing.ts RATE_TABLE).
const NON_ALLOWANCE = 'gpt-4o-mini';
// Free-tier caps (no subscription rows are seeded, so every non-admin user is free).
const TURN_LIMIT = getTierLimits('free').platformTurns!;
const IMAGE_LIMIT = getTierLimits('free').images!;

function modelEntry(id: string, contextWindow = 200_000): ProviderModel {
  return { id, displayName: id, contextWindow, vision: true, toolUse: true };
}

/** Tiny opaque "png" payload — stripImageMetadata passes unknown bytes through. */
function pngBytes(n = 12): string {
  return Buffer.alloc(n, 7).toString('base64');
}
function imageAttachment() {
  return { type: 'image', format: 'png', dataBase64: pngBytes() };
}

// --- DB seed helpers (real Postgres) -----------------------------------------

let seedCounter = 0;

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `adv-gating-${Date.now()}-${++seedCounter}@example.com`,
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
    defaultModel: ALLOWANCE,
    keyHintTail: 'tail',
    lastUsedAt: null,
  });
}

async function seedWallet(userId: string, balance: bigint) {
  await db.insert(wallets).values({ userId, balance, reserved: 0n, reservedAt: null });
}

async function seedConversation(userId: string, model = ALLOWANCE): Promise<string> {
  const [conv] = await db
    .insert(advisorConversations)
    .values({ userId, title: 'existing', providerId: 'openai', model })
    .returning();
  return conv!.id;
}

/** Seed the turn counter row for the CURRENT UTC period. */
async function seedTurnCounters(userId: string, turnCount: number, allowanceTurns = turnCount) {
  await db
    .insert(advisorTurnCounters)
    .values({ userId, periodKey: currentPeriodKeyUtc(), turnCount, allowanceTurns });
}

/** Seed the image counter row for the CURRENT UTC period. */
async function seedImageCount(userId: string, imageCount: number) {
  await db
    .insert(advisorImageCounters)
    .values({ userId, periodKey: currentPeriodKeyUtc(), imageCount });
}

async function turnCount(userId: string): Promise<number> {
  return getTurnCount(db, userId, currentPeriodKeyUtc());
}
async function allowanceCount(userId: string): Promise<number> {
  return getAllowanceUsage(db, userId, currentPeriodKeyUtc());
}
async function imageCount(userId: string): Promise<number> {
  return getImageCount(db, userId, currentPeriodKeyUtc());
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

const SINGLE_TURN_SCRIPT: StreamEvent[][] = [
  [
    { type: 'token', delta: 'answer' },
    { type: 'usage', promptTokens: 100, completionTokens: 200 },
    { type: 'done' },
  ],
];

// --- config + spy setup -------------------------------------------------------

let prevOpenAI: string | undefined;
let prevAnthropic: string | undefined;
let prevStripeSecret: string | undefined;
let prevStripeWebhook: string | undefined;
let prevGating: boolean;

let captureSpy: ReturnType<typeof vi.spyOn>;
/** Calls to captureServerEvent with the given event name. */
function captured(event: string) {
  return captureSpy.mock.calls.filter((call) => call[0] === event);
}

beforeAll(() => {
  loadEncryptionKeyMaterial();
  prevOpenAI = config.OPENAI_API_KEY;
  prevAnthropic = config.ANTHROPIC_API_KEY;
  prevStripeSecret = config.STRIPE_SECRET_KEY;
  prevStripeWebhook = config.STRIPE_WEBHOOK_SECRET;
  prevGating = config.FEATURE_GATING;
});

afterAll(() => {
  config.OPENAI_API_KEY = prevOpenAI;
  config.ANTHROPIC_API_KEY = prevAnthropic;
  config.STRIPE_SECRET_KEY = prevStripeSecret;
  config.STRIPE_WEBHOOK_SECRET = prevStripeWebhook;
  config.FEATURE_GATING = prevGating;
});

beforeEach(() => {
  scripts = [];
  scriptCursor = 0;
  models = [modelEntry(ALLOWANCE), modelEntry(NON_ALLOWANCE)];
  // Baseline posture — each test states its own deviations explicitly:
  // platform keys present (platform path admissible), Stripe configured (an
  // empty wallet refuses INSUFFICIENT_CREDITS, not BILLING_NOT_AVAILABLE).
  config.OPENAI_API_KEY = 'sk-platform-openai';
  config.ANTHROPIC_API_KEY = 'sk-platform-anthropic';
  config.STRIPE_SECRET_KEY = 'sk_test_dummy';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
  config.FEATURE_GATING = false;
  // Fire-and-forget analytics (D17): spied, never sent.
  captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});
});

afterEach(() => {
  captureSpy.mockRestore();
});

describe('advisor tier gating end-to-end (real Postgres, real stream pipeline)', () => {
  // --- 1. Allowance turn: subsidized, no wallet, no Stripe ---------------------
  it('case 1: an allowance turn needs NO wallet and NO Stripe — creditCost 0 usage record with TRUE rawCost, both counters advance (REQ-8.1/8.5/8.6)', async () => {
    config.FEATURE_GATING = true;
    config.STRIPE_SECRET_KEY = undefined; // no Stripe requirement on the allowance path
    config.STRIPE_WEBHOOK_SECRET = undefined;
    const userId = await seedUser(); // deliberately NO wallet row
    const convId = await seedConversation(userId, ALLOWANCE);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The BILLING_MODE wire contract is a CREDENTIAL-SOURCE disclosure —
    // an allowance turn still reports mode:'platform' (D10).
    expect(text).toContain('"mode":"platform"');
    expect(text).toContain('event: done');

    // Subsidized usage record: creditCost 0, TRUE raw provider cost (REQ-8.5).
    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(1);
    const expected = priceTurnUsageParts({
      provider: 'openai',
      model: ALLOWANCE,
      inputTokens: 100,
      outputTokens: 200,
    });
    expect(recs[0]!.creditCost).toBe(0n);
    expect(recs[0]!.rawCost).toBe(expected.rawCost);
    expect(recs[0]!.inputTokens).toBe(100n);
    expect(recs[0]!.outputTokens).toBe(200n);

    // No debit, and no wallet was ever created or touched.
    expect(await debitsFor(userId)).toHaveLength(0);
    expect(await walletOf(userId)).toBeUndefined();

    // Both counters advanced (D11).
    expect(await turnCount(userId)).toBe(1);
    expect(await allowanceCount(userId)).toBe(1);
    // Not a fallback turn.
    expect(captured('allowance_credits_fallback')).toHaveLength(0);
  });

  // --- 2. Boundary + overflow to credits ---------------------------------------
  it('case 2: the limit-th turn is allowance-billed; the next overflows to the UNCHANGED credit path and emits allowance_credits_fallback (REQ-8.2, REQ-13.1)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedTurnCounters(userId, TURN_LIMIT - 1); // one turn of headroom left
    await seedWallet(userId, 100_000_000n);
    scripts = [SINGLE_TURN_SCRIPT[0]!, SINGLE_TURN_SCRIPT[0]!];

    const app = makeApp(userId);
    // Turn A — the last within-allowance turn.
    const resA = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'turn A',
    });
    expect(resA.status).toBe(200);
    await resA.text();
    expect(await allowanceCount(userId)).toBe(TURN_LIMIT);
    expect(await turnCount(userId)).toBe(TURN_LIMIT);
    expect((await walletOf(userId))!.balance).toBe(100_000_000n); // untouched
    expect(captured('allowance_credits_fallback')).toHaveLength(0);

    // Turn B — allowance exhausted: byte-identical credit path (REQ-8.2).
    const resB = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'turn B',
    });
    expect(resB.status).toBe(200);
    await resB.text();

    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(2);
    const creditRec = recs.find((r) => r.creditCost > 0n)!;
    const expected = priceTurnUsageParts({
      provider: 'openai',
      model: ALLOWANCE,
      inputTokens: 100,
      outputTokens: 200,
    });
    expect(creditRec.creditCost).toBe(expected.creditCost);
    expect(creditRec.rawCost).toBe(expected.rawCost);

    // Debit ↔ usage record atomicity + reservation reconciled — today's path.
    const debits = await debitsFor(userId);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.usageRecordId).toBe(creditRec.id);
    expect(debits[0]!.amount).toBe(-creditRec.creditCost);
    const w = await walletOf(userId);
    expect(w!.balance).toBe(100_000_000n - creditRec.creditCost);
    expect(w!.reserved).toBe(0n);

    // Overflow turns count turn_count but never allowance_turns.
    expect(await turnCount(userId)).toBe(TURN_LIMIT + 1);
    expect(await allowanceCount(userId)).toBe(TURN_LIMIT);

    // The free-taste→paying transition event, once, on the overflow turn (D17).
    const fallback = captured('allowance_credits_fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]![1]).toMatchObject({ distinctId: userId });
  });

  // --- 3. ALLOWANCE_EXHAUSTED -----------------------------------------------
  it('case 3: allowance exhausted + credits insufficient on the allowance model → pre-stream 402 ALLOWANCE_EXHAUSTED + tier_limit_hit (D12)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedTurnCounters(userId, TURN_LIMIT);
    await seedWallet(userId, 0n);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('ALLOWANCE_EXHAUSTED');
    expect(body.error.message).toContain(String(TURN_LIMIT));
    expect(body.error.message).toContain('(UTC)');
    // Terminal-for-state refusal doctrine: never 429, no Retry-After.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    expect(scriptCursor).toBe(0); // no provider call
    // Nothing reserved, nothing counted.
    expect((await walletOf(userId))!.reserved).toBe(0n);
    expect(await turnCount(userId)).toBe(TURN_LIMIT);
    const hits = captured('tier_limit_hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]![1]).toMatchObject({
      distinctId: userId,
      properties: { lever: 'platformTurns' },
    });
  });

  // --- 4. INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE -----------------------------
  it('case 4: credits insufficient on a NON-allowance model with allowance headroom → 402 INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE disclosing the allowance model (D12, REQ-8.9c)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, NON_ALLOWANCE);
    await seedWallet(userId, 0n); // headroom exists (no counter row)
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS_ALLOWANCE_AVAILABLE');
    expect(body.error.message).toContain(ALLOWANCE); // the free-turns disclosure
    expect(scriptCursor).toBe(0);
    const hits = captured('tier_limit_hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]![1]).toMatchObject({
      distinctId: userId,
      properties: { lever: 'platformTurns' },
    });
  });

  // --- 5. Plain INSUFFICIENT_CREDITS is untouched ------------------------------
  it('case 5: credits insufficient on a non-allowance model with NO headroom → plain 402 INSUFFICIENT_CREDITS, unenriched (D12)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, NON_ALLOWANCE);
    await seedTurnCounters(userId, TURN_LIMIT); // headroom exhausted
    await seedWallet(userId, 0n);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('INSUFFICIENT_CREDITS');
    // Not a D12 tier refusal — no tier_limit_hit.
    expect(captured('tier_limit_hit')).toHaveLength(0);
  });

  // --- 6. BYOK exemption --------------------------------------------------------
  it('case 6: BYOK turns are never counted and never refused by any tier gate — at-limit counters and an empty wallet are irrelevant (REQ-8.3)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    await seedProviderKey(userId);
    await seedTurnCounters(userId, TURN_LIMIT); // would refuse a platform turn
    await seedWallet(userId, 0n); // would 402 a platform turn
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"mode":"byok"');
    expect(text).toContain('event: done');

    // Counters untouched; no usage record; no debit; nothing reserved (REQ-8.3).
    expect(await turnCount(userId)).toBe(TURN_LIMIT);
    expect(await allowanceCount(userId)).toBe(TURN_LIMIT);
    expect(await usageRecordsFor(userId)).toHaveLength(0);
    expect(await debitsFor(userId)).toHaveLength(0);
    expect(captured('tier_limit_hit')).toHaveLength(0);
  });

  // --- 7. L5 image quota: exact fit commits, the next image turn refuses --------
  it('case 7: an exact-fit image turn commits and advances the counter; the NEXT image turn refuses 403 TIER_LIMIT_IMAGES pre-stream (REQ-9.1/9.2)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedImageCount(userId, IMAGE_LIMIT - 2);
    scripts = [SINGLE_TURN_SCRIPT[0]!, SINGLE_TURN_SCRIPT[0]!];

    const app = makeApp(userId);
    // Exact fit: committed (limit−2) + 2 attached = limit → admitted.
    const res1 = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'two charts',
      attachments: [imageAttachment(), imageAttachment()],
    });
    expect(res1.status).toBe(200);
    await res1.text();
    expect(await imageCount(userId)).toBe(IMAGE_LIMIT);

    // One over: committed (limit) + 1 attached > limit → pre-stream 403.
    const cursorBefore = scriptCursor;
    const res2 = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'one more chart',
      attachments: [imageAttachment()],
    });
    expect(res2.status).toBe(403);
    const body = await res2.json();
    expect(body.error.code).toBe('TIER_LIMIT_IMAGES');
    expect(body.error.message).toContain(String(IMAGE_LIMIT));
    expect(body.error.message).toContain('(UTC)');
    expect(res2.headers.get('retry-after')).toBeNull();
    expect(scriptCursor).toBe(cursorBefore); // no provider call
    expect(await imageCount(userId)).toBe(IMAGE_LIMIT); // refusal never counts
    const hits = captured('tier_limit_hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]![1]).toMatchObject({ distinctId: userId, properties: { lever: 'images' } });
  });

  // --- 8. L5: text-only turns unaffected -----------------------------------------
  it('case 8: text-only turns pass AT the image limit (REQ-9.2)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedImageCount(userId, IMAGE_LIMIT); // at the quota
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'no images here',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');
    expect(await imageCount(userId)).toBe(IMAGE_LIMIT); // unchanged
  });

  // --- 9. L5 applies to BYOK: counted AND enforced -------------------------------
  it('case 9: BYOK image turns are counted and refused over quota — L5 is a storage lever, not a billing lever (REQ-9.1)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    await seedProviderKey(userId);
    scripts = SINGLE_TURN_SCRIPT;

    // A committed BYOK image turn counts images (turn_count stays 0).
    const app = makeApp(userId);
    const res1 = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: crypto.randomUUID(),
      text: 'two charts on my own key',
      attachments: [imageAttachment(), imageAttachment()],
    });
    expect(res1.status).toBe(200);
    await res1.text();
    expect(await imageCount(userId)).toBe(2);
    expect(await turnCount(userId)).toBe(0);

    // Over-quota BYOK image turn refuses — the ONLY tier logic that can touch BYOK.
    await db
      .update(advisorImageCounters)
      .set({ imageCount: IMAGE_LIMIT - 1 })
      .where(eq(advisorImageCounters.userId, userId));
    const res2 = await post(app, '/conversations/new/messages/stream', {
      clientMessageId: crypto.randomUUID(),
      text: 'two more',
      attachments: [imageAttachment(), imageAttachment()],
    });
    expect(res2.status).toBe(403);
    expect((await res2.json()).error.code).toBe('TIER_LIMIT_IMAGES');
  });

  // --- 10. Gating OFF: platform turns wallet-billed exactly as today --------------
  it('case 10: gating OFF → no allowance, no image quota — the allowance-model turn is wallet-billed exactly as today (REQ-8.8)', async () => {
    config.FEATURE_GATING = false;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedImageCount(userId, IMAGE_LIMIT + 5); // over the (unenforced) quota
    await seedWallet(userId, 100_000_000n);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
      attachments: [imageAttachment()],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');

    // Wallet-billed: usage record with creditCost > 0 and a matching debit.
    const recs = await usageRecordsFor(userId);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.creditCost).toBeGreaterThan(0n);
    const debits = await debitsFor(userId);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBe(-recs[0]!.creditCost);
    expect((await walletOf(userId))!.balance).toBe(100_000_000n - recs[0]!.creditCost);

    // No allowance concept; counting stays always-on (turn + image counters).
    expect(await turnCount(userId)).toBe(1);
    expect(await allowanceCount(userId)).toBe(0);
    expect(await imageCount(userId)).toBe(IMAGE_LIMIT + 6);
    expect(captured('allowance_credits_fallback')).toHaveLength(0);
    expect(captured('tier_limit_hit')).toHaveLength(0);
  });

  // --- 11. Gating OFF + Stripe unconfigured: honest refusal untouched -------------
  it('case 11: gating OFF + Stripe unconfigured + empty wallet → 402 BILLING_NOT_AVAILABLE (pre-existing posture untouched) (REQ-8.8)', async () => {
    config.FEATURE_GATING = false;
    config.STRIPE_SECRET_KEY = undefined;
    config.STRIPE_WEBHOOK_SECRET = undefined;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedWallet(userId, 0n);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('BILLING_NOT_AVAILABLE');
    expect(scriptCursor).toBe(0);
  });

  // --- 12. Admin exemption ---------------------------------------------------------
  it('case 12: gating ON, admin over every cap → 200, credit-billed as today; no allowance concept for exempt users', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convId = await seedConversation(userId, ALLOWANCE);
    await seedTurnCounters(userId, TURN_LIMIT);
    await seedImageCount(userId, IMAGE_LIMIT + 5);
    await seedWallet(userId, 100_000_000n);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId, true); // isAdmin
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
      attachments: [imageAttachment()],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');

    // Credit-billed (enforced:false ⇒ no allowance), counters still advance.
    expect(await debitsFor(userId)).toHaveLength(1);
    expect(await turnCount(userId)).toBe(TURN_LIMIT + 1);
    expect(await allowanceCount(userId)).toBe(TURN_LIMIT); // unchanged
    expect(captured('tier_limit_hit')).toHaveLength(0);
  });

  // --- 13. Deduped replay of an allowance turn does not double-count ---------------
  it('case 13: a Layer-1 deduped replay of an allowance turn does NOT double-count either counter or duplicate the usage record', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser(); // no wallet — allowance turn
    const convId = await seedConversation(userId, ALLOWANCE);
    const clientMessageId = crypto.randomUUID();
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res = await post(app, `/conversations/${convId}/messages/stream`, {
      clientMessageId,
      text: 'hi',
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(await turnCount(userId)).toBe(1);
    expect(await allowanceCount(userId)).toBe(1);

    // Replay the SAME clientMessageId through the real persistTurn — bypassing
    // the in-memory Layer-2 map (server-restart model) so the Layer-1 DB dedupe
    // branch itself is exercised; it returns BEFORE any counter increment.
    const { persistTurn } = await import('./persistence');
    const replay = await persistTurn({
      conversationId: convId,
      userId,
      userMessage: { contentParts: [{ type: 'text', text: 'hi' }], clientMessageId },
      assistantMessage: {
        contentParts: [{ type: 'text', text: 'retry (must not count)' }],
        promptTokens: 1,
        completionTokens: 1,
      },
      providerId: 'openai',
      modelId: ALLOWANCE,
      personaId: null,
      billing: {
        userId,
        providerId: 'openai',
        model: ALLOWANCE,
        mode: 'allowance',
        usage: { inputTokens: 1, outputTokens: 1 },
        reservationHeld: 0n,
      },
    });
    expect(replay.kind).toBe('deduped');
    expect(await turnCount(userId)).toBe(1); // unchanged
    expect(await allowanceCount(userId)).toBe(1); // unchanged
    expect(await usageRecordsFor(userId)).toHaveLength(1); // no duplicate record
  });

  // --- 14. Non-evasion: deletion does not reset the counters ----------------------
  it('case 14: deleting a conversation does NOT reset the counters — the exhausted-state refusal survives deletion (non-evasion)', async () => {
    config.FEATURE_GATING = true;
    const userId = await seedUser();
    const convA = await seedConversation(userId, ALLOWANCE);
    const convB = await seedConversation(userId, ALLOWANCE);
    await seedTurnCounters(userId, TURN_LIMIT); // exhausted
    await seedWallet(userId, 0n);
    scripts = SINGLE_TURN_SCRIPT;

    const app = makeApp(userId);
    const res1 = await post(app, `/conversations/${convA}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'hi',
    });
    expect(res1.status).toBe(402);
    expect((await res1.json()).error.code).toBe('ALLOWANCE_EXHAUSTED');

    // Delete a conversation through the real owned-delete path…
    await deleteConversationOwned({ conversationId: convA, userId });
    // …the counter row survives untouched and the refusal stands.
    expect(await allowanceCount(userId)).toBe(TURN_LIMIT);
    const res2 = await post(app, `/conversations/${convB}/messages/stream`, {
      clientMessageId: crypto.randomUUID(),
      text: 'evade?',
    });
    expect(res2.status).toBe(402);
    expect((await res2.json()).error.code).toBe('ALLOWANCE_EXHAUSTED');
  });
});
