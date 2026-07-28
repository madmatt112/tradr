// Streaming orchestration (design §Component 3; v3-2, v4-1, v4-2, v4-10, v4-11).
//
// Two entry points consumed by the route handler (Task 24):
//
//   prepare(args)      — runs the pre-stream sequencing (peek → acquire slot →
//                        reserve → assemble → cap-check → hard-cap). Throws an
//                        AppError on any pre-stream failure; on a throw AFTER the
//                        slot is acquired it releases the slot AND removes any
//                        reserved idempotency entry (v4-10). On a Layer-2 dedupe
//                        hit it returns a `synthetic-done` Prepared without
//                        acquiring an upstream call.
//   runStreaming(prep) — async generator that opens the upstream provider call,
//                        yields SSE frames (token / usage / done / error), and on
//                        successful persistence calls markDone() to transition the
//                        idempotency entry in-progress → done (the entry then
//                        persists for the LRU TTL so a later retry hits Layer-2).
//
// Lifecycle restrictions honoured here (v4-1):
//   - runStreaming NEVER calls releaseSlot — slot release is the route's job in a
//     try/finally around prepare()'s returned releaseSlot.
//   - markDone (NOT removeIdempotencyEntry) is used on normal completion so the
//     done entry survives for Layer-2 hits.
//   - removeIdempotencyEntry is called ONLY on pre-stream / failed-stream paths.
//   - client-disconnect aborts return silently — no PROVIDER_ERROR frame.
//   - the SDK timeout is owned by the adapters (600_000); nothing here lowers it.

import type {
  CanonicalMessage,
  CanonicalPart,
  ProviderId,
  ProviderModel,
  StoredContentPart,
  StreamRequestInput,
} from '@tradr/shared';

import { decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { advisorImageKey, getObjectStorage } from '@/lib/object-storage';

import { releaseReservation } from '../billing/billing.service';

import {
  DegenerateToolFailureError,
  PersistenceFailedError,
  ToolLoopExhaustedError,
  mapProviderError,
} from './advisor.errors';
import { assembleCanonicalMessages } from './assemble';
import { estimateTokens } from './cap-check';
import { ConcurrencyMap } from './concurrency-map';
import { type AdvisorIterationState, reReadAdvisorIterationState } from './external-keys.handler';
import { IdempotencyMap } from './idempotency-map';
import {
  createUnusualWhalesClient,
  MarketDataCache,
  MarketDataMeter,
  type UnusualWhalesClient,
} from './lib/unusual-whales.client';
import { withToolTimeout } from './lib/with-tool-timeout';
import { persistTurn } from './persistence';
import type { ProviderStreamEvent, ProviderToolDecl } from './providers/adapter';
import { getProvider } from './providers/registry';
import {
  flattenToolPartsForNonToolModel,
  redactRevokedToolResults,
  redactSummaryForProvider,
} from './replay-redaction';
import {
  type PriorSummary,
  type SummarizableMessage,
  type SummaryUsage,
  summarize,
} from './summarize';
import { buildDeclarations } from './tools/declarations';
import {
  type DispatchDeps,
  type DispatchSnapshot,
  type ToolCall,
  createTurnState,
  dispatchTool,
} from './tools/dispatch';
import { NOTICE_CODES, bucketOf } from './tools/error-codes';

// --- Module-level singletons (shared by the route + bootstrap) ---------------

/** Per-user single-in-flight-stream cap (REQ-3.5). */
export const concurrencyMap = new ConcurrencyMap();

/** In-process Layer-2 idempotency map (REQ-3.12). Existing-conversation only. */
export const idempotencyMap = new IdempotencyMap();

// --- Constants ---------------------------------------------------------------

const WALL_CLOCK_MS = 480_000; // REQ-3.7 per-turn wall-clock budget (§C3 v4)
const CONNECT_TIMEOUT_MS = 15_000; // REQ-3.8 first-event watchdog
const INACTIVITY_TIMEOUT_MS = 60_000; // REQ-3.8 per-provider-call watchdog (§C3)
/** Max model→tools round-trips per turn before the forced-final call (REQ-3.2). */
const MAX_TOOL_ITERATIONS = 6;
/**
 * Aggregate degeneracy-class failure budget (M) for the DEGENERATE_TOOL_FAILURE
 * backstop (REQ-1.9). The early-abort fires only when this budget is reached AND
 * `successCount === 0` — a turn with any productive success never trips it.
 */
const MAX_DEGENERATE_FAILURES = 6;
/** Per-tool execution timeout for `withToolTimeout` (REQ-3.6). */
const PER_TOOL_TIMEOUT_MS = 15_000;
/** Argument/summary preview cap on tool SSE frames (≤2KB — §C3). */
const TOOL_PREVIEW_MAX_BYTES = 2_048;
/** System suffix appended on the forced-final call when the loop is exhausted. */
const FORCED_FINAL_SYSTEM_SUFFIX =
  'You have reached the tool-use limit. Answer with only the information you ' +
  'have already gathered; state that you could not finish gathering data.';
/** Auto-summarization trigger: estimate above this fraction → summarize (§C8). */
const SUMMARIZE_TRIGGER_RATIO = 0.75;
/** The single residual hard wall (§C8 step 3) — too large even after summarizing. */
const HARD_STOP_RATIO = 0.95;

// --- Public types ------------------------------------------------------------

/**
 * Pre-loaded streaming context. The route handler (Task 24) performs steps 1-3
 * (validate, ownership, load history + persona + provider key + model) and
 * decrypts the BYOK key (step 4), then hands the result to {@link prepare}. This
 * keeps prepare()'s pre-stream sequencing (steps 5-9) free of DB / HTTP concerns
 * and independently testable.
 */
export interface StreamContext {
  providerId: ProviderId;
  modelId: string;
  /** Selected model's metadata — used for the context-window hard cap. */
  providerModel: ProviderModel;
  /**
   * Plaintext BYOK provider key. The caller (advisor route / stream.handler —
   * Task 24) is responsible for loading the conversation context, asserting
   * conversation ownership, and DECRYPTING the BYOK key BEFORE calling
   * {@link prepare}. A decrypt failure must be mapped by the route to the
   * KEY_DECRYPT_FAILED error (see design.md §Component 3 step 4) — prepare()
   * assumes the key is already plaintext.
   */
  apiKey: string;
  /** Prior turns in chronological order. */
  history: ReadonlyArray<
    | { role: 'user'; parts: readonly CanonicalPart[] }
    | { role: 'assistant'; parts: readonly CanonicalPart[] }
  >;
  /** Resolved persona, or null when none applies. */
  persona: { systemPrompt: string } | null;
  /** Persisted persona id (for the conversation row), or null. */
  personaId: string | null;
  /**
   * Trade-data consent snapshot read at prepare time (REQ-1.7). Drives
   * `buildDeclarations` and the redaction seam. Defaults to `false`.
   */
  consentAtPrepare?: boolean;
  /** Whether the user has an Unusual Whales key (drives `buildDeclarations`). */
  hasUwKey?: boolean;
  /** Encrypted UW key ciphertext, threaded to the loop for lazy decrypt (Task 7). */
  uwKeyCiphertext?: string | null;
  /**
   * Gate-time reservation hold (micro-USD) taken on the platform path before
   * `prepare()` (wallet-billing Component 6 / REQ-6.3). Threaded onto the stream
   * so the in-loop non-debit exit arms can `releaseReservation()` and Task 14 can
   * reconcile `reserved −= held` at the inserted-row debit. Undefined / 0n for
   * BYOK turns (no reservation taken).
   */
  reservationHeld?: bigint;
  /**
   * Platform billing-mode marker (plan-tiers D10/D11): the explicit signal the
   * handler sets on the PLATFORM path — `'credits'` (wallet-billed) or
   * `'allowance'` (subsidized free-tier turn, zero reservation). ABSENT /
   * undefined for BYOK turns. `runStreaming` builds `persistTurn`'s `billing`
   * arg iff this marker is present and copies `mode` from it verbatim — the
   * construction site carries no mode literal. Distinct from the client-facing
   * `BILLING_MODE` SSE notice's `'platform' | 'byok'` wire values, which this
   * marker never feeds.
   */
  platformBillingMode?: 'credits' | 'allowance';
}

export interface PrepareArgs {
  /** Existing conversation id, or null on the new-conversation path. */
  conversationId: string | null;
  userId: string;
  input: StreamRequestInput;
  abortSignal: AbortSignal;
  context: StreamContext;
}

/** Result of {@link prepare}: either a ready-to-stream context or a Layer-2 hit. */
export type Prepared =
  | {
      kind: 'stream';
      conversationId: string | null;
      userId: string;
      clientMessageId: string;
      providerId: ProviderId;
      modelId: string;
      apiKey: string;
      /** Canonical list assembled in step 7 (history + new message + persona). */
      messages: CanonicalMessage[];
      /** New user message parts (for persistence). */
      newMessageParts: CanonicalPart[];
      personaId: string | null;
      combinedSignal: AbortSignal;
      /** True when this conversation participates in the Layer-2 map. */
      idempotent: boolean;
      /** Iteration-0 snapshot for the tool loop (design §C8 / REQ-1.7). */
      toolUse: boolean;
      hasUwKey: boolean;
      uwKeyCiphertext: string | null;
      consentAtPrepare: boolean;
      /**
       * Provider usage of the auto-summarization call `prepare()` made on the
       * platform key, when one ran AND the provider reported usage (wallet-billing
       * Component 7 / REQ-5.1). `runStreaming` SEEDS the `MeteredUsage` accumulator
       * with it so the metered turn total includes the summary call. Undefined when
       * no summary ran or no usage was reported (the accumulator estimates instead).
       */
      summaryUsage?: SummaryUsage;
      /**
       * Gate-time reservation hold (micro-USD) carried into the stream so the
       * non-debit exit arms `releaseReservation()` and Task 14 reconciles it at
       * the inserted-row debit (wallet-billing Component 6 / REQ-6.3). 0n for BYOK.
       */
      reservationHeld: bigint;
      /**
       * Platform billing-mode marker (plan-tiers D10/D11), copied from
       * {@link StreamContext.platformBillingMode}: present on platform turns
       * (`'credits' | 'allowance'`), undefined for BYOK. The persist seam
       * builds the `billing` arg iff this is present.
       */
      platformBillingMode?: 'credits' | 'allowance';
    }
  | { kind: 'synthetic-done'; messageId: string; source: 'layer-2' }
  | {
      /**
       * The single residual hard wall (§C8 step 3): too large even after
       * summarization. `runStreaming` emits this as `event: error` (terminating).
       */
      kind: 'error';
      code: 'CONVERSATION_TURN_TOO_LARGE';
      bucket: ReturnType<typeof bucketOf>;
    };

export type SseFrame =
  | { event: 'token'; data: string }
  | { event: 'usage'; data: string }
  | { event: 'tool_call'; data: string }
  | { event: 'tool_result'; data: string }
  | { event: 'notice'; data: string }
  | { event: 'done'; data: string }
  | { event: 'error'; data: string };

/**
 * Cumulative provider token usage across EVERY provider call a platform turn
 * makes (wallet-billing Component 7 / REQ-5.1): each tool-loop round-trip AND the
 * auto-summarization call. Unlike the assistant-message `promptTokens` /
 * `completionTokens` columns (which keep their last-call semantics), this SUMS so
 * the metered total matches what the platform key was actually billed.
 *
 * Consumed only by the metering / `usage_record` / debit path: the accumulator
 * lives in `runStreaming`'s closure and is fully populated by the time the
 * post-stream `persistTurn` call site is reached, so Task 14 reads `meteredUsage`
 * there and passes it into `persistTurn`'s `billing` arg to price the whole turn.
 */
export interface MeteredUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Fresh zeroed accumulator, optionally seeded with the summary call's usage. */
export function createMeteredUsage(seed?: SummaryUsage): MeteredUsage {
  return {
    inputTokens: seed?.promptTokens ?? 0,
    outputTokens: seed?.completionTokens ?? 0,
  };
}

// --- Helpers -----------------------------------------------------------------

/** Build the new user message parts from the validated request body. */
function buildNewMessageParts(input: StreamRequestInput): CanonicalPart[] {
  const parts: CanonicalPart[] = [{ type: 'text', text: input.text }];
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === 'image') {
      parts.push({
        type: 'image',
        format: attachment.format,
        dataBase64: attachment.dataBase64,
      });
    }
  }
  return parts;
}

function imageCountOf(parts: CanonicalPart[]): number {
  return parts.filter((p) => p.type === 'image').length;
}

/** Object-storage `Content-Type` for a persisted advisor image (D9 write path). */
const IMAGE_CONTENT_TYPE: Record<'png' | 'jpeg' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Chronological prior turns, as carried on {@link StreamContext}. */
type StreamHistory = StreamContext['history'];

/**
 * Adapt the prepared history into the summarizer's `SummarizableMessage[]`. The
 * summary boundary is a `createdAt` timestamp (§C8 v4); `StreamContext.history`
 * does not yet carry per-message timestamps, so we synthesize a strictly
 * increasing ordinal preserving chronological order. The route (Task 24) will
 * supply real timestamps once history loading carries them.
 */
function toSummarizable(history: StreamHistory): SummarizableMessage[] {
  return history.map((m, i) => ({
    role: m.role,
    parts: m.parts as unknown as { type: string; [k: string]: unknown }[],
    createdAt: new Date(i),
  }));
}

