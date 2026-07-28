// Consolidated tool error & notice taxonomy (design §Error Handling, REQ-15).
//
// Two distinct representations live across this file and advisor.errors.ts:
//
//   1. `tool_result`-bucket and `notice`-bucket codes (THIS file) are PLAIN
//      STRING CONSTANTS embedded in SSE payloads — NOT AppError subclasses.
//      A `tool_result`-bucket code rides on a `tool_result` SSE frame and the
//      tool loop CONTINUES (the model may adapt). A `notice`-bucket code rides
//      on a non-blocking transcript notice and the turn PROCEEDS/completes.
//
//   2. `event: error`-bucket terminating codes (`TOOL_LOOP_EXHAUSTED`,
//      `DEGENERATE_TOOL_FAILURE`, `CONVERSATION_TURN_TOO_LARGE`) live in
//      advisor.errors.ts as AppError subclasses and are emitted in advisor-core's
//      `event: error` SSE shape (`frame('error', { code, upstreamStatus })`),
//      exactly like STREAM_TIMEOUT / PROVIDER_ERROR. The stream TERMINATES.
//
// The bucket — continue vs. terminate vs. notice — is the correctness-critical
// decision (REQ-15.1), so `bucketOf` makes it explicit and testable for EVERY
// code, including the advisor-core event:error codes that predate this spec.

/**
 * Codes returned inside a `tool_result` SSE frame. The tool loop CONTINUES; the
 * model sees the error and may adapt (REQ-15.1, continue bucket).
 */
export const TOOL_RESULT_CODES = {
  /** Hallucinated/undeclared/precondition-unmet tool (REQ-1.7). */
  TOOL_NOT_PERMITTED: 'TOOL_NOT_PERMITTED',
  /** Tool arguments failed Zod validation (REQ-1.5). */
  TOOL_INPUT_INVALID: 'TOOL_INPUT_INVALID',
  /** Per-user platform tool-execution meter tripped (REQ-3.10). */
  PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
  /** Per-turn trade-data egress cap reached pre-call (REQ-9.5). */
  TRADE_DATA_BUDGET_EXCEEDED: 'TRADE_DATA_BUDGET_EXCEEDED',
  /** Per-tool timeout (REQ-3.6). */
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  /** Unusual Whales 401/403 — upstream (REQ-6.5). */
  MARKET_DATA_KEY_INVALID: 'MARKET_DATA_KEY_INVALID',
  /** Unusual Whales 429 — upstream (REQ-6.5). */
  MARKET_DATA_RATE_LIMITED: 'MARKET_DATA_RATE_LIMITED',
  /** Unusual Whales 5xx/timeout — upstream (REQ-6.5). */
  MARKET_DATA_UNAVAILABLE: 'MARKET_DATA_UNAVAILABLE',
  /** Unusual Whales 404/empty — upstream (REQ-6.5). */
  SYMBOL_NOT_FOUND: 'SYMBOL_NOT_FOUND',
} as const;

/**
 * Codes returned as a non-blocking transcript notice. The turn PROCEEDS or
 * completes normally (REQ-15.1, notice bucket).
 */
export const NOTICE_CODES = {
  /** Iteration cap reached; forced answer succeeded but may be incomplete (REQ-3.2). */
  answer_incomplete: 'answer_incomplete',
  /** Auto-summarization ran this turn (REQ-11.7). */
  summarized: 'summarized',
  /** Summarization failed; verbatim-window fallback used (REQ-11.6). */
  summary_failed: 'summary_failed',
} as const;

/**
 * Terminating codes carried on an `event: error` SSE frame. The stream
 * TERMINATES (REQ-15.1). The error CLASSES for the advisor-tools additions live
 * in advisor.errors.ts (AppError subclasses, STREAM_TIMEOUT-style emission);
 * these string constants exist so `bucketOf` can classify every code — including
 * the advisor-core event:error codes that predate this spec.
 */
export const EVENT_ERROR_CODES = {
  // advisor-tools additions (AppError subclasses in advisor.errors.ts)
  TOOL_LOOP_EXHAUSTED: 'TOOL_LOOP_EXHAUSTED',
  DEGENERATE_TOOL_FAILURE: 'DEGENERATE_TOOL_FAILURE',
  CONVERSATION_TURN_TOO_LARGE: 'CONVERSATION_TURN_TOO_LARGE',
  // advisor-core terminating codes (unchanged) — included so bucketOf is total.
  PROVIDER_CONNECT_TIMEOUT: 'PROVIDER_CONNECT_TIMEOUT',
  PROVIDER_INACTIVITY_TIMEOUT: 'PROVIDER_INACTIVITY_TIMEOUT',
  STREAM_TIMEOUT: 'STREAM_TIMEOUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
} as const;

export type ToolResultCode = (typeof TOOL_RESULT_CODES)[keyof typeof TOOL_RESULT_CODES];
export type NoticeCode = (typeof NOTICE_CODES)[keyof typeof NOTICE_CODES];
export type EventErrorCode = (typeof EVENT_ERROR_CODES)[keyof typeof EVENT_ERROR_CODES];

/** The delivery bucket determines terminate-vs-continue-vs-notice (REQ-15.1). */
export type ErrorBucket = 'tool_result' | 'event_error' | 'notice';

const BUCKET_BY_CODE: Record<string, ErrorBucket> = {
  ...Object.fromEntries(Object.values(TOOL_RESULT_CODES).map((c) => [c, 'tool_result'])),
  ...Object.fromEntries(Object.values(NOTICE_CODES).map((c) => [c, 'notice'])),
  ...Object.fromEntries(Object.values(EVENT_ERROR_CODES).map((c) => [c, 'event_error'])),
};

/**
 * Resolve a taxonomy code to its delivery bucket (REQ-15.1). Returns the bucket
 * for every code in the consolidated taxonomy; throws on an unknown code so a
 * new code cannot silently slip the terminate-vs-continue fork.
 */
export function bucketOf(code: string): ErrorBucket {
  const bucket = BUCKET_BY_CODE[code];
  if (!bucket) {
    throw new Error(`Unknown error/notice code: ${code}`);
  }
  return bucket;
}
