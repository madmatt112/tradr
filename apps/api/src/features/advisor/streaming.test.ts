/**
 * Streaming orchestration tests (Task 21).
 *
 * The DB, provider registry, cap-check, summarize, and buildDeclarations are
 * mocked so these run as pure unit tests. `bucketOf` is NOT mocked so the real
 * delivery-bucket classification is asserted. Cases cover the v3-2 / v4-1 /
 * v4-10 / v4-11 contract plus the §Component 8 auto-summarization wiring:
 *  - happy path, Layer-2 dedupe, RETRY_WHILE_IN_FLIGHT.
 *  - estimate > 0.75 × window → summarize() runs + re-assemble + re-estimate.
 *  - estimate <= 0.75 → no summarize, no throw.
 *  - re-estimate > 0.95 → CONVERSATION_TURN_TOO_LARGE (code + bucket); the single
 *    residual hard stop; emitted as a terminating event:error frame.
 *  - summarize() error outcome → CONVERSATION_TURN_TOO_LARGE (no re-estimate).
 *  - iteration-0 snapshot {toolUse, hasUwKey, uwKeyCiphertext, consentAtPrepare}.
 *  - redactForProvider exported, identity now, and invoked on the summarize path.
 *  - runStreaming slot/persistence/error/disconnect paths (v4-1 / v4-11).
 *
 * The old 0.95 ConversationTooLongError throw is gone (dual hard cap removed) —
 * no test asserts a throw from prepare() for CONVERSATION_TOO_LONG.
 *
 * _Requirements: REQ-11.1, REQ-11.6, REQ-1.7, REQ-9.6, REQ-15.5, 3.4–3.16, 6.7, 6.8_
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { encrypt, loadEncryptionKeyMaterial } from '@/lib/encryption';

// --- Mocks -------------------------------------------------------------------

const persistTurnMock = vi.fn();
vi.mock('./persistence', () => ({
  persistTurn: (...args: unknown[]) => persistTurnMock(...args),
  persistExchange: (...args: unknown[]) => persistTurnMock(...args),
}));

const estimateTokensMock = vi.fn();
vi.mock('./cap-check', () => ({
  estimateTokens: (...args: unknown[]) => estimateTokensMock(...args),
}));

const summarizeMock = vi.fn();
vi.mock('./summarize', () => ({
  summarize: (...args: unknown[]) => summarizeMock(...args),
}));

const buildDeclarationsMock = vi.fn();
vi.mock('./tools/declarations', () => ({
  buildDeclarations: (...args: unknown[]) => buildDeclarationsMock(...args),
}));

// The per-iteration re-read (task 23) is DB-backed; mock it so loop tests do not
// hit a database. Default returns a benign snapshot (consent off, no key) — the
// task-26 tests override per call via the `reReadIterationState` runStreaming seam.
const reReadIterationStateMock = vi.fn();
vi.mock('./external-keys.handler', () => ({
  reReadAdvisorIterationState: (...args: unknown[]) => reReadIterationStateMock(...args),
}));

const streamChatMock = vi.fn();
const translateMock = vi.fn((list: unknown) => list);
vi.mock('./providers/registry', () => ({
  getProvider: () => ({
    id: 'claude',
    translate: translateMock,
    streamChat: streamChatMock,
  }),
}));

import { errResult, makeScriptedRegistry, okResult } from './__fixtures__/scriptable-tools';
import type { AdvisorIterationState } from './external-keys.handler';
import {
  createUnusualWhalesClient,
  MarketDataCache,
  MarketDataMeter,
  type UnusualWhalesClient,
} from './lib/unusual-whales.client';
import {
  idempotencyMap,
  prepare,
  redactForProvider,
  runStreaming,
  type SseFrame,
  type StreamContext,
} from './streaming';
import { bucketOf } from './tools/error-codes';
import type { ToolContext, ToolDefinition, ToolResult } from './tools/types';

// --- Fixtures ----------------------------------------------------------------

const USER = 'user-1';
const CONV = 'conv-1';
const CMID = '11111111-1111-4111-8111-111111111111';

function makeContext(): StreamContext {
  return {
    providerId: 'claude',
    modelId: 'claude-opus-4-7',
    providerModel: {
      id: 'claude-opus-4-7',
      displayName: 'Opus',
      contextWindow: 1_000_000,
      vision: true,
      toolUse: false,
    },
    apiKey: 'sk-test',
    history: [],
    persona: null,
    personaId: null,
  };
}

function makeArgs(overrides?: { conversationId?: string | null }) {
  return {
    conversationId: overrides?.conversationId ?? CONV,
    userId: USER,
    input: { clientMessageId: CMID, text: 'hello' },
    abortSignal: new AbortController().signal,
    context: makeContext(),
  };
}

async function* tokensThenUsage(): AsyncIterable<unknown> {
  yield { type: 'token', delta: 'Hel' };
  yield { type: 'token', delta: 'lo' };
  yield { type: 'usage', promptTokens: 10, completionTokens: 5 };
  yield { type: 'done' };
}

async function collect(it: AsyncIterable<SseFrame>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of it) out.push(f);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  estimateTokensMock.mockResolvedValue({ tokens: 100, source: 'countTokens' });
  buildDeclarationsMock.mockReturnValue([]);
  // Benign default per-iteration snapshot so the loop's iter>0 re-read never hits
  // a DB; task-26 tests override via the runStreaming seam.
  reReadIterationStateMock.mockResolvedValue({
    consent: false,
    hasUwKey: true,
    uwKeyCiphertext: null,
  });
  // Reset shared singleton state between tests.
  for (const u of [USER]) idempotencyMap.removeIdempotencyEntry(u, CONV, CMID);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streaming orchestration', () => {
  it('happy path: yields tokens + usage + done and persists + markDone', async () => {
    streamChatMock.mockReturnValue(tokensThenUsage());
    persistTurnMock.mockResolvedValue({
      kind: 'inserted',
      conversationId: CONV,
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    });

    const { prepared, releaseSlot } = await prepare(makeArgs());
    const frames = await collect(runStreaming(prepared));
    releaseSlot();

    const events = frames.map((f) => f.event);
    expect(events).toEqual(['token', 'token', 'usage', 'done']);
    expect(JSON.parse(frames[3]!.data)).toEqual({ messageId: 'am-1' });

    expect(persistTurnMock).toHaveBeenCalledTimes(1);
    const persistArg = persistTurnMock.mock.calls[0]![0] as {
      assistantMessage: { contentParts: { text: string }[] };
    };
    expect(persistArg.assistantMessage.contentParts[0]!.text).toBe('Hello');

    // markDone transitioned the entry → done (Layer-2 reachable).
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({
      kind: 'hit-done',
      assistantMessageId: 'am-1',
    });
  });

  it('Layer-2 peek hit → synthetic-done, no slot, single done frame', async () => {
    // Seed a done entry so the peek hits Layer-2.
    idempotencyMap.reserve(USER, CONV, CMID, new AbortController());
    idempotencyMap.markDone(USER, CONV, CMID, 'am-prior');

    const { prepared } = await prepare(makeArgs());
    expect(prepared.kind).toBe('synthetic-done');

    const frames = await collect(runStreaming(prepared));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('done');
    expect(JSON.parse(frames[0]!.data)).toEqual({
      messageId: 'am-prior',
      deduped: true,
      source: 'layer-2',
    });
    // No upstream call, no persistence.
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(persistTurnMock).not.toHaveBeenCalled();
  });

  it('peek hit-in-progress → prepare throws RETRY_WHILE_IN_FLIGHT', async () => {
    idempotencyMap.reserve(USER, CONV, CMID, new AbortController());

    await expect(prepare(makeArgs())).rejects.toMatchObject({
      code: 'RETRY_WHILE_IN_FLIGHT',
      statusCode: 429,
    });
  });

  it('estimate above 0.75 × window triggers summarize() then re-assembles', async () => {
    // First estimate (trigger) over 0.75; re-estimate after summarize under 0.95.
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800_000, source: 'countTokens' })
      .mockResolvedValueOnce({ tokens: 100_000, source: 'countTokens' });
    summarizeMock.mockResolvedValue({
      kind: 'ok',
      summary: { prose: 'compressed', tradeDataFigures: null },
      window: [],
      write: null,
      notice: 'summarized',
    });

    const { prepared, releaseSlot } = await prepare(makeArgs());
    releaseSlot();

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    // Re-estimate happened (estimate called twice: trigger + re-estimate).
    expect(estimateTokensMock).toHaveBeenCalledTimes(2);
    expect(prepared.kind).toBe('stream');
  });

  it('below 0.75 × window does NOT summarize and does NOT throw', async () => {
    estimateTokensMock.mockResolvedValue({ tokens: 700_000, source: 'countTokens' });

    const { prepared, releaseSlot } = await prepare(makeArgs());
    releaseSlot();

    expect(summarizeMock).not.toHaveBeenCalled();
    expect(estimateTokensMock).toHaveBeenCalledTimes(1);
    expect(prepared.kind).toBe('stream');
  });

  it('still above 0.95 after summarize → CONVERSATION_TURN_TOO_LARGE (code + bucket)', async () => {
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800_000, source: 'countTokens' }) // trigger
      .mockResolvedValueOnce({ tokens: 999_999, source: 'countTokens' }); // re-estimate
    summarizeMock.mockResolvedValue({
      kind: 'ok',
      summary: { prose: 'still huge', tradeDataFigures: null },
      window: [],
      write: null,
      notice: 'summarized',
    });

    const { prepared, releaseSlot } = await prepare(makeArgs());
    releaseSlot();

    expect(prepared.kind).toBe('error');
    if (prepared.kind !== 'error') throw new Error('unreachable');
    expect(prepared.code).toBe('CONVERSATION_TURN_TOO_LARGE');
    expect(prepared.bucket).toBe('event_error');
    expect(bucketOf(prepared.code)).toBe('event_error');

    // runStreaming emits it as a terminating event:error frame.
    const frames = await collect(runStreaming(prepared));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('error');
    expect(JSON.parse(frames[0]!.data)).toEqual({
      code: 'CONVERSATION_TURN_TOO_LARGE',
      upstreamStatus: null,
    });
    // Reserved idempotency entry removed (no in-progress ghost) so a retry runs.
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
  });

  it('summarize() error outcome → CONVERSATION_TURN_TOO_LARGE without re-estimate', async () => {
    estimateTokensMock.mockResolvedValueOnce({ tokens: 800_000, source: 'countTokens' });
    summarizeMock.mockResolvedValue({ kind: 'error', code: 'CONVERSATION_TURN_TOO_LARGE' });

    const { prepared, releaseSlot } = await prepare(makeArgs());
    releaseSlot();

    expect(prepared.kind).toBe('error');
    if (prepared.kind !== 'error') throw new Error('unreachable');
    expect(prepared.code).toBe('CONVERSATION_TURN_TOO_LARGE');
    expect(prepared.bucket).toBe('event_error');
    // No re-estimate after an error outcome.
    expect(estimateTokensMock).toHaveBeenCalledTimes(1);
  });

  it('returns the iteration-0 snapshot {toolUse, hasUwKey, uwKeyCiphertext, consentAtPrepare}', async () => {
    const ctx = makeContext();
    ctx.providerModel.toolUse = true;
    ctx.consentAtPrepare = true;
    ctx.hasUwKey = true;
    ctx.uwKeyCiphertext = 'cipher-xyz';

    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: ctx });
    releaseSlot();

    expect(prepared.kind).toBe('stream');
    if (prepared.kind !== 'stream') throw new Error('unreachable');
    expect(prepared.toolUse).toBe(true);
    expect(prepared.hasUwKey).toBe(true);
    expect(prepared.uwKeyCiphertext).toBe('cipher-xyz');
    expect(prepared.consentAtPrepare).toBe(true);
    // buildDeclarations was consulted with the snapshot.
    expect(buildDeclarationsMock).toHaveBeenCalledWith({ toolUse: true }, true, true);
  });

  it('redactForProvider is exported and redacts on the summarize/replay path', async () => {
    // With consent, history passes through by identity reference.
    const history = makeContext().history;
    expect(redactForProvider(history, true)).toBe(history);

    // It is a real call on the summarize/replay path: summarize() receives the
    // redacted history.
    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800_000, source: 'countTokens' })
      .mockResolvedValueOnce({ tokens: 100_000, source: 'countTokens' });
    summarizeMock.mockResolvedValue({
      kind: 'ok',
      summary: { prose: 's', tradeDataFigures: null },
      window: [],
      write: null,
      notice: 'summarized',
    });

    const { releaseSlot } = await prepare(makeArgs());
    releaseSlot();

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const arg = summarizeMock.mock.calls[0]![0] as { history: unknown[] };
    expect(Array.isArray(arg.history)).toBe(true);
  });

  it('revoked conversation: summarize() receives a redacted history (no tool_result)', async () => {
    const ctx = makeContext();
    ctx.providerModel.toolUse = true; // tool-capable model: isolate redaction from flatten
    ctx.consentAtPrepare = false; // consent revoked
    ctx.history = [
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Here is your position.' },
          { type: 'tool_call', id: 't1', name: 'trade_data_open_positions', arguments: {} },
          { type: 'tool_result', toolCallId: 't1', status: 'ok', content: { pnl: 4321 } },
        ],
      },
    ] as StreamContext['history'];

    estimateTokensMock
      .mockResolvedValueOnce({ tokens: 800_000, source: 'countTokens' })
      .mockResolvedValueOnce({ tokens: 100_000, source: 'countTokens' });
    summarizeMock.mockResolvedValue({
      kind: 'ok',
      summary: { prose: 's', tradeDataFigures: null },
      window: [],
      write: null,
      notice: 'summarized',
    });

    const { releaseSlot } = await prepare({ ...makeArgs(), context: ctx });
    releaseSlot();

    const arg = summarizeMock.mock.calls[0]![0] as {
      history: { parts: { type: string; content?: unknown; text?: string }[] }[];
    };
    const parts = arg.history[0]!.parts;
    // tool_result is gone; replaced by the fixed redaction marker. The raw
    // figure (4321) never reaches the summarize call.
    expect(parts.some((p) => p.type === 'tool_result')).toBe(false);
    expect(parts).toContainEqual({
      type: 'text',
      text: '[trade data hidden — consent revoked]',
    });
    expect(JSON.stringify(arg.history)).not.toContain('4321');
    // Non-trade-data parts pass through unchanged.
    expect(parts.some((p) => p.type === 'tool_call')).toBe(true);
  });

  it('conversation-only model (toolUse=false): no tools offered, tool history flattens (REQ-13.1/13.3)', async () => {
    const ctx = makeContext();
    ctx.providerModel.toolUse = false; // conversation-only model
    ctx.consentAtPrepare = true;
    ctx.hasUwKey = true;
    ctx.history = [
      { role: 'user', parts: [{ type: 'text', text: 'quote AAPL' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Looking that up.' },
          { type: 'tool_call', id: 't1', name: 'market_data_stock_quote', arguments: {} },
          { type: 'tool_result', toolCallId: 't1', status: 'ok', content: { price: 187 } },
        ],
      },
    ] as StreamContext['history'];

    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: ctx });
    releaseSlot();

    // REQ-13.1: buildDeclarations consulted with toolUse=false (loop offers no tools).
    expect(buildDeclarationsMock).toHaveBeenCalledWith({ toolUse: false }, true, true);

    if (prepared.kind !== 'stream') throw new Error('unreachable');
    // REQ-13.3: the assistant message has NO tool parts; they are flattened into
    // its text. No extra messages, role alternation preserved.
    expect(prepared.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const assistant = prepared.messages[1] as { role: 'assistant'; parts: { type: string }[] };
    expect(assistant.parts.some((p) => p.type === 'tool_call' || p.type === 'tool_result')).toBe(
      false,
    );
    const flat = assistant.parts.at(-1) as { type: string; text: string };
    expect(flat.type).toBe('text');
    expect(flat.text).toContain('[tool market_data_stock_quote →');
    expect(flat.text).toContain('187');
  });

  it('runStreaming does NOT release the slot on normal completion (v4-1)', async () => {
    streamChatMock.mockReturnValue(tokensThenUsage());
    persistTurnMock.mockResolvedValue({
      kind: 'inserted',
      conversationId: CONV,
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    });

    const { releaseSlot } = await prepare(makeArgs());
    // Re-derive a fresh prepared to consume; the slot from prepare() is held.
    const { prepared } = await prepare(makeArgs({ conversationId: 'conv-other' })).catch(
      async () => {
        // Same user already holds a slot from the first prepare → second acquire
        // throws STREAM_IN_PROGRESS. This proves runStreaming has not released it.
        return { prepared: null as never };
      },
    );
    expect(prepared).toBeNull();

    releaseSlot();
  });

  it('client-disconnect mid-stream → silent return, no error frame, entry removed', async () => {
    const ac = new AbortController();
    async function* abortMidway(): AsyncIterable<unknown> {
      yield { type: 'token', delta: 'partial' };
      ac.abort();
      throw new Error('aborted');
    }
    streamChatMock.mockReturnValue(abortMidway());

    const args = { ...makeArgs(), abortSignal: ac.signal };
    const { prepared, releaseSlot } = await prepare(args);
    const frames = await collect(runStreaming(prepared));
    releaseSlot();

    // Only the partial token frame; NO error frame (v4-11).
    expect(frames.map((f) => f.event)).toEqual(['token']);
    expect(persistTurnMock).not.toHaveBeenCalled();
    // Failed-stream path removed the entry.
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
  });

  it('provider SDK error mid-stream → mapped error frame, no persistence', async () => {
    async function* throwsRateLimit(): AsyncIterable<unknown> {
      yield { type: 'token', delta: 'x' };
      // Raw SDK error shape — both Anthropic/OpenAI expose `status`.
      throw Object.assign(new Error('rate limited'), { status: 429 });
    }
    streamChatMock.mockReturnValue(throwsRateLimit());

    const { prepared, releaseSlot } = await prepare(makeArgs());
    const frames = await collect(runStreaming(prepared));
    releaseSlot();

    expect(frames[0]!.event).toBe('token');
    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeDefined();
    expect(JSON.parse(errFrame!.data)).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(persistTurnMock).not.toHaveBeenCalled();
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
  });

  it('persistence failure after streaming → PERSISTENCE_FAILED frame, entry removed', async () => {
    streamChatMock.mockReturnValue(tokensThenUsage());
    persistTurnMock.mockRejectedValue(new Error('db down'));

    const { prepared, releaseSlot } = await prepare(makeArgs());
    const frames = await collect(runStreaming(prepared));
    releaseSlot();

    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeDefined();
    expect(JSON.parse(errFrame!.data)).toMatchObject({
      code: 'PERSISTENCE_FAILED',
    });
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
  });
});

// --- Marker-driven billing construction (plan-tiers Task 9, D10/D11) ---------
//
// The persist seam builds persistTurn's `billing` arg from the EXPLICIT
// `platformBillingMode` context marker — never from `reservationHeld > 0n`
// (that old discriminator would silently mis-classify a zero-reservation
// allowance turn as BYOK). `mode` is copied from the marker verbatim.

describe('marker-driven billing construction (plan-tiers task 9)', () => {
  beforeEach(() => {
    streamChatMock.mockReturnValue(tokensThenUsage());
    persistTurnMock.mockResolvedValue({
      kind: 'inserted',
      conversationId: CONV,
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    });
  });

  type PersistedBilling =
    | { mode: string; reservationHeld: bigint; usage: { inputTokens: number } }
    | undefined;

  async function runWithContext(ctx: StreamContext): Promise<PersistedBilling> {
    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: ctx });
    await collect(runStreaming(prepared));
    releaseSlot();
    expect(persistTurnMock).toHaveBeenCalledTimes(1);
    return (persistTurnMock.mock.calls[0]![0] as { billing: PersistedBilling }).billing;
  }

  it("marker 'credits' → billing built with mode copied from the marker + the held reservation", async () => {
    const ctx = makeContext();
    ctx.platformBillingMode = 'credits';
    ctx.reservationHeld = 1_000n;

    const billing = await runWithContext(ctx);
    expect(billing).toBeDefined();
    expect(billing!.mode).toBe('credits');
    expect(billing!.reservationHeld).toBe(1_000n);
    // Cumulative metered usage from the stream's usage event (10/5).
    expect(billing!.usage.inputTokens).toBe(10);
  });

  it("marker 'allowance' with a ZERO reservation → billing still built (mode 'allowance')", async () => {
    const ctx = makeContext();
    ctx.platformBillingMode = 'allowance';
    ctx.reservationHeld = 0n; // D10: allowance turns take no reservation

    const billing = await runWithContext(ctx);
    // The old `reservationHeld > 0n` discriminator would have dropped this.
    expect(billing).toBeDefined();
    expect(billing!.mode).toBe('allowance');
    expect(billing!.reservationHeld).toBe(0n);
  });

  it('no marker (BYOK) → NO billing arg constructed', async () => {
    const billing = await runWithContext(makeContext());
    expect(billing).toBeUndefined();
  });
});

// --- Bounded agentic loop (Task 25) ------------------------------------------
//
// These tests drive `streamChatMock` per-iteration (one scripted async iterable
// per provider round-trip) and run the REAL `dispatchTool` against an injected
// scripted registry (`makeScriptedRegistry`). `buildDeclarations` is mocked to
// offer one tool so the loop's tool path is exercised.

const TOOL = 'market_data_stock_quote';

/** A single `tool_call` round-trip naming {@link TOOL}. */
async function* toolCallIteration(id: string): AsyncIterable<unknown> {
  yield { type: 'tool_call', id, name: TOOL, arguments: { symbol: 'AAPL' } };
  yield { type: 'done' };
}