/** Strip the summarizer's `createdAt` back to the prepared-history shape. */
function fromSummarizable(window: SummarizableMessage[]): StreamHistory {
  return window.map((m) => ({
    role: m.role,
    parts: m.parts as unknown as readonly CanonicalPart[],
  })) as StreamHistory;
}

/**
 * Provider-entry resolution seam (design §Component 2, D10 — the convergence-
 * critical fix; REQ-2.6/2.3). Runs ONCE, upfront, over the WHOLE persisted
 * history immediately after `loadStreamContext` (stream.handler.ts) and BEFORE
 * the provider chain (redact → flatten → assemble → each adapter's
 * `prepareForTokenCount`/`countTokens`/`translate`). It re-inlines every history
 * image pointer to inline `CanonicalPart` bytes so the ENTIRE downstream chain —
 * both adapters included — keeps operating on narrow inline parts exactly as
 * today and stays unmodified.
 *
 * Why upfront: Claude's `prepareForTokenCount === translate` reads
 * `part.dataBase64`, so a bytes-less pointer part would emit `data: undefined`
 * → `countTokens` 400 → a silent heuristic downgrade on every pointer-bearing
 * Claude turn. Resolving at the root removes that whole class.
 *
 * A `Map<key, Promise<{ dataBase64 }>>` fetches each DISTINCT object key at most
 * ONCE across the whole turn (cross-message dedup). It holds no pooled DB
 * connection across the bucket egress (it runs after `loadStreamContext`
 * releases). An unfetchable pointer — `storage.get` throws (`ObjectUnreachableError`)
 * or the part is `{ storage: { kind: 'unrecoverable' } }` — becomes
 * `{ type: 'text', text: '[image unavailable]' }` + an `object-store-unreachable`
 * warn (NFR M2 §19), so no consumer ever sees a bytes-less image (REQ-2.6).
 * Inline / legacy / text / tool parts pass through unchanged. Storage OFF ⇒ a
 * PURE passthrough (no behavioral change, REQ-1.2). The new message's own images
 * reach the provider inline this turn via the request path (Task 6), NOT here.
 */
export async function resolveForProvider(
  history: ReadonlyArray<
    | { role: 'user'; parts: readonly StoredContentPart[] }
    | { role: 'assistant'; parts: readonly StoredContentPart[] }
  >,
): Promise<Array<{ role: 'user' | 'assistant'; parts: CanonicalPart[] }>> {
  const storage = getObjectStorage();
  // Storage OFF (self-host default): pure passthrough. Persisted parts are all
  // inline `CanonicalPart` on this path; narrow with no bucket round-trip.
  if (!storage) {
    return history.map((m) => ({ role: m.role, parts: [...m.parts] as CanonicalPart[] }));
  }

  // Fetch each distinct object key at most once across the whole turn.
  const fetches = new Map<string, Promise<{ dataBase64: string }>>();
  const fetchOnce = (key: string): Promise<{ dataBase64: string }> => {
    let inflight = fetches.get(key);
    if (!inflight) {
      inflight = storage.get(key).then(({ bytes }) => ({
        dataBase64: Buffer.from(bytes).toString('base64'),
      }));
      fetches.set(key, inflight);
    }
    return inflight;
  };

  const unavailable = (): CanonicalPart => ({ type: 'text', text: '[image unavailable]' });

  const resolved: Array<{ role: 'user' | 'assistant'; parts: CanonicalPart[] }> = [];
  for (const message of history) {
    const parts: CanonicalPart[] = [];
    for (const part of message.parts) {
      if (!('storage' in part)) {
        // Inline image / text / tool_call / tool_result — already a CanonicalPart.
        parts.push(part);
        continue;
      }
      if (part.storage.kind === 'unrecoverable') {
        logger.warn('advisor history image unavailable', {
          event: 'object-store-unreachable',
          reason: 'unrecoverable',
        });
        parts.push(unavailable());
        continue;
      }
      // Object pointer — re-inline the stored bytes (deduped across the turn).
      try {
        const { dataBase64 } = await fetchOnce(part.storage.key);
        parts.push({ type: 'image', format: part.format, dataBase64 });
      } catch (error) {
        logger.warn('advisor history image unavailable', {
          event: 'object-store-unreachable',
          reason: 'get-failed',
          error: error instanceof Error ? error.message : String(error),
        });
        parts.push(unavailable());
      }
    }
    resolved.push({ role: message.role, parts });
  }
  return resolved;
}

/**
 * Typed redaction seam (design §Component 8 / REQ-9.6). Both the summarize-call
 * input and the provider replay are routed through this function so consent
 * revocation has exactly one place to strip trade-data parts + separated figures.
 *
 * On a revoked conversation (`consent === false`) every persisted
 * `tool_result` part is replaced with a fixed text marker so trade-data
 * snapshots are never replayed to the provider (REQ-9.6). With consent the
 * history passes through unchanged. Because this runs on BOTH the replay input
 * and the summarize-call input — and BEFORE the summarize pass and BEFORE the
 * degraded flatten (ordering pinned, §C7) — the summarizer is fed a redacted
 * history and so cannot emit `tradeDataFigures`; the summary figures are
 * omitted with no extra LLM call, and extend-prior feeds prior prose only.
 * Never applied on the render path (REQ-14.5).
 */
export function redactForProvider(history: StreamHistory, consent: boolean): StreamHistory {
  return redactRevokedToolResults(history, consent) as StreamHistory;
}

/**
 * Conversation-only flatten seam (design §Component 10 / REQ-13.3). When the
 * selected model has `toolUse === false`, persisted `tool_call`/`tool_result`
 * parts are folded into their assistant message's text so a non-tool model
 * still receives a coherent transcript. MUST run AFTER {@link redactForProvider}
 * (ordering pinned §C7) so a revoked `tool_result` is already the fixed marker
 * before flattening sees it. `toolUse === true` is identity (no flatten).
 * Adds no messages and cannot break alternation (tool parts live inside the
 * assistant message). Render path is never flattened (REQ-14.5 / REQ-4.4).
 */
export function flattenForNonToolModel(history: StreamHistory, toolUse: boolean): StreamHistory {
  return flattenToolPartsForNonToolModel(history, toolUse) as StreamHistory;
}

/**
 * Summary-side redaction seam (design §Component 7 / REQ-9.6 / REQ-9.9, channel
 * (b)). Routes an EXISTING summary through {@link redactSummaryForProvider} so
 * that on a revoked conversation its separated `tradeDataFigures` are omitted
 * (prose only, NO LLM call) before the summary reaches the provider — whether
 * via `assembleCanonicalMessages(summary=…)` or `summarize(priorSummary=…)`.
 *
 * `prepare()` currently passes `null` here, so this is a structural seam: a
 * future wiring of a loaded `advisor_summaries` record cannot leak figures on a
 * revoked conversation. The consent-granted path and the null case are identity.
 */
