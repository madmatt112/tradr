// Auto-summarization service (design §Component 8, REQ-11.3..11.8, REQ-9.8,
// REQ-15.5).
//
// Compresses older conversation history into a structured
// `{prose, tradeDataFigures}` summary so a long, tool-heavy conversation keeps
// fitting under the model's context window. The most-recent N messages are kept
// verbatim and NEVER summarized; only older messages are compressed. Originals
// are never deleted or mutated — summarization changes only the provider context
// (REQ-11.4).
//
// The summary LLM call runs on the conversation's OWN provider/key and the SAME
// model (REQ-11.3; cheaper-model tuning is deferred). It produces structured
// output `{prose, tradeDataFigures}` (the provenance mechanism, REQ-9.6 / §7) —
// the prose is the general narrative and `tradeDataFigures` holds the
// structurally-separated trade-data numbers so consent revocation can strip them.
//
// Boundary column (design §Component 8, v4): extend-prior recurrence and the
// keep-verbatim window are computed from `covered_through_created_at` (a
// well-defined timestamp), NEVER from the dangling `covered_through_message_id`.
//
// This module is the pure-ish service: it performs the LLM call and returns an
// outcome describing what the caller should write (non-atomic, keyed by
// `covered_through_created_at`) and which notice / error to surface. The caller
// (prepare(), Task 21/24) clears the inactivity watchdog for the duration of the
// summary call and re-arms it for the main turn (§5.1) — the service invokes the
// `onSummaryCallStart` / `onSummaryCallEnd` hooks to drive that.

import { logger } from '@/lib/logger';

import { estimateTokens } from './cap-check';
import type { ProviderAdapter, ProviderToolDecl } from './providers/adapter';
import { NOTICE_CODES } from './tools/error-codes';

/** Most-recent messages kept verbatim and never summarized (REQ-11.5). */
export const KEEP_VERBATIM_N = 6;

/** Summarize when the estimate exceeds this fraction of the window (§C8 step 2). */
const SUMMARIZE_TRIGGER_RATIO = 0.75;

/** Single residual hard wall: too large even after summarization (§C8 step 3). */
const HARD_STOP_RATIO = 0.95;

/**
 * A history message the summarizer can act on. Unlike `StreamContextRow.history`
 * this carries `createdAt`, because the summary boundary is the timestamp
 * `covered_through_created_at`, not a position or message id (design §C8 v4).
 */
export interface SummarizableMessage {
  role: 'user' | 'assistant';
  parts: CanonicalPartLike[];
  createdAt: Date;
}

// The summarizer treats parts opaquely (it serializes them for the prompt and
// passes them through to the verbatim window), so it only needs the structural
// minimum rather than the full discriminated union.
type CanonicalPartLike = { type: string; [k: string]: unknown };

/** A prior summary loaded for extend-prior recurrence (design §C8). */
export interface PriorSummary {
  prose: string;
  tradeDataFigures: string | null;
  coveredThroughCreatedAt: Date;
}

/** Structured summary content (REQ-11.3, REQ-9.6). */
export interface SummaryContent {
  prose: string;
  tradeDataFigures: string | null;
}

/**
 * Provider token usage captured from a single summary LLM call (wallet-billing
 * Component 7 / REQ-5.1). `promptTokens` / `completionTokens` mirror the adapter
 * `usage` event. Optional throughout because a provider may report no usage event
 * for the call — the metering accumulator (runStreaming) then estimates instead.
 */
export interface SummaryUsage {
  promptTokens: number;
  completionTokens: number;
}

/** A summary write the caller persists (non-atomic, keyed by the boundary). */
export interface SummaryWrite extends SummaryContent {
  coveredThroughCreatedAt: Date;
  /** Advisory only — has no FK and may dangle after an aborted turn (§C8 v4). */
  coveredThroughMessageId: string | null;
}