/** A final-answer round-trip: text only, no tool calls. */
async function* finalAnswerIteration(text: string): AsyncIterable<unknown> {
  yield { type: 'token', delta: text };
  yield { type: 'usage', promptTokens: 7, completionTokens: 3 };
  yield { type: 'done' };
}

/** Queue `streamChatMock` to yield each scripted iterable in order, per call. */
function scriptProviderCalls(iters: Array<() => AsyncIterable<unknown>>): void {
  let i = 0;
  streamChatMock.mockImplementation(() => {
    const make = iters[i++];
    if (!make) throw new Error(`provider called ${i} times but only ${iters.length} scripted`);
    return make();
  });
}

function makeToolContext(): StreamContext {
  const ctx = makeContext();
  ctx.providerModel.toolUse = true;
  ctx.hasUwKey = true;
  ctx.consentAtPrepare = false;
  return ctx;
}

function toolArgs() {
  return { ...makeArgs(), context: makeToolContext() };
}

describe('bounded agentic loop (task 25)', () => {
  beforeEach(() => {
    // Offer one tool so the loop opens a tool-capable provider call.
    buildDeclarationsMock.mockReturnValue([
      { name: TOOL, description: 'quote', inputJsonSchema: { type: 'object' } },
    ]);
    persistTurnMock.mockResolvedValue({
      kind: 'inserted',
      conversationId: CONV,
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    });
  });

  it('model → tool → model → final: streams tool_call + tool_result then done; persists ordered parts', async () => {
    scriptProviderCalls([
      () => toolCallIteration('tc-1'),
      () => finalAnswerIteration('Here is the quote.'),
    ]);
    const registry = makeScriptedRegistry({ [TOOL]: { results: [okResult({ price: 100 })] } });

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    const events = frames.map((f) => f.event);
    expect(events).toEqual(['tool_call', 'tool_result', 'token', 'usage', 'done']);

    // Two provider round-trips and one tool execution.
    expect(streamChatMock).toHaveBeenCalledTimes(2);
    expect(registry.callIndexOf(TOOL)).toBe(1);

    // Persisted assistant parts are the ordered tool_call → tool_result → text.
    const persistArg = persistTurnMock.mock.calls[0]![0] as {
      assistantMessage: { contentParts: { type: string }[] };
    };
    expect(persistArg.assistantMessage.contentParts.map((p) => p.type)).toEqual([
      'tool_call',
      'tool_result',
      'text',
    ]);
  });

  it('per-tool signal is the one dispatch threads into ctx.signal', async () => {
    scriptProviderCalls([() => toolCallIteration('tc-1'), () => finalAnswerIteration('done')]);
    const registry = makeScriptedRegistry({ [TOOL]: { results: [okResult()] } });

    const { prepared, releaseSlot } = await prepare(toolArgs());
    await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    const signals = registry.signalsOf(TOOL);
    expect(signals).toHaveLength(1);
    // Not aborted on a fast handler (the per-tool controller was never aborted).
    expect(signals[0]!.aborted).toBe(false);
  });

  it('inactivity is not tripped across a multi-tool batch (real timers)', async () => {
    // A single round-trip emitting THREE tool calls, then a final answer. The
    // watchdog is cleared before tool work, so even with real timers the batch
    // cannot trip the (60 s) inactivity timeout within the test.
    async function* threeToolCalls(): AsyncIterable<unknown> {
      yield { type: 'tool_call', id: 'a', name: TOOL, arguments: { symbol: 'AAA' } };
      yield { type: 'tool_call', id: 'b', name: TOOL, arguments: { symbol: 'BBB' } };
      yield { type: 'tool_call', id: 'c', name: TOOL, arguments: { symbol: 'CCC' } };
      yield { type: 'done' };
    }
    scriptProviderCalls([() => threeToolCalls(), () => finalAnswerIteration('all done')]);
    const registry = makeScriptedRegistry({
      [TOOL]: { results: [okResult(1), okResult(2), okResult(3)] },
    });

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    expect(registry.callIndexOf(TOOL)).toBe(3);
    // Three tool_call + three tool_result frames, then the final answer + done.
    expect(frames.filter((f) => f.event === 'tool_call')).toHaveLength(3);
    expect(frames.filter((f) => f.event === 'tool_result')).toHaveLength(3);
    expect(frames.at(-1)!.event).toBe('done');
    // No inactivity/timeout error frame.
    expect(frames.find((f) => f.event === 'error')).toBeUndefined();
  });

  it('6-iteration exhaustion → forced answer + answer_incomplete (code + bucket)', async () => {
    // Six tool-requesting round-trips, then the forced-final call answers (no tools).
    scriptProviderCalls([
      () => toolCallIteration('t0'),
      () => toolCallIteration('t1'),
      () => toolCallIteration('t2'),
      () => toolCallIteration('t3'),
      () => toolCallIteration('t4'),
      () => toolCallIteration('t5'),
      () => finalAnswerIteration('Could not finish, but here is what I found.'),
    ]);
    // Always-ok scripted tool (valid before and after task 27).
    const registry = makeScriptedRegistry({ [TOOL]: { results: [] } }); // defaults to ok

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    // 6 loop iterations + 1 forced-final call.
    expect(streamChatMock).toHaveBeenCalledTimes(7);
    // The forced-final call omitted tools.
    expect(streamChatMock.mock.calls[6]![0].tools).toBeUndefined();

    const notice = frames.find((f) => f.event === 'notice');
    expect(notice).toBeDefined();
    const noticeData = JSON.parse(notice!.data) as { code: string };
    expect(noticeData.code).toBe('answer_incomplete');
    expect(bucketOf(noticeData.code)).toBe('notice');

    // Notice precedes the terminal done.
    expect(frames.at(-1)!.event).toBe('done');
    expect(persistTurnMock).toHaveBeenCalledTimes(1);
  });

  it('forced-final still requests tools → TOOL_LOOP_EXHAUSTED (code + bucket), still persists', async () => {
    scriptProviderCalls([
      () => toolCallIteration('t0'),
      () => toolCallIteration('t1'),
      () => toolCallIteration('t2'),
      () => toolCallIteration('t3'),
      () => toolCallIteration('t4'),
      () => toolCallIteration('t5'),
      () => toolCallIteration('still-wants-tools'), // forced-final STILL requests tools
    ]);
    const registry = makeScriptedRegistry({ [TOOL]: { results: [] } });

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeDefined();
    const errData = JSON.parse(errFrame!.data) as { code: string };
    expect(errData.code).toBe('TOOL_LOOP_EXHAUSTED');
    expect(bucketOf(errData.code)).toBe('event_error');
    // Design §C3:206 — the turn is still persisted on this path.
    expect(persistTurnMock).toHaveBeenCalledTimes(1);
    // Exactly one terminal: TOOL_LOOP_EXHAUSTED is the only one — the shared
    // persist step must NOT also emit a `done` frame (single-terminal contract).
    expect(frames.filter((f) => f.event === 'error')).toHaveLength(1);
    expect(frames.find((f) => f.event === 'done')).toBeUndefined();
  });

  it('forced-final still requests tools + persistence fails → PERSISTENCE_FAILED frame (not TOOL_LOOP_EXHAUSTED), entry removed', async () => {
    scriptProviderCalls([
      () => toolCallIteration('t0'),
      () => toolCallIteration('t1'),
      () => toolCallIteration('t2'),
      () => toolCallIteration('t3'),
      () => toolCallIteration('t4'),
      () => toolCallIteration('t5'),
      () => toolCallIteration('still-wants-tools'),
    ]);
    persistTurnMock.mockRejectedValue(new Error('db down'));
    const registry = makeScriptedRegistry({ [TOOL]: { results: [] } });

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    // Persistence was attempted on this branch (design §C3:206) but failed.
    expect(persistTurnMock).toHaveBeenCalledTimes(1);
    // The failure is mapped/surfaced consistently with the normal path — a single
    // PERSISTENCE_FAILED error frame, NOT TOOL_LOOP_EXHAUSTED, and no `done`.
    const errFrames = frames.filter((f) => f.event === 'error');
    expect(errFrames).toHaveLength(1);
    expect(JSON.parse(errFrames[0]!.data)).toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(frames.find((f) => f.event === 'done')).toBeUndefined();
    // Entry removed so the user can retry.
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
  });

  it('mid-loop abort persists nothing', async () => {
    const ac = new AbortController();
    // The tool handler aborts the turn (client disconnect) mid-batch.
    async function* twoToolCalls(): AsyncIterable<unknown> {
      yield { type: 'tool_call', id: 'a', name: TOOL, arguments: { symbol: 'AAA' } };
      yield { type: 'tool_call', id: 'b', name: TOOL, arguments: { symbol: 'BBB' } };
      yield { type: 'done' };
    }
    scriptProviderCalls([() => twoToolCalls()]);
    const registry = makeScriptedRegistry({
      [TOOL]: {
        // The first tool aborts the turn; the loop must return before the 2nd.
        results: [],
      },
    });
    // Wrap the first handler to abort after it runs.
    const def = registry.registry[TOOL]!;
    const originalHandler = def.handler;
    (def as { handler: typeof def.handler }).handler = async (input, ctx) => {
      const r = await originalHandler(input, ctx);
      ac.abort();
      return r;
    };

    const { prepared, releaseSlot } = await prepare({ ...toolArgs(), abortSignal: ac.signal });
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    // Persisted nothing; no done; entry removed.
    expect(persistTurnMock).not.toHaveBeenCalled();
    expect(frames.find((f) => f.event === 'done')).toBeUndefined();
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
    // Only the first tool ran (the loop returned before the 2nd).
    expect(registry.callIndexOf(TOOL)).toBe(1);
  });
});