function redactSummaryOnPath<S extends { prose: string; tradeDataFigures?: string | null }>(
  summary: S | null | undefined,
  consent: boolean,
): S | null | undefined {
  return redactSummaryForProvider(summary, consent);
}

function frame(event: SseFrame['event'], data: unknown): SseFrame {
  return { event, data: JSON.stringify(data) } as SseFrame;
}

/**
 * Serialize a value to a string preview bounded at {@link TOOL_PREVIEW_MAX_BYTES}
 * (§C3 — `tool_call`/`tool_result` SSE frames carry a ≤2KB preview, not the full
 * payload). The full content is persisted in the assistant message's parts; the
 * SSE preview is only for the live affordance.
 */
function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    s = String(value);
  }
  return s.length > TOOL_PREVIEW_MAX_BYTES ? s.slice(0, TOOL_PREVIEW_MAX_BYTES) : s;
}

// --- prepare() ---------------------------------------------------------------

/**
 * Pre-stream sequencing (design §Component 3, steps 5-9). The caller has already
 * done steps 1-4 (validate, ownership, load context, decrypt key).
 *
 * Throws an AppError on any pre-stream failure. On a throw AFTER the concurrency
 * slot is acquired, the internal catch releases the slot and removes any reserved
 * idempotency entry (v4-10) so no leak survives. On a Layer-2 dedupe hit it
 * returns a `synthetic-done` Prepared and releases the brief slot it acquired.
 */
export async function prepare(
  args: PrepareArgs,
): Promise<{ prepared: Prepared; releaseSlot: () => void }> {
  const { conversationId, userId, input, abortSignal, context } = args;
  const clientMessageId = input.clientMessageId;
  // Layer-2 map is bypassed for new-conversation flows (v2-1).
  const idempotent = conversationId !== null;

  // Step 5a — idempotency PEEK (non-mutating; existing-conversation only).
  if (idempotent) {
    const peek = idempotencyMap.peek(userId, conversationId, clientMessageId);
    if (peek.kind === 'hit-in-progress') {
      // RETRY_WHILE_IN_FLIGHT — surfaced as a thrown AppError pre-stream.
      const { RetryWhileInFlightError } = await import('./advisor.errors');
      throw new RetryWhileInFlightError();
    }
    if (peek.kind === 'hit-done') {
      // Layer-2 hit — no slot, no upstream call.
      logger.info('advisor dedupe hit', {
        code: 'LAYER_2_DEDUPE_HIT',
        userId,
        conversationId,
        clientMessageId,
      });
      return {
        prepared: {
          kind: 'synthetic-done',
          messageId: peek.assistantMessageId,
          source: 'layer-2',
        },
        // No slot was acquired; releaseSlot is a no-op.
        releaseSlot: () => {},
      };
    }
  }

  // Step 5b — acquire the concurrency slot. Throws StreamInProgressError (429).
  const { release: releaseSlotRaw, combinedSignal } = concurrencyMap.acquire(userId, abortSignal);

  let releasedSlot = false;
  const releaseSlot = () => {
    if (releasedSlot) return;
    releasedSlot = true;
    releaseSlotRaw();
  };

  let reserved = false;

  try {
    // Step 6 — reserve the idempotency entry under the held slot.
    if (idempotent) {
      idempotencyMap.reserve(userId, conversationId, clientMessageId, new AbortController());
      reserved = true;
    }

    // A terminating §C8 hard wall: surface it as a `kind:'error'` Prepared that
    // runStreaming converts to an `event: error` frame. Remove the reserved
    // idempotency entry now (no in-progress ghost) so a retry can re-run; the
    // slot is freed by the route via the returned releaseSlot (v4-1).
    const emitPrepareError = (code: 'CONVERSATION_TURN_TOO_LARGE') => {
      if (reserved && conversationId !== null) {
        idempotencyMap.removeIdempotencyEntry(userId, conversationId, clientMessageId);
      }
      return {
        prepared: { kind: 'error' as const, code, bucket: bucketOf(code) },
        releaseSlot,
      };
    };

    // Step 7 — assemble the canonical message list.
    const newMessageParts = buildNewMessageParts(input);
    const adapter = getProvider(context.providerId);
    const imageCount = imageCountOf(newMessageParts);

    // Iteration-0 snapshot (REQ-1.7): consent + key presence + model capability.
    const consent = context.consentAtPrepare ?? false;
    const hasUwKey = context.hasUwKey ?? false;
    const toolUse = context.providerModel.toolUse;
    const caps = { toolUse };
    // Tool declarations offered this turn — folded into the estimate so the
    // trigger accounts for the declaration payload (§Component 8 step 1).
    const toolDeclarations = buildDeclarations(caps, consent, hasUwKey) as ProviderToolDecl[];

    // Replay/summarize input is routed through the redaction seam (§C8 / REQ-9.6),
    // then — for a conversation-only model — through the flatten seam (§C10 /
    // REQ-13.3). Order is pinned: redaction BEFORE flatten so a revoked
    // tool_result is the fixed marker before it is folded into text.
    const redactedHistory = flattenForNonToolModel(
      redactForProvider(context.history, consent),
      toolUse,
    );
    let messages = assembleCanonicalMessages({
      history: redactedHistory,
      persona: context.persona,
      newMessage: newMessageParts,
    });

    // Step 8 — estimate (history + new message + persona + tool declarations +
    // existing summary). 5-s timeout / auth short-circuit live in cap-check.ts.
    const estimate = await estimateTokens({
      adapter,
      list: messages,
      modelId: context.modelId,
      apiKey: context.apiKey,
      imageCount,
      toolDeclarations,
    });

    const window = context.providerModel.contextWindow;

    // The summary LLM call's provider usage, threaded into the Prepared so
    // runStreaming seeds the platform metering accumulator with it (Component 7).
    let summaryUsage: SummaryUsage | undefined;

    // Step 9 — auto-summarization (§Component 8). Over 0.75 × window → summarize
    // and re-assemble; re-estimate; still over 0.95 → the single residual hard
    // stop (CONVERSATION_TURN_TOO_LARGE). The old 0.95 ConversationTooLongError
    // throw is gone (dual hard cap removed).
    if (estimate.tokens > SUMMARIZE_TRIGGER_RATIO * window) {
      // An existing summary loaded for extend-prior recurrence (today: none).
      // Routed through the summary redaction seam so a revoked conversation can
      // never feed its separated `tradeDataFigures` into the summarize call
      // (REQ-9.6 / REQ-9.9). On revoke the figures become `undefined`; the
      // summarizer's PriorSummary expects `string | null`, so normalize.
      const priorSummary = redactSummaryOnPath<PriorSummary>(null, consent);
      const redactedPriorSummary: PriorSummary | null = priorSummary
        ? { ...priorSummary, tradeDataFigures: priorSummary.tradeDataFigures ?? null }
        : null;

      const outcome = await summarize({
        adapter,
        apiKey: context.apiKey,
        modelId: context.modelId,
        contextWindow: window,
        history: toSummarizable(redactedHistory),
        newMessage: newMessageParts,
        persona: context.persona,
        toolDeclarations,
        imageCount,
        priorSummary: redactedPriorSummary,
      });

      if (outcome.kind === 'error') {
        return emitPrepareError(outcome.code);
      }

      // Capture the summary call's usage (when one ran and was reported) so the
      // platform metering accumulator can charge it (Component 7 / REQ-5.1).
      summaryUsage = outcome.usage;

      // Re-assemble with the produced summary + verbatim window, both routed
      // through the redaction seam, then re-estimate.
      const redactedWindow = flattenForNonToolModel(
        redactForProvider(fromSummarizable(outcome.window), consent),
        toolUse,
      );
      messages = assembleCanonicalMessages({
        history: redactedWindow,
        persona: context.persona,
        // Routed through the summary redaction seam (REQ-9.6 / REQ-9.9): on a
        // revoked conversation an existing summary's `tradeDataFigures` are
        // omitted before reaching the system message assemble.ts appends them
        // to. The freshly produced summary already carries figures only when
        // consent permits (it is built from the redacted history), so this is
        // identity on the consent-granted path.
        summary: redactSummaryOnPath(outcome.summary, consent),
        newMessage: newMessageParts,
      });
      const reEstimate = await estimateTokens({
        adapter,
        list: messages,
        modelId: context.modelId,
        apiKey: context.apiKey,
        imageCount,
        toolDeclarations,
      });
      if (reEstimate.tokens > HARD_STOP_RATIO * window) {
        return emitPrepareError('CONVERSATION_TURN_TOO_LARGE');
      }
    }

    return {
      prepared: {
        kind: 'stream',
        conversationId,
        userId,
        clientMessageId,
        providerId: context.providerId,
        modelId: context.modelId,
        apiKey: context.apiKey,
        messages,
        newMessageParts,
        personaId: context.personaId,
        combinedSignal,
        idempotent,
        toolUse,
        hasUwKey,
        uwKeyCiphertext: context.uwKeyCiphertext ?? null,
        consentAtPrepare: consent,
        summaryUsage,
        reservationHeld: context.reservationHeld ?? 0n,
        platformBillingMode: context.platformBillingMode,
      },
      releaseSlot,
    };
  } catch (err) {
    // v4-10: any throw between slot acquire and return releases the slot AND
    // removes the reserved idempotency entry so no in-progress ghost survives.
    if (reserved && conversationId !== null) {
      idempotencyMap.removeIdempotencyEntry(userId, conversationId, clientMessageId);
    }
    releaseSlot();
    throw err;
  }
}