export interface SummarizeArgs {
  adapter: ProviderAdapter;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  /** Full chronological history (user/assistant), oldest first. */
  history: SummarizableMessage[];
  /** The new user message's parts (counted toward the window, never summarized). */
  newMessage: CanonicalPartLike[];
  /** Persona system prompt, counted toward the window. */
  persona: { systemPrompt: string } | null;
  /** Tool declarations offered this turn, counted toward the window. */
  toolDeclarations?: ProviderToolDecl[];
  imageCount: number;
  /** Prior summary for extend-prior recurrence, or null when none exists. */
  priorSummary: PriorSummary | null;
  /** Message id at the chosen boundary, if known (advisory only). */
  boundaryMessageIdFor?: (createdAt: Date) => string | null;
  /** Cleared while the summary LLM call runs; re-armed after (§5.1). */
  onSummaryCallStart?: () => void;
  onSummaryCallEnd?: () => void;
  /** Test seam: override the LLM summary call. */
  runSummaryCall?: (input: SummaryCallInput) => Promise<{ text: string; usage?: SummaryUsage }>;
}

export interface SummaryCallInput {
  adapter: ProviderAdapter;
  apiKey: string;
  modelId: string;
  messages: { role: 'system' | 'user'; content: string }[];
}

/**
 * The outcome of attempting summarization for a turn. The caller acts on it:
 *
 *  - `ok`: re-assemble with `summary` + the verbatim `window`; if `write` is
 *    present, persist it (non-atomic). Surface `notice` if set.
 *  - `error`: emit `event: error CONVERSATION_TURN_TOO_LARGE`.
 */
export type SummarizeOutcome =
  | {
      kind: 'ok';
      /** Summary to feed into assembly (existing prior, or freshly produced). */
      summary: SummaryContent | null;
      /** Verbatim recent window to keep (chronological). */
      window: SummarizableMessage[];
      /** New summary row to persist, or null when nothing advanced. */
      write: SummaryWrite | null;
      /** Notice code to surface, or null. */
      notice: (typeof NOTICE_CODES)[keyof typeof NOTICE_CODES] | null;
      /**
       * Provider usage of the summary LLM call, when one was made AND the provider
       * reported a usage event (wallet-billing Component 7 / REQ-5.1). Absent when
       * no summary call ran (under-trigger / failure-fallback paths) or the provider
       * reported no usage — the platform metering accumulator estimates in that case.
       */
      usage?: SummaryUsage;
    }
  | {
      kind: 'error';
      /**
       * Always CONVERSATION_TURN_TOO_LARGE (event:error bucket). NOTE: this arm may
       * have made a real (billed) summary call before the re-estimate hard-stop, but
       * that turn is refused with no debit (reservation released, Task 13) — the
       * summary cost is an accepted bounded loss, deliberately NOT metered, so no
       * usage is surfaced here (wallet-billing Component 7).
       */
      code: 'CONVERSATION_TURN_TOO_LARGE';
    };

// ---------------------------------------------------------------------------
// Token estimation helper (delegates to cap-check, which counts tool parts).
// ---------------------------------------------------------------------------

async function estimate(
  args: SummarizeArgs,
  history: SummarizableMessage[],
  summary: SummaryContent | null,
): Promise<number> {
  const list: import('./providers/adapter').CanonicalMessage[] = [];
  if (args.persona) list.push({ role: 'system', content: args.persona.systemPrompt });
  if (summary) {
    const figures =
      summary.tradeDataFigures && summary.tradeDataFigures.length > 0
        ? `\n\n${summary.tradeDataFigures}`
        : '';
    list.push({ role: 'system', content: `${summary.prose}${figures}` });
  }
  for (const m of history) {
    list.push({ role: m.role, parts: m.parts as never });
  }
  list.push({ role: 'user', parts: args.newMessage as never });

  const result = await estimateTokens({
    adapter: args.adapter,
    list,
    modelId: args.modelId,
    apiKey: args.apiKey,
    imageCount: args.imageCount,
    toolDeclarations: args.toolDeclarations,
  });
  return result.tokens;
}