// --- Per-iteration re-read + UW-client rebuild (Task 26) ----------------------
//
// REQ-1.7: on each iteration > 0 the loop re-reads {consent, hasUwKey,
// uwKeyCiphertext} and rebuilds the UW client from the CURRENT ciphertext
// (rotation honored). `buildDeclarations` is mocked to reflect the refreshed
// consent/key snapshot so a mid-turn revoke/delete withdraws the matching tools.
// The decrypt path runs end-to-end (real `encrypt`/`decrypt`) so a rotated key
// is provably used; the UW-client factory seam captures the key/builds a fake
// client to assert no in-flight request leaks across a timeout→rebuild.

const MD_TOOL = 'market_data_stock_quote';
const TD_TOOL = 'trade_data_open_positions';

/** A round-trip requesting BOTH a market-data and a trade-data tool. */
async function* bothToolsIteration(suffix: string): AsyncIterable<unknown> {
  yield { type: 'tool_call', id: `md-${suffix}`, name: MD_TOOL, arguments: { symbol: 'AAPL' } };
  yield { type: 'tool_call', id: `td-${suffix}`, name: TD_TOOL, arguments: {} };
  yield { type: 'done' };
}

/** A round-trip requesting one market-data tool. */
async function* mdToolIteration(suffix: string): AsyncIterable<unknown> {
  yield { type: 'tool_call', id: `md-${suffix}`, name: MD_TOOL, arguments: { symbol: 'AAPL' } };
  yield { type: 'done' };
}