// --- runStreaming() ----------------------------------------------------------

type AbortReason = 'connect-timeout' | 'inactivity-timeout' | 'wall-clock' | 'client-disconnect';

/**
 * Translate a provider stream event into an SSE frame.
 */
function translateProviderEvent(evt: ProviderStreamEvent): SseFrame | null {
  if (evt.type === 'token') {
    return frame('token', { delta: evt.delta });
  }
  if (evt.type === 'usage') {
    return frame('usage', {
      promptTokens: evt.promptTokens,
      completionTokens: evt.completionTokens,
    });
  }
  // 'done' is emitted by runStreaming after persistence, not from this event.
  return null;
}

/**
 * Test/integration seams for {@link runStreaming}. Production callers pass
 * nothing; the loop then dispatches against the real `toolRegistry`. Loop tests
 * (tasks 25/27) inject a scripted registry (`makeScriptedRegistry`) so the real
 * `dispatchTool` runs against scripted tool results.
 */
export interface RunStreamingOptions {
  /** Injected tool registry; defaults to the real `toolRegistry` inside dispatch. */
  registry?: DispatchDeps['registry'];
  /**
   * Per-iteration authorization re-read (REQ-1.7). Defaults to the real
   * {@link reReadAdvisorIterationState} (DB-backed). Loop tests inject a scripted
   * snapshot so a mid-turn consent revoke / key delete / key rotation can be
   * exercised without a database.
   */
  reReadIterationState?: (userId: string) => Promise<AdvisorIterationState>;
  /**
   * UW-client factory seam (REQ-1.7 rotation). Defaults to
   * {@link createUnusualWhalesClient} decrypting the supplied ciphertext. Loop
   * tests inject a fake client (or `fetchImpl`) so the timeout→rebuild path can
   * be asserted without a live socket. Receives the current iteration's plaintext
   * key + shared cache/meter and returns the client `dispatchTool` hands to
   * market-data handlers.
   */
  makeUwClient?: (
    apiKey: string,
    userId: string,
    deps: { cache: MarketDataCache; meter: MarketDataMeter },
  ) => UnusualWhalesClient;
}

/**
 * Stream the completion (design §Component 3 — the bounded agentic loop). Yields
 * SSE frames and, on a final answer, persists the single-row turn + transitions
 * the idempotency entry to done.
 *
 * Does NOT call releaseSlot (v4-1) — that is the route handler's responsibility.
 */