// ---------------------------------------------------------------------------
// LLM summary call: same provider/key/model, structured {prose, figures}.
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT =
  'You compress an ongoing trading-advisor conversation so it fits a model ' +
  'context window. Respond with ONLY a JSON object of the form ' +
  '{"prose": string, "tradeDataFigures": string | null}. "prose" is a concise ' +
  'narrative of the conversation so far; AVOID embedding specific trade-data ' +
  'numbers in it. Put every concrete trade-data figure (P&L, position sizes, ' +
  'fills, prices tied to the user\'s trades) into "tradeDataFigures" as a ' +
  'compact list, or null if there are none. Do not add commentary outside the JSON.';

function serializePart(part: CanonicalPartLike): string {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'image') return '[image]';
  if (part.type === 'tool_call') {
    return `[tool_call ${String(part.name)} ${JSON.stringify(part.arguments ?? {})}]`;
  }
  if (part.type === 'tool_result') {
    return `[tool_result ${JSON.stringify(part.content ?? {})}]`;
  }
  return JSON.stringify(part);
}

function renderForPrompt(messages: SummarizableMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.parts.map(serializePart).join('\n')}`).join('\n\n');
}

/**
 * Default summary call: stream the model with no tools and accumulate text.
 * Also captures the provider `usage` event so the platform metering accumulator
 * can charge the summary call's tokens (wallet-billing Component 7 / REQ-5.1).
 */
async function defaultRunSummaryCall(
  input: SummaryCallInput,
): Promise<{ text: string; usage?: SummaryUsage }> {
  const { adapter, apiKey, modelId } = input;
  const native = adapter.translate(
    input.messages.map((m) =>
      m.role === 'system'
        ? { role: 'system' as const, content: m.content }
        : { role: 'user' as const, parts: [{ type: 'text', text: m.content }] },
    ) as never,
    modelId,
  );
  let text = '';
  let usage: SummaryUsage | undefined;
  const controller = new AbortController();
  for await (const evt of adapter.streamChat({
    apiKey,
    modelId,
    messages: native,
    signal: controller.signal,
  })) {
    if (evt.type === 'token') {
      text += evt.delta;
    } else if (evt.type === 'usage') {
      // The provider may report null token counts; only surface a usage object
      // when both are concrete numbers (the accumulator estimates otherwise).
      if (evt.promptTokens !== null && evt.completionTokens !== null) {
        usage = { promptTokens: evt.promptTokens, completionTokens: evt.completionTokens };
      }
    }
  }
  return { text, usage };
}

/** Parse the model's structured reply into `{prose, tradeDataFigures}`. */
function parseStructured(raw: string): SummaryContent {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('summary reply contained no JSON object');
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
    prose?: unknown;
    tradeDataFigures?: unknown;
  };
  if (typeof parsed.prose !== 'string' || parsed.prose.length === 0) {
    throw new Error('summary reply missing "prose"');
  }
  const figures =
    typeof parsed.tradeDataFigures === 'string' && parsed.tradeDataFigures.length > 0
      ? parsed.tradeDataFigures
      : null;
  return { prose: parsed.prose, tradeDataFigures: figures };
}

/** Combine the prior summary with a freshly produced one (extend-prior). */
function mergeWithPrior(prior: PriorSummary | null, fresh: SummaryContent): SummaryContent {
  if (!prior) return fresh;
  const prose = `${prior.prose}\n\n${fresh.prose}`;
  const figures = [prior.tradeDataFigures, fresh.tradeDataFigures]
    .filter((f): f is string => !!f && f.length > 0)
    .join('\n');
  return { prose, tradeDataFigures: figures.length > 0 ? figures : null };
}

// ---------------------------------------------------------------------------
// Window / boundary helpers.
// ---------------------------------------------------------------------------

/**
 * Split history into [older, window]. The window is the most-recent
 * KEEP_VERBATIM_N messages; everything before it is summarizable. Extend-prior:
 * messages already covered by the prior summary (createdAt <= boundary) are
 * dropped from the older slice (they are represented by `priorSummary`).
 */
function partition(
  history: SummarizableMessage[],
  prior: PriorSummary | null,
): { older: SummarizableMessage[]; window: SummarizableMessage[] } {
  const window = history.slice(Math.max(0, history.length - KEEP_VERBATIM_N));
  let older = history.slice(0, Math.max(0, history.length - KEEP_VERBATIM_N));
  if (prior) {
    older = older.filter((m) => m.createdAt.getTime() > prior.coveredThroughCreatedAt.getTime());
  }
  return { older, window };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Run auto-summarization for a turn. Returns an outcome the caller acts on.
 *
 * Flow (design §Component 8):
 *  1. Estimate. If <= 0.75 × window → no summarization needed.
 *  2. Otherwise summarize the OLDEST fit-able slice of older history
 *     (input-overflow chunking: never feed an over-window input to the
 *     summarizer; leave the rest for the next advance).
 *  3. Re-estimate with the new summary + verbatim window. If still > 0.95 ×
 *     window → CONVERSATION_TURN_TOO_LARGE (the single hard wall).
 *  4. On LLM failure: L1 verbatim-window + `summary_failed` notice; L2 shrink
 *     the window oldest-first; else CONVERSATION_TURN_TOO_LARGE.
 */
export async function summarize(args: SummarizeArgs): Promise<SummarizeOutcome> {
  const triggerCeil = args.contextWindow * SUMMARIZE_TRIGGER_RATIO;
  const hardCeil = args.contextWindow * HARD_STOP_RATIO;

  const priorContent: SummaryContent | null = args.priorSummary
    ? { prose: args.priorSummary.prose, tradeDataFigures: args.priorSummary.tradeDataFigures }
    : null;

  // Step 1: trigger check against the full history + existing summary.
  const baseline = await estimate(args, args.history, priorContent);
  if (baseline <= triggerCeil) {
    return { kind: 'ok', summary: priorContent, window: args.history, write: null, notice: null };
  }

  const { older, window } = partition(args.history, args.priorSummary);

  // Nothing left to summarize (everything is already in the prior summary or
  // the verbatim window) — fall straight to the failure-fallback ladder, which
  // shrinks the window or hard-stops.
  if (older.length === 0) {
    return failureFallback(args, window, priorContent, hardCeil);
  }

  // Step 2: produce a summary from the OLDEST fit-able slice (chunked).
  let fresh: SummaryContent;
  let coveredThroughCreatedAt: Date;
  // Provider usage of the summary call (when reported) — surfaced on the ok arm
  // so the platform metering accumulator charges the summary tokens (Component 7).
  let summaryUsage: SummaryUsage | undefined;
  try {
    args.onSummaryCallStart?.();
    const sliced = await summarizeOldestFitableSlice(args, older);
    if (sliced === null) {
      // Even a minimal slice cannot be summarized within the window.
      return { kind: 'error', code: 'CONVERSATION_TURN_TOO_LARGE' };
    }
    fresh = sliced.content;
    coveredThroughCreatedAt = sliced.coveredThroughCreatedAt;
    summaryUsage = sliced.usage;
  } catch (err) {
    logger.warn('advisor summary call failed', {
      modelId: args.modelId,
      error: (err as Error).message,
    });
    return failureFallback(args, window, priorContent, hardCeil);
  } finally {
    args.onSummaryCallEnd?.();
  }

  const merged = mergeWithPrior(args.priorSummary, fresh);

  // The verbatim window after this advance: any older message NOT covered by
  // the new summary (the chunk left behind) stays in front of the window.
  const leftBehind = older.filter((m) => m.createdAt.getTime() > coveredThroughCreatedAt.getTime());
  const newWindow = [...leftBehind, ...window];

  // Step 3: re-estimate. Still too large → the single hard wall.
  const reEstimate = await estimate(args, newWindow, merged);
  if (reEstimate > hardCeil) {
    return { kind: 'error', code: 'CONVERSATION_TURN_TOO_LARGE' };
  }

  return {
    kind: 'ok',
    summary: merged,
    window: newWindow,
    write: {
      ...merged,
      coveredThroughCreatedAt,
      coveredThroughMessageId: args.boundaryMessageIdFor?.(coveredThroughCreatedAt) ?? null,
    },
    notice: NOTICE_CODES.summarized,
    usage: summaryUsage,
  };
}

/**
 * Summarize the OLDEST fit-able slice of `older` (design §C8 input-overflow
 * chunking). Tries the whole slice first; if the slice's own input exceeds the
 * window it shrinks from the newest end (keeping it anchored at the oldest
 * message) until it fits, then runs one LLM call. Returns null only when even a
 * single oldest message + the summary framing cannot fit — the caller maps that
 * to CONVERSATION_TURN_TOO_LARGE.
 */
async function summarizeOldestFitableSlice(
  args: SummarizeArgs,
  older: SummarizableMessage[],
): Promise<{
  content: SummaryContent;
  coveredThroughCreatedAt: Date;
  usage?: SummaryUsage;
} | null> {
  const inputCeil = args.contextWindow * HARD_STOP_RATIO;

  for (let count = older.length; count >= 1; count--) {
    const slice = older.slice(0, count);
    // Cost of the summary call's INPUT: the prior summary (extend-prior) + the
    // slice rendered into a single user message. Never feed an over-window input.
    const inputCost = await estimate(
      args,
      slice,
      args.priorSummary
        ? { prose: args.priorSummary.prose, tradeDataFigures: args.priorSummary.tradeDataFigures }
        : null,
    );
    if (inputCost <= inputCeil) {
      const { text, usage } = await runSummaryCall(args, slice);
      return {
        content: parseStructured(text),
        coveredThroughCreatedAt: slice[slice.length - 1].createdAt,
        usage,
      };
    }
  }
  return null;
}

async function runSummaryCall(
  args: SummarizeArgs,
  slice: SummarizableMessage[],
): Promise<{ text: string; usage?: SummaryUsage }> {
  const run = args.runSummaryCall ?? defaultRunSummaryCall;
  const priorBlock = args.priorSummary
    ? `Prior summary so far:\n${args.priorSummary.prose}${
        args.priorSummary.tradeDataFigures
          ? `\n\nPrior trade-data figures:\n${args.priorSummary.tradeDataFigures}`
          : ''
      }\n\n`
    : '';
  return run({
    adapter: args.adapter,
    apiKey: args.apiKey,
    modelId: args.modelId,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${priorBlock}Conversation to compress:\n${renderForPrompt(slice)}`,
      },
    ],
  });
}