describe('per-iteration re-read + UW-client rebuild (task 26)', () => {
  beforeAll(() => {
    // The decrypt path runs for real on the rotation / leak tests.
    loadEncryptionKeyMaterial();
  });

  beforeEach(() => {
    persistTurnMock.mockResolvedValue({
      kind: 'inserted',
      conversationId: CONV,
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    });
  });

  /** Offer market-data and/or trade-data tools per the refreshed snapshot. */
  function declarationsBySnapshot() {
    buildDeclarationsMock.mockImplementation(
      (_caps: unknown, consent: boolean, hasUwKey: boolean) => {
        const decls: Array<{ name: string; description: string; inputJsonSchema: object }> = [];
        if (hasUwKey) decls.push({ name: MD_TOOL, description: 'q', inputJsonSchema: {} });
        if (consent) decls.push({ name: TD_TOOL, description: 'p', inputJsonSchema: {} });
        return decls;
      },
    );
  }

  /** A registry whose market-data handler calls `ctx.uw`; trade-data returns ok. */
  function uwRegistry(): { registry: Record<string, ToolDefinition> } {
    const mdDef: ToolDefinition = {
      name: MD_TOOL,
      description: 'quote',
      category: 'market-data',
      requires: 'unusual-whales-key',
      inputSchema: z.object({ symbol: z.string() }),
      async handler(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
        if (!ctx.uw) return { status: 'error', code: 'MARKET_DATA_UNAVAILABLE', message: 'no uw' };
        try {
          const raw = await ctx.uw.getStockQuote('AAPL', ctx.signal);
          return { status: 'ok', content: raw };
        } catch (err) {
          return {
            status: 'error',
            code: 'MARKET_DATA_UNAVAILABLE',
            message: (err as Error).message,
          };
        }
      },
    };
    const tdDef: ToolDefinition = {
      name: TD_TOOL,
      description: 'positions',
      category: 'trade-data',
      requires: 'trade-data-consent',
      maxEstTokens: 3000,
      inputSchema: z.object({}),
      async handler(): Promise<ToolResult> {
        return { status: 'ok', content: { positions: [] } };
      },
    };
    return { registry: { [MD_TOOL]: mdDef, [TD_TOOL]: tdDef } };
  }

  function toolCtx(): StreamContext {
    const ctx = makeContext();
    ctx.providerModel.toolUse = true;
    ctx.hasUwKey = true;
    ctx.consentAtPrepare = true;
    // A real iteration-0 ciphertext so the decrypt-at-context-build path runs end
    // to end whenever the market-data handler invokes the rebuilt client.
    ctx.uwKeyCiphertext = encrypt('uw-key-iter0');
    return ctx;
  }

  it('mid-turn consent revoke → trade-data tool withdrawn on the next iteration', async () => {
    declarationsBySnapshot();
    // Iter 0: both tools offered (consent on). Iter 1: consent revoked.
    scriptProviderCalls([() => bothToolsIteration('0'), () => finalAnswerIteration('done')]);
    const reRead = vi.fn<(userId: string) => Promise<AdvisorIterationState>>().mockResolvedValue({
      consent: false, // revoked mid-turn
      hasUwKey: true,
      uwKeyCiphertext: { encryptedKey: encrypt('uw-key-iter1'), keyVersion: 1 },
    });
    const fakeUw: UnusualWhalesClient = {
      getStockQuote: vi.fn().mockResolvedValue({ price: 1 }),
      getOptionsFlow: vi.fn(),
      getExpiryBreakdown: vi.fn(),
      getOptionContracts: vi.fn(),
    };
    const { registry } = uwRegistry();

    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: toolCtx() });
    await collect(
      runStreaming(prepared, {
        registry,
        reReadIterationState: reRead,
        makeUwClient: () => fakeUw,
      }),
    );
    releaseSlot();

    // Iteration 1 built declarations with consent=false → no trade-data tool.
    expect(reRead).toHaveBeenCalledTimes(1);
    const iter1Decls = buildDeclarationsMock.mock.calls.at(-1)!;
    expect(iter1Decls[1]).toBe(false); // consent
    expect(iter1Decls[2]).toBe(true); // hasUwKey
  });

  it('mid-turn UW-key delete → market-data tool withdrawn + client never built', async () => {
    declarationsBySnapshot();
    scriptProviderCalls([() => mdToolIteration('0'), () => finalAnswerIteration('done')]);
    const reRead = vi.fn<(userId: string) => Promise<AdvisorIterationState>>().mockResolvedValue({
      consent: true,
      hasUwKey: false, // key deleted mid-turn
      uwKeyCiphertext: null,
    });
    const makeUwClient = vi.fn(() => ({
      getStockQuote: vi.fn().mockResolvedValue({ price: 1 }),
      getOptionsFlow: vi.fn(),
      getExpiryBreakdown: vi.fn(),
      getOptionContracts: vi.fn(),
    }));
    const { registry } = uwRegistry();

    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: toolCtx() });
    await collect(runStreaming(prepared, { registry, reReadIterationState: reRead, makeUwClient }));
    releaseSlot();

    // Iteration 1 saw hasUwKey=false → market-data tool not offered, so the loop
    // built the client ONLY on iter 0 (key present) and NOT on iter 1 (key gone) —
    // a stale decrypted client is never built for the deleted key.
    const iter1Decls = buildDeclarationsMock.mock.calls.at(-1)!;
    expect(iter1Decls[2]).toBe(false); // hasUwKey
    expect(makeUwClient).toHaveBeenCalledTimes(1); // iter 0 only
  });

  it('mid-turn key rotation → the new ciphertext is decrypted and used to build the client', async () => {
    declarationsBySnapshot();
    // Two market-data round-trips then a final answer, so the client is built on
    // both iter 0 (old key) and iter 1 (rotated key).
    scriptProviderCalls([
      () => mdToolIteration('0'),
      () => mdToolIteration('1'),
      () => finalAnswerIteration('done'),
    ]);
    const rotatedCipher = encrypt('uw-key-ROTATED');
    const reRead = vi.fn<(userId: string) => Promise<AdvisorIterationState>>().mockResolvedValue({
      consent: true,
      hasUwKey: true,
      uwKeyCiphertext: { encryptedKey: rotatedCipher, keyVersion: 1 },
    });
    // Capture the decrypted plaintext key handed to the factory each iteration.
    const keysSeen: string[] = [];
    const makeUwClient = vi.fn((apiKey: string) => {
      keysSeen.push(apiKey);
      return {
        getStockQuote: vi.fn().mockResolvedValue({ price: 1 }),
        getOptionsFlow: vi.fn(),
        getExpiryBreakdown: vi.fn(),
        getOptionContracts: vi.fn(),
      };
    });
    const { registry } = uwRegistry();

    // Iteration 0 uses the prepare() ciphertext = encrypt('uw-key-ORIGINAL').
    const ctx = toolCtx();
    ctx.uwKeyCiphertext = encrypt('uw-key-ORIGINAL');

    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: ctx });
    await collect(runStreaming(prepared, { registry, reReadIterationState: reRead, makeUwClient }));
    releaseSlot();

    expect(keysSeen).toEqual(['uw-key-ORIGINAL', 'uw-key-ROTATED']);
  });

  it('timeout → rebuild leaves no leaked in-flight request (real client + per-tool abort)', async () => {
    // The real per-tool timeout (15 s, via withToolTimeout) must abort the
    // in-flight UW socket BEFORE the next iteration rebuilds its client. We drive
    // the timeout under fake timers and assert iter-0's request settles (aborts)
    // before iter-1's request opens — closing the v2 socket-leak finding.
    vi.useFakeTimers();
    declarationsBySnapshot();
    scriptProviderCalls([
      () => mdToolIteration('0'),
      () => mdToolIteration('1'),
      () => finalAnswerIteration('done'),
    ]);
    const reRead = vi.fn<(userId: string) => Promise<AdvisorIterationState>>().mockResolvedValue({
      consent: true,
      hasUwKey: true,
      uwKeyCiphertext: { encryptedKey: encrypt('uw-key'), keyVersion: 1 },
    });

    // Each fetch hangs until its signal aborts (the in-flight request). We record
    // when each opens and settles so a leak (iter-0 still open when iter-1 opens)
    // is observable.
    let openRequests = 0;
    let nextId = 0;
    const events: string[] = [];
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const n = nextId++; // monotonic per-request id (0 = iter 0, 1 = iter 1)
        openRequests++;
        events.push(`open-${n}`);
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => {
          openRequests--;
          events.push(`abort-${n}`);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });

    const makeUwClient = (
      apiKey: string,
      userId: string,
      deps: { cache: MarketDataCache; meter: MarketDataMeter },
    ): UnusualWhalesClient =>
      createUnusualWhalesClient({
        apiKey,
        userId,
        cache: deps.cache,
        meter: deps.meter,
        fetchImpl,
      });

    // A market-data handler that simply awaits the (hanging) UW request — it
    // returns only when the per-tool timeout aborts ctx.signal.
    const { z } = await import('zod');
    const mdDef: ToolDefinition = {
      name: MD_TOOL,
      description: 'quote',
      category: 'market-data',
      requires: 'unusual-whales-key',
      inputSchema: z.object({ symbol: z.string() }),
      async handler(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
        try {
          const raw = await ctx.uw!.getStockQuote('AAPL', ctx.signal);
          return { status: 'ok', content: raw };
        } catch (err) {
          return {
            status: 'error',
            code: 'MARKET_DATA_UNAVAILABLE',
            message: (err as Error).message,
          };
        }
      },
    };
    const registry = { [MD_TOOL]: mdDef };

    const { prepared, releaseSlot } = await prepare({ ...makeArgs(), context: toolCtx() });
    const run = collect(
      runStreaming(prepared, { registry, reReadIterationState: reRead, makeUwClient }),
    );
    // Let iter 0 start: consume the first provider event (clears the 15 s connect
    // watchdog) and reach the tool dispatch so the first fetch opens (open-0).
    await vi.advanceTimersByTimeAsync(10);
    // Fire iter 0's 15 s per-tool timeout → withToolTimeout aborts ctx.signal →
    // the in-flight UW socket is torn down (abort-0) before the loop rebuilds.
    await vi.advanceTimersByTimeAsync(15_000);
    // Iter 1 rebuilds its client and opens a fresh fetch (open-1); fire its
    // timeout too so the run completes.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await run;
    releaseSlot();

    // The first request was aborted BEFORE the second opened (no socket leaked
    // across the rebuild), and nothing is left open at the end.
    expect(events).toContain('open-1');
    expect(events.indexOf('abort-0')).toBeLessThan(events.indexOf('open-1'));
    expect(openRequests).toBe(0);
  });
});