export async function* runStreaming(
  prepared: Prepared,
  opts?: RunStreamingOptions,
): AsyncIterable<SseFrame> {
  const __registryOverride = opts?.registry;
  if (prepared.kind === 'synthetic-done') {
    yield frame('done', {
      messageId: prepared.messageId,
      deduped: true,
      source: prepared.source,
    });
    return;
  }

  if (prepared.kind === 'error') {
    // The single residual §C8 hard wall (CONVERSATION_TURN_TOO_LARGE). It is a
    // terminating event:error frame; no upstream call, no persistence. The
    // reserved idempotency entry was already removed in prepare().
    yield frame('error', { code: prepared.code, upstreamStatus: null });
    return;
  }

  const {
    conversationId,
    userId,
    clientMessageId,
    providerId,
    modelId,
    apiKey,
    messages,
    newMessageParts,
    personaId,
    combinedSignal,
    idempotent,
    toolUse,
    consentAtPrepare,
    summaryUsage,
    reservationHeld,
    platformBillingMode,
  } = prepared;

  const adapter = getProvider(providerId);

  // Per-iteration authorization seams (REQ-1.7). Default to the real DB-backed
  // re-read + the real UW-client constructor (decrypting the current ciphertext);
  // loop tests inject scripted versions.
  const reReadIterationState = opts?.reReadIterationState ?? reReadAdvisorIterationState;
  const makeUwClientFactory =
    opts?.makeUwClient ??
    ((apiKey: string, userId: string, deps: { cache: MarketDataCache; meter: MarketDataMeter }) =>
      createUnusualWhalesClient({ apiKey, userId, cache: deps.cache, meter: deps.meter }));

  // The internal abort controller fed by the app-level timers. It is folded into
  // combinedSignal indirectly: we abort it AND the ConcurrencyMap's internal
  // controller is what backs combinedSignal — but timers here use a dedicated
  // controller chained onto combinedSignal so client-disconnect and app-timers
  // both surface through one signal handed to the adapter.
  const timerController = new AbortController();
  // combinedAbortReason is set BEFORE calling combinedAbort() so the catch can
  // tell app-timer firings apart from external aborts (v3-4 / v4-11). It is NOT
  // re-set after combinedAbort() per the task restriction.
  let combinedAbortReason: AbortReason | null = null;

  const combinedAbort = (reason: AbortReason) => {
    if (!combinedAbortReason) combinedAbortReason = reason;
    timerController.abort();
  };

  // Fold the prepared combinedSignal (client-disconnect / external) into the
  // timer controller so the adapter sees a single signal.
  const onExternalAbort = () => {
    if (!combinedAbortReason) {
      combinedAbortReason = 'client-disconnect';
      logger.debug('streaming aborted by client', { userId, conversationId });
    }
    timerController.abort();
  };
  if (combinedSignal.aborted) {
    onExternalAbort();
  } else {
    combinedSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const clearAll = () => {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    if (connectTimer) clearTimeout(connectTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  };

  const armInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => combinedAbort('inactivity-timeout'), INACTIVITY_TIMEOUT_MS);
  };

  const removeEntry = () => {
    if (idempotent && conversationId !== null) {
      idempotencyMap.removeIdempotencyEntry(userId, conversationId, clientMessageId);
    }
  };

  // Non-debit exit release (wallet-billing Component 6 / REQ-6.3): every in-loop
  // exit arm that does NOT debit (provider error, app-timer abort,
  // client-disconnect, degenerate-tool abort, mid-loop abort) releases the
  // gate-time hold alongside `removeEntry()`. `releaseReservation` no-ops on a
  // 0n hold (BYOK), and is guarded so a turn releases at most once. The ONLY
  // non-releasing in-loop exit is the successful persist (Task 14 reconciles the
  // hold with the debit there). The Layer-1 deduped persist arm releases in
  // persistTurn (Task 14) — NOT here.
  let holdReleased = false;
  const releaseHold = async () => {
    if (holdReleased) return;
    holdReleased = true;
    await releaseReservation(userId, reservationHeld);
  };

  const wallClockTimer = setTimeout(() => combinedAbort('wall-clock'), WALL_CLOCK_MS);
  const connectTimer = setTimeout(() => combinedAbort('connect-timeout'), CONNECT_TIMEOUT_MS);

  let receivedFirstEvent = false;
  // Last-call usage — persisted on the assistant-message row, KEEPING its existing
  // last-call semantics (the metering accumulator below is the billing truth).
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  // Cumulative metering accumulator (wallet-billing Component 7 / REQ-5.1): SUMS
  // input/output tokens across every provider call this turn makes — each tool-loop
  // round-trip below AND the auto-summarization call (seeded from prepare). Feeds
  // ONLY the metering/usage_record/debit path (Task 14), never the message row.
  const meteredUsage = createMeteredUsage(summaryUsage);

  // The single growing assistant message: one ordered parts array accumulating
  // text / tool_call / tool_result across every iteration, persisted as ONE
  // assistant row (§C3 / REQ-4.3).
  const assistantParts: CanonicalPart[] = [];
  // Per-turn dispatch accounting (REQ-1.9 / REQ-9.5). The withdrawn-filter and
  // M/successCount early-abort that read these are a task-27 seam.
  const turnState = createTurnState();
  const caps = { toolUse };
  // Per-iteration authorization snapshot (REQ-1.7). Seeded from the iteration-0
  // prepare() snapshot; refreshed at the top of each iteration > 0 by the re-read
  // helper so a mid-turn consent revoke / key delete / key rotation is honored on
  // the next round-trip. `caps.toolUse` is immutable within a turn (not re-read).
  let consent = consentAtPrepare;
  let hasUwKey = prepared.hasUwKey;
  // The current iteration's encrypted-key envelope string (what `decrypt`
  // consumes). Iteration 0 carries the prepare() ciphertext; each later iteration
  // overwrites it from the re-read so a rotated key (new ciphertext) is honored.
  let uwKeyCiphertext: string | null = prepared.uwKeyCiphertext;
  // The TTL cache + per-user meter are owned by the turn and SHARED across every
  // per-iteration UW client rebuild (the rebuilt client carries the new key but
  // the same cache/meter — design §Component 5).
  const uwCache = new MarketDataCache();
  const uwMeter = new MarketDataMeter();
  let incomplete = false; // set on the forced-final path (REQ-3.2)

  /** Build this round-trip's working messages: base + the growing assistant msg. */
  const workingMessages = (): CanonicalMessage[] =>
    assistantParts.length > 0
      ? [...messages, { role: 'assistant', parts: [...assistantParts] }]
      : messages;

  /** Forced-final messages (tools omitted) with the "answer with what you have" suffix. */
  const forcedFinalMessages = (): CanonicalMessage[] => {
    const base = workingMessages();
    const head = base[0];
    if (head && head.role === 'system') {
      const rest = base.slice(1);
      return [
        { role: 'system', content: `${head.content}\n\n${FORCED_FINAL_SYSTEM_SUFFIX}` },
        ...rest,
      ];
    }
    return [{ role: 'system', content: FORCED_FINAL_SYSTEM_SUFFIX }, ...base];
  };

  /**
   * Consume one provider stream, accumulating text into `assistantParts`, the
   * latest usage, and the call's `tool_call` events. Inactivity is armed on each
   * event (the connect watchdog is cleared on the first event of the turn) and
   * CLEARED by the caller before any tool work (§C3 timers fix). Yields token /
   * usage SSE frames as they arrive.
   */
  async function* runProviderCall(
    tools: ProviderToolDecl[] | undefined,
    list: CanonicalMessage[],
  ): AsyncGenerator<SseFrame, { toolCalls: ToolCall[]; iterText: string }> {
    const adapterIter = adapter.streamChat({
      apiKey,
      modelId,
      messages: adapter.translate(list, modelId),
      signal: timerController.signal,
      ...(tools ? { tools } : {}),
    });

    const toolCalls: ToolCall[] = [];
    let iterText = '';

    for await (const evt of adapterIter) {
      if (!receivedFirstEvent) {
        receivedFirstEvent = true;
        if (connectTimer) clearTimeout(connectTimer);
      }
      armInactivity();

      if (evt.type === 'token') {
        iterText += evt.delta;
      } else if (evt.type === 'usage') {
        // Message-row columns keep LAST-CALL semantics (existing tests rely on it).
        promptTokens = evt.promptTokens;
        completionTokens = evt.completionTokens;
        // Metering accumulator SUMS every round-trip (Component 7 / REQ-5.1). The
        // provider may report null counts; only add concrete numbers. A turn that
        // reports NO usage at all leaves the accumulator at 0 — `persistTurn`'s
        // billing path then substitutes a free local token estimate before pricing
        // so the user is never charged 0 for a real metered turn (REQ-5.6).
        if (evt.promptTokens !== null) meteredUsage.inputTokens += evt.promptTokens;
        if (evt.completionTokens !== null) meteredUsage.outputTokens += evt.completionTokens;
      } else if (evt.type === 'tool_call') {
        toolCalls.push({ id: evt.id, name: evt.name, arguments: evt.arguments });
      }

      const sse = translateProviderEvent(evt);
      if (sse) yield sse;
    }

    return { toolCalls, iterText };
  }

  try {
    let finalReached = false;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      // Per-iteration authorization re-read (REQ-1.7). Iteration 0 uses the
      // prepare() snapshot; every later round-trip refreshes consent + key
      // presence + the current key ciphertext (a single small indexed read whose
      // connection is released immediately). So a mid-turn consent revoke
      // withdraws trade-data tools, a mid-turn key delete withdraws market-data
      // tools, and a key rotation feeds the new ciphertext into this iteration's
      // client rebuild — all on the NEXT round-trip. Capability is immutable per
      // turn and is NOT re-read.
      if (iter > 0) {
        const refreshed = await reReadIterationState(userId);
        consent = refreshed.consent;
        hasUwKey = refreshed.hasUwKey;
        uwKeyCiphertext = refreshed.uwKeyCiphertext?.encryptedKey ?? null;
      }

      // Filter out tools withdrawn after K cumulative degeneracy-class failures
      // (REQ-1.9, primary mechanism): a withdrawn tool is no longer offered, so
      // once the surviving set empties the model gets NO tools and the loop
      // breaks on the empty-tool-calls path (the model answers from what it has).
      const decls = (buildDeclarations(caps, consent, hasUwKey) as ProviderToolDecl[]).filter(
        (d) => !turnState.withdrawn.has(d.name),
      );
      // Empty declarations → a conversation-only (no-tools) call (REQ-13.1).
      const tools = decls.length > 0 ? decls : undefined;

      const { toolCalls, iterText } = yield* runProviderCall(tools, workingMessages());

      // Stop the watchdog before any tool work (§C3): a multi-tool batch must not
      // trip the provider-liveness inactivity timer; the next call re-arms it.
      if (inactivityTimer) clearTimeout(inactivityTimer);

      if (iterText) assistantParts.push({ type: 'text', text: iterText });

      if (toolCalls.length === 0) {
        finalReached = true; // the model produced its final answer
        break;
      }

      // Record the calls (ordered) and announce them on the wire (preview ≤2KB).
      for (const c of toolCalls) {
        assistantParts.push({ type: 'tool_call', id: c.id, name: c.name, arguments: c.arguments });
        yield frame('tool_call', {
          id: c.id,
          name: c.name,
          argumentsPreview: preview(c.arguments),
        });
      }

      const snapshot: DispatchSnapshot = { toolUse, consent, hasUwKey };

      // Rebuild the UW client per iteration from the CURRENT ciphertext (REQ-1.7
      // key rotation). The plaintext key is decrypted ONLY here — at market-data
      // context build — and lives only inside this closure; the shared cache +
      // meter persist across iterations. `dispatchTool` invokes this only for
      // market-data tools whose `requires` is satisfied, so no client (and no
      // decrypt) happens when the key was deleted mid-turn.
      const makeUwClient =
        hasUwKey && uwKeyCiphertext !== null
          ? () => {
              const apiKey = decrypt(uwKeyCiphertext!);
              return makeUwClientFactory(apiKey, userId, { cache: uwCache, meter: uwMeter });
            }
          : undefined;

      // Execute SEQUENTIALLY (REQ-3.3).
      for (const c of toolCalls) {
        if (timerController.signal.aborted) {
          // Mid-loop abort → discard the whole turn, persist nothing (REQ-3.8).
          clearAll();
          removeEntry();
          await releaseHold();
          return;
        }

        const perToolController = new AbortController();
        const res = await withToolTimeout(
          // `withToolTimeout` invokes this with `perToolController.signal`, but we
          // don't take it here: the per-tool controller is threaded into
          // `dispatchTool` directly, and `buildToolContext` derives `ctx.signal`
          // from that same controller (chained onto the turn signal). So the
          // handler already reads the controller `withToolTimeout` aborts —
          // accepting the signal arg would just re-name the same object.
          () =>
            dispatchTool(c, { userId, conversationId }, snapshot, turnState, {
              turnSignal: timerController.signal,
              perToolController,
              makeUwClient,
              registry: __registryOverride,
            }),
          PER_TOOL_TIMEOUT_MS,
          perToolController,
        );

        assistantParts.push({
          type: 'tool_result',
          toolCallId: c.id,
          status: res.status,
          content: res.status === 'ok' ? res.content : { code: res.code, message: res.message },
        });
        yield frame('tool_result', {
          toolCallId: c.id,
          status: res.status,
          summary: preview(res.status === 'ok' ? res.content : `${res.code}: ${res.message}`),
        });

        // BACKSTOP (REQ-1.9): early-abort ONLY when the whole turn has produced
        // no productive work — M cumulative degeneracy-class failures AND zero
        // successes. Withdrawal (above) is the PRIMARY mechanism; this catches the
        // all-failing-from-the-start case (e.g. interleaved tools that all fail).
        // It must NOT fire on a turn with any success. No persist on this path.
        if (
          turnState.totalDegenerateFailures >= MAX_DEGENERATE_FAILURES &&
          turnState.successCount === 0
        ) {
          clearAll();
          removeEntry();
          await releaseHold();
          yield frame('error', {
            code: new DegenerateToolFailureError().code,
            upstreamStatus: null,
          });
          return;
        }
      }
    }

    if (!finalReached) {
      // Iteration cap reached (REQ-3.2) → one forced-final call with tools OMITTED.
      const { toolCalls: forcedCalls, iterText: forcedText } = yield* runProviderCall(
        undefined,
        forcedFinalMessages(),
      );
      if (inactivityTimer) clearTimeout(inactivityTimer);

      if (forcedCalls.length > 0) {
        // The model still demands tools after being told it cannot have them →
        // terminating event:error. The turn is still persisted (design §C3:206)
        // so the partial work is recoverable, but NO `done` follows the error.
        clearAll();
        if (forcedText) assistantParts.push({ type: 'text', text: forcedText });
        // Reuse the shared persistence step so this branch inherits the same
        // dedupe/markDone handling and PERSISTENCE_* mapping as the normal path.
        // On a persistence failure it has already yielded a PERSISTENCE_* error
        // frame; do NOT also emit TOOL_LOOP_EXHAUSTED.
        const persisted = yield* persistTurnAndMark();
        if (!persisted) return;
        yield frame('error', { code: new ToolLoopExhaustedError().code, upstreamStatus: null });
        return;
      }

      if (forcedText) assistantParts.push({ type: 'text', text: forcedText });
      incomplete = true;
    }
  } catch (err) {
    clearAll();
    // Every catch arm here is a non-debit exit (provider error, connect/inactivity/
    // wall-clock timeout, client-disconnect) — release the gate-time hold (REQ-6.3).
    await releaseHold();
    // App-timer firings own their failure code (no persist on any of these).
    if (combinedAbortReason === 'connect-timeout') {
      removeEntry();
      yield frame('error', { code: 'PROVIDER_CONNECT_TIMEOUT', upstreamStatus: null });
      return;
    }
    if (combinedAbortReason === 'inactivity-timeout') {
      removeEntry();
      yield frame('error', { code: 'PROVIDER_INACTIVITY_TIMEOUT', upstreamStatus: null });
      return;
    }
    if (combinedAbortReason === 'wall-clock') {
      removeEntry();
      yield frame('error', { code: 'STREAM_TIMEOUT', upstreamStatus: null });
      return;
    }
    if (combinedAbortReason === 'client-disconnect') {
      // v4-11: silent — the client is gone. No SSE frame, no PROVIDER_ERROR.
      removeEntry();
      return;
    }
    // SDK threw something unexpected — map to a provider error frame (REQ-6.8).
    removeEntry();
    const mapped = mapProviderError(err);
    yield frame('error', {
      code: mapped.code,
      upstreamStatus: (mapped as { upstreamStatus?: number | null }).upstreamStatus ?? null,
    });
    return;
  }

  clearAll();

  // The turn reached a final answer (normal or forced). Persist + announce.
  yield* persistAndDone();
  return;

  /**
   * Shared persistence step (REQ-3.8 / v4-1): persist the single-row turn and
   * transition the idempotency entry to done. Used by BOTH the normal final-answer
   * path ({@link persistAndDone}) and the forced-still-tools / TOOL_LOOP_EXHAUSTED
   * path so they share one dedupe/markDone implementation and one PERSISTENCE_*
   * mapping. On success returns the {@link persistTurn} result; on failure it has
   * already removed the entry and yielded the PERSISTENCE_* error frame (logged),
   * and returns `null` so the caller skips its terminal frame.
   */
  async function* persistTurnAndMark(): AsyncGenerator<
    SseFrame,
    Awaited<ReturnType<typeof persistTurn>> | null
  > {
    try {
      // METERING SEAM (wallet-billing REQ-5.7; plan-tiers D10/D11): on the
      // platform path, pass a `billing` arg carrying `meteredUsage` (the
      // cumulative turn total) + the gate reservation so persistTurn counts and
      // bills atomically with the inserted row. The platform discriminator is
      // the EXPLICIT `platformBillingMode` marker the handler threads through
      // prepare()'s context — set (`'credits' | 'allowance'`) on platform
      // turns, absent for BYOK, so BYOK passes no billing arg. `mode` is copied
      // from the marker verbatim (no mode literal here): an allowance turn
      // holds a 0n reservation, so the old `reservationHeld > 0n` test would
      // silently mis-classify it as BYOK.
      const billing = platformBillingMode
        ? {
            userId,
            providerId,
            model: modelId,
            mode: platformBillingMode,
            usage: meteredUsage,
            reservationHeld,
          }
        : undefined;

      // OBJECT-STORAGE WRITE SEAM (REQ-2.7 / D9). When object storage is
      // configured, offload this turn's new image bytes to the bucket and
      // persist a pointer marker instead of inline base64. This runs BEFORE the
      // persistTurn transaction so no pooled DB connection is held across the
      // bucket round-trip (REQ-2.7). The provider already received the inline
      // bytes this turn (assembled in prepare()); this conversion is
      // persist-seam-local and does NOT touch `newMessageParts` / the provider
      // representation (D10). Storage off ⇒ persist the inline parts
      // byte-for-byte, exactly as today (REQ-1.2).
      const storage = getObjectStorage();
      let userContentParts: StoredContentPart[] = newMessageParts;
      if (storage) {
        userContentParts = await Promise.all(
          newMessageParts.map(async (part): Promise<StoredContentPart> => {
            if (part.type !== 'image') return part;
            const key = advisorImageKey(userId);
            await storage.put(
              key,
              Buffer.from(part.dataBase64, 'base64'),
              IMAGE_CONTENT_TYPE[part.format],
            );
            return { type: 'image', format: part.format, storage: { kind: 'object', key } };
          }),
        );
      }

      const result = await persistTurn({
        conversationId,
        userId,
        userMessage: { contentParts: userContentParts, clientMessageId },
        assistantMessage: {
          // Message-row columns KEEP last-call semantics (Component 7) — metering
          // truth lives in usage_records, not here. `meteredUsage` is in scope.
          contentParts: assistantParts,
          promptTokens,
          completionTokens,
        },
        providerId,
        modelId,
        personaId,
        billing,
      });

      if (idempotent && conversationId !== null) {
        idempotencyMap.markDone(userId, conversationId, clientMessageId, result.assistantMessageId);
      }

      return result;
    } catch (err) {
      // Persistence failed AFTER streaming — remove the entry so the user can
      // retry (v4-1). Surface PERSISTENCE_FAILED unless the error is already an
      // AppError with a PERSISTENCE_* code (persistence may throw timeouts).
      removeEntry();
      const code =
        typeof err === 'object' &&
        err !== null &&
        typeof (err as { code?: unknown }).code === 'string' &&
        (err as { code: string }).code.startsWith('PERSISTENCE_')
          ? (err as { code: string }).code
          : new PersistenceFailedError().code;
      logger.error('advisor persistence failed after streaming', {
        code,
        userId,
        conversationId,
        clientMessageId,
      });
      yield frame('error', { code, upstreamStatus: null });
      return null;
    }
  }

  /**
   * Normal final-answer path (REQ-3.8 / v4-1). Persists via {@link persistTurnAndMark}
   * then yields an `answer_incomplete` notice on the forced-final path and the
   * terminal `done` (or the deduped variant). A persistence failure is surfaced by
   * {@link persistTurnAndMark} as a PERSISTENCE_* error frame; no `done` follows.
   */
  async function* persistAndDone(): AsyncGenerator<SseFrame> {
    const result = yield* persistTurnAndMark();
    if (!result) return;

    // Forced-final answers are flagged incomplete via a non-blocking notice
    // (REQ-3.2, notice bucket) BEFORE the terminal done.
    if (incomplete) {
      yield frame('notice', { code: NOTICE_CODES.answer_incomplete });
    }

    if (result.kind === 'deduped') {
      yield frame('done', {
        messageId: result.assistantMessageId,
        deduped: true,
        source: 'layer-1',
      });
      return;
    }

    yield frame('done', { messageId: result.assistantMessageId });
  }
}