/**
 * Failure fallback ladder (REQ-11.6):
 *  - L1: send the verbatim recent window (+ existing summary) with a
 *    `summary_failed` notice, retry next turn — IF that fits under the hard wall.
 *  - L2: shrink the window oldest-first (still disclosed) until it fits.
 *  - else: CONVERSATION_TURN_TOO_LARGE.
 *
 * The transcript is never mutated; shrinking only affects the provider context.
 */
async function failureFallback(
  args: SummarizeArgs,
  window: SummarizableMessage[],
  summary: SummaryContent | null,
  hardCeil: number,
): Promise<SummarizeOutcome> {
  // L1: verbatim window as-is.
  const l1 = await estimate(args, window, summary);
  if (l1 <= hardCeil) {
    return {
      kind: 'ok',
      summary,
      window,
      write: null,
      notice: NOTICE_CODES.summary_failed,
    };
  }

  // L2: shrink oldest-first.
  let shrunk = window;
  while (shrunk.length > 1) {
    shrunk = shrunk.slice(1);
    const cost = await estimate(args, shrunk, summary);
    if (cost <= hardCeil) {
      return {
        kind: 'ok',
        summary,
        window: shrunk,
        write: null,
        notice: NOTICE_CODES.summary_failed,
      };
    }
  }

  // Even a single message + framing cannot fit.
  return { kind: 'error', code: 'CONVERSATION_TURN_TOO_LARGE' };
}