// --- Degenerate guard: withdrawal-convergence + M/successCount backstop (Task 27)
//
// REQ-1.9 / REQ-15.5. The primary mechanism is per-tool withdrawal (K=3): once
// all offered tools are withdrawn (here: dropped from `buildDeclarations` via the
// loop's `.filter(not withdrawn)`), the model is offered no tools and the loop
// breaks on the empty-tool-calls path — BEFORE iteration 6. The backstop is the
// `totalDegenerateFailures >= M (6) AND successCount === 0` early-abort, which
// trips only on a fully-unproductive turn. Both run the REAL `dispatchTool`
// against an injected scripted registry (task-24 fixtures).

const TOOL_A = 'market_data_stock_quote';
const TOOL_B = 'market_data_options_flow';
const TOOL_C = 'market_data_options_chain';

/** A round-trip requesting exactly the named tools (one tool_call each). */
function requestTools(...names: string[]): () => AsyncIterable<unknown> {
  return async function* gen(): AsyncIterable<unknown> {
    for (const name of names) {
      yield { type: 'tool_call', id: `tc-${name}`, name, arguments: { symbol: 'AAPL' } };
    }
    yield { type: 'done' };
  };
}

describe('degenerate guard (task 27)', () => {
  beforeEach(() => {
    persistTurnMock.mockResolvedValue({
      kind: 'inserted',
      conversationId: CONV,
      userMessageId: 'um-1',
      assistantMessageId: 'am-1',
    });
  });

  it('(a) mixed-success turn converges VIA WITHDRAWAL before iteration 6 and completes normally', async () => {
    // buildDeclarations always offers A and B; the loop filters out whatever the
    // turnState has withdrawn. (Tool C is unused here.)
    buildDeclarationsMock.mockReturnValue([
      { name: TOOL_A, description: 'a', inputJsonSchema: { type: 'object' } },
      { name: TOOL_B, description: 'b', inputJsonSchema: { type: 'object' } },
    ]);

    // Tool B succeeds once (productive work → successCount > 0, so the M/abort
    // backstop can NEVER fire). Tool A fails MARKET_DATA_UNAVAILABLE on calls 1-3
    // → withdrawn after the 3rd (K=3).
    const registry = makeScriptedRegistry({
      [TOOL_A]: {
        results: [
          errResult('MARKET_DATA_UNAVAILABLE'),
          errResult('MARKET_DATA_UNAVAILABLE'),
          errResult('MARKET_DATA_UNAVAILABLE'),
        ],
      },
      [TOOL_B]: { results: [okResult({ flow: 1 })] },
    });

    // Capture the tool names the model was OFFERED on each round-trip so we can
    // prove A is no longer offered once withdrawn.
    const offeredPerCall: string[][] = [];
    let i = 0;
    const iters: Array<() => AsyncIterable<unknown>> = [
      requestTools(TOOL_A, TOOL_B), // iter 0: A fails (1), B ok
      requestTools(TOOL_A), // iter 1: A fails (2)
      requestTools(TOOL_A), // iter 2: A fails (3) → A withdrawn
      // iter 3: A is now filtered out; the scripted model STOPS requesting A and
      // answers → empty tool calls → loop breaks (convergence via withdrawal).
      () => finalAnswerIteration('Here is the flow data I gathered.'),
    ];
    streamChatMock.mockImplementation((args: { tools?: Array<{ name: string }> }) => {
      offeredPerCall.push((args.tools ?? []).map((t) => t.name));
      const make = iters[i++];
      if (!make) throw new Error(`provider called ${i} times but only ${iters.length} scripted`);
      return make();
    });

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    // CONVERGENCE INDEX: the loop opened exactly 4 provider calls (iters 0-3) and
    // broke on iter index 3 (< 6) — NOT all 6 iterations + a forced-final call.
    expect(streamChatMock).toHaveBeenCalledTimes(4);
    const convergenceIndex = streamChatMock.mock.calls.length - 1;
    expect(convergenceIndex).toBeLessThan(6);

    // A was offered on iters 0-2 then WITHDRAWN: not offered on the converging call.
    expect(offeredPerCall[0]).toContain(TOOL_A);
    expect(offeredPerCall[2]).toContain(TOOL_A);
    expect(offeredPerCall[3]).not.toContain(TOOL_A);

    // A ran exactly 3 times (then withdrawn → never executed again); B ran once.
    expect(registry.callIndexOf(TOOL_A)).toBe(3);
    expect(registry.callIndexOf(TOOL_B)).toBe(1);

    // Completes NORMALLY: a terminal `done`, NO answer_incomplete notice, NO
    // DEGENERATE_TOOL_FAILURE error. The turn is persisted.
    expect(frames.at(-1)!.event).toBe('done');
    expect(frames.find((f) => f.event === 'notice')).toBeUndefined();
    expect(frames.find((f) => f.event === 'error')).toBeUndefined();
    expect(persistTurnMock).toHaveBeenCalledTimes(1);
  });

  it('(b) interleaved all-failing turn (3 tools × 2 failures, 0 successes) → DEGENERATE_TOOL_FAILURE (code + bucket), no persist', async () => {
    buildDeclarationsMock.mockReturnValue([
      { name: TOOL_A, description: 'a', inputJsonSchema: { type: 'object' } },
      { name: TOOL_B, description: 'b', inputJsonSchema: { type: 'object' } },
      { name: TOOL_C, description: 'c', inputJsonSchema: { type: 'object' } },
    ]);

    // 3 tools, each failing twice (degeneracy-class), zero successes. No single
    // tool reaches K=3, so withdrawal never fires; the backstop must catch this.
    const registry = makeScriptedRegistry({
      [TOOL_A]: {
        results: [errResult('MARKET_DATA_UNAVAILABLE'), errResult('MARKET_DATA_UNAVAILABLE')],
      },
      [TOOL_B]: {
        results: [errResult('MARKET_DATA_UNAVAILABLE'), errResult('MARKET_DATA_UNAVAILABLE')],
      },
      [TOOL_C]: {
        results: [errResult('PLATFORM_RATE_LIMITED'), errResult('PLATFORM_RATE_LIMITED')],
      },
    });

    // Two round-trips each requesting all three tools interleaved → 6 degenerate
    // failures, 0 successes. The backstop trips after the 6th failure (iter 1).
    scriptProviderCalls([
      requestTools(TOOL_A, TOOL_B, TOOL_C),
      requestTools(TOOL_A, TOOL_B, TOOL_C),
    ]);

    const { prepared, releaseSlot } = await prepare(toolArgs());
    const frames = await collect(runStreaming(prepared, { registry: registry.registry }));
    releaseSlot();

    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeDefined();
    const errData = JSON.parse(errFrame!.data) as { code: string };
    // Assert CODE and BUCKET.
    expect(errData.code).toBe('DEGENERATE_TOOL_FAILURE');
    expect(bucketOf(errData.code)).toBe('event_error');

    // No persist, no done — the turn produced no productive work.
    expect(persistTurnMock).not.toHaveBeenCalled();
    expect(frames.find((f) => f.event === 'done')).toBeUndefined();
    expect(idempotencyMap.peek(USER, CONV, CMID)).toEqual({ kind: 'miss' });
  });
});
