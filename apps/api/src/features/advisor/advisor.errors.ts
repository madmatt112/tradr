// Advisor error-class hierarchy.
//
// Each row of REQ-3.15's consolidated error-code catalogue maps to one AppError
// subclass here. The shared error middleware (error.middleware.ts) serialises any
// AppError into the standard envelope, so these classes only need to set the
// status code, machine code, and a generic human-readable message.
//
// Provider error messages are NEVER surfaced verbatim (REQ-6.8 / Security): the
// provider classes carry an `upstreamStatus` field and a generic message only.

import { AppError, InvariantViolationError } from '@/lib/errors';

// InvariantViolationError already lives in the shared lib; re-export so advisor
// code (Tasks 12/13/16/etc.) has a single import surface.
export { InvariantViolationError };

// --- Pre-stream errors -------------------------------------------------------

export class InvalidClientMessageIdError extends AppError {
  constructor(message = 'clientMessageId must be a UUID v4') {
    super(400, 'INVALID_CLIENT_MESSAGE_ID', message);
  }
}

export class ProviderNotConfiguredError extends AppError {
  constructor(message = 'No provider key configured') {
    super(400, 'PROVIDER_NOT_CONFIGURED', message);
  }
}

export class ConversationTooLongError extends AppError {
  constructor(message = 'Conversation exceeds the model context window') {
    super(400, 'CONVERSATION_TOO_LONG', message);
  }
}

export class ModelDoesNotSupportVisionError extends AppError {
  constructor(message = 'Selected model does not support images') {
    super(400, 'MODEL_DOES_NOT_SUPPORT_VISION', message);
  }
}

export class ImageTypeInvalidError extends AppError {
  constructor(message = 'Image type is not supported') {
    super(400, 'IMAGE_TYPE_INVALID', message);
  }
}

export class ImageTooLargeError extends AppError {
  constructor(message = 'Image exceeds the size limit') {
    super(400, 'IMAGE_TOO_LARGE', message);
  }
}

export class KeyDecryptFailedError extends AppError {
  constructor(message = 'Server configuration error — contact administrator') {
    super(500, 'KEY_DECRYPT_FAILED', message);
  }
}

export class ModelNotListedError extends AppError {
  constructor(message = 'Selected model is no longer available') {
    super(400, 'MODEL_NOT_LISTED', message);
  }
}

export class StreamInProgressError extends AppError {
  constructor(message = 'You already have an active conversation in another tab') {
    super(429, 'STREAM_IN_PROGRESS', message);
  }
}

export class RetryWhileInFlightError extends AppError {
  constructor(message = 'Your previous send is still being processed') {
    super(429, 'RETRY_WHILE_IN_FLIGHT', message);
  }
}

// --- Provider errors (REQ-6.8) ----------------------------------------------
//
// `upstreamStatus` is the provider HTTP status when known, else null. Pre-stream
// these carry the HTTP status shown in REQ-3.15; mid-stream the orchestrator
// converts them to `event: error` SSE frames.

export class ProviderKeyRejectedError extends AppError {
  constructor(public upstreamStatus: number | null = null) {
    super(400, 'PROVIDER_KEY_REJECTED', 'Your provider key was rejected');
  }
}

// Save-time validation failure (REQ-5.8): the provider's listModels probe
// returned 401/403 for the supplied key, so the key is rejected at save time
// (distinct from the mid-stream PROVIDER_KEY_REJECTED path).
export class ProviderKeyInvalidError extends AppError {
  constructor(message = 'The API key was rejected by the provider') {
    super(400, 'PROVIDER_KEY_INVALID', message);
  }
}

// Market-data (Unusual Whales) save-time verification failure (REQ-6.3): the
// probe got a 401/403 for the supplied key, so the key is rejected at save time.
// Surfaces the REQ-15 `MARKET_DATA_KEY_INVALID` code (tool_result bucket).
export class MarketDataKeyInvalidError extends AppError {
  constructor(message = 'The Unusual Whales API key was rejected') {
    super(400, 'MARKET_DATA_KEY_INVALID', message);
  }
}

export class ProviderRateLimitedError extends AppError {
  constructor(public upstreamStatus: number | null = null) {
    super(429, 'PROVIDER_RATE_LIMITED', 'Provider rate limit reached');
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(public upstreamStatus: number | null = null) {
    super(502, 'PROVIDER_UNAVAILABLE', 'Provider is temporarily unavailable');
  }
}

export class ProviderErrorError extends AppError {
  constructor(public upstreamStatus: number | null = null) {
    super(500, 'PROVIDER_ERROR', 'Provider request failed');
  }
}

// --- Mid-stream timeout / persistence errors --------------------------------

export class ProviderConnectTimeoutError extends AppError {
  constructor(message = 'Timed out connecting to provider') {
    super(503, 'PROVIDER_CONNECT_TIMEOUT', message);
  }
}

export class ProviderInactivityTimeoutError extends AppError {
  constructor(message = 'Provider stopped responding') {
    super(503, 'PROVIDER_INACTIVITY_TIMEOUT', message);
  }
}

export class StreamTimeoutError extends AppError {
  constructor(message = 'Stream exceeded the time limit') {
    super(503, 'STREAM_TIMEOUT', message);
  }
}

export class PersistenceConnectionTimeoutError extends AppError {
  constructor(message = 'Timed out re-acquiring a database connection') {
    super(503, 'PERSISTENCE_CONNECTION_TIMEOUT', message);
  }
}

export class PersistenceTimeoutError extends AppError {
  constructor(message = 'Database write timed out') {
    super(503, 'PERSISTENCE_TIMEOUT', message);
  }
}

export class PersistenceFailedError extends AppError {
  constructor(message = 'Failed to persist the message') {
    super(500, 'PERSISTENCE_FAILED', message);
  }
}

// --- Tool-loop terminating errors (advisor-tools, REQ-15) -------------------
//
// These follow the STREAM_TIMEOUT-style emission shape: the orchestrator catches
// them mid-loop and converts them to an `event: error` SSE frame
// (`frame('error', { code, upstreamStatus })`). The matching `event_error`
// bucket string constants live in tools/error-codes.ts so bucketOf() can
// classify them. tool_result / notice codes are NOT AppError subclasses (they
// are payload string constants — see tools/error-codes.ts).

export class ToolLoopExhaustedError extends AppError {
  constructor(message = 'The assistant could not finish gathering data for this turn') {
    super(503, 'TOOL_LOOP_EXHAUSTED', message);
  }
}

export class DegenerateToolFailureError extends AppError {
  constructor(message = 'The assistant repeatedly failed to use its tools productively') {
    super(503, 'DEGENERATE_TOOL_FAILURE', message);
  }
}

export class ConversationTurnTooLargeError extends AppError {
  constructor(message = 'This turn is too large to process even after summarization') {
    super(400, 'CONVERSATION_TURN_TOO_LARGE', message);
  }
}

/**
 * Map a raw provider SDK error (Anthropic / OpenAI `APIError`, fetch/network
 * errors) to an AppError per the REQ-6.8 / design §Error-Handling table.
 * Inspects `err.status` (both SDKs expose it). Network/unknown errors with no
 * usable status fall through to `ProviderErrorError` with `upstreamStatus: null`.
 */
export function mapProviderError(err: unknown): AppError {
  const status =
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : null;

  if (status === 401 || status === 403) {
    return new ProviderKeyRejectedError(status);
  }
  if (status === 429) {
    return new ProviderRateLimitedError(status);
  }
  if (status !== null && status >= 500 && status <= 599) {
    return new ProviderUnavailableError(status);
  }
  return new ProviderErrorError(null);
}
