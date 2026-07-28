// SSE client for the advisor streaming endpoint.
//
// Uses fetch + ReadableStream + TextDecoder. Native EventSource is NOT used
// because the streaming endpoint requires a POST body (design §Component 9).
// Does NOT auto-reconnect: a transport-level drop surfaces a STREAM_DISCONNECTED
// error (a client-only code; the server never emits it) and the user must retry
// (REQ-1.7 / REQ-3.13). Malformed (non-JSON) `data:` lines are NOT swallowed —
// they throw so the caller surfaces the parse failure rather than hanging.

export interface SseUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * A `tool_call` frame: the advisor is invoking a tool. `argumentsPreview` is a
 * truncated, display-safe rendering of the arguments (server-side ≤2KB — REQ-5.2).
 */
export interface SseToolCall {
  id: string;
  name: string;
  argumentsPreview: string;
}

/**
 * A `tool_result` frame: a tool finished. `summary` is a truncated, display-safe
 * rendering of the result (server-side ≤2KB — REQ-5.2). The loop continues on
 * `status: 'error'`; only `event: error` terminates the stream.
 */
export interface SseToolResult {
  toolCallId: string;
  status: 'ok' | 'error';
  summary: string;
}

/**
 * A `notice` frame: a non-terminal, informational disclosure about the turn
 * (e.g. `BILLING_MODE` — platform vs byok, `fellThrough`; `answer_incomplete`;
 * `summarized`). Carries a `code` plus any code-specific fields.
 */
export interface SseNotice {
  code: string;
  [key: string]: unknown;
}

export interface ReadSseStreamOptions {
  method?: string;
  body?: string;
  signal?: AbortSignal;
  onToken: (delta: string) => void;
  onUsage?: (usage: SseUsage) => void;
  onToolCall?: (call: SseToolCall) => void;
  onToolResult?: (result: SseToolResult) => void;
  onNotice?: (notice: SseNotice) => void;
  onError: (code: string) => void;
  onDone: (messageId: string) => void;
}

export interface ReadSseStreamResult {
  messageId: string;
  deduped: boolean;
}

/**
 * Thrown when the server returns a non-OK response BEFORE the SSE stream opens.
 * The caller inspects `status` to distinguish pre-stream JSON errors from
 * mid-stream SSE `error` frames (REQ-3.13 acceptance criterion 3).
 */
export class SsePreStreamError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'SsePreStreamError';
    this.status = status;
    this.code = code;
  }
}

/** Thrown when a `data:` payload that must be JSON cannot be parsed. */
export class SseParseError extends Error {
  constructor(eventName: string, raw: string, cause?: unknown) {
    super(`Malformed SSE data for event "${eventName}": ${raw}`);
    this.name = 'SseParseError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

interface ParsedFrame {
  event: string;
  data: string;
}

function parseJson(eventName: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new SseParseError(eventName, raw, cause);
  }
}

export async function readSseStream(
  url: string,
  opts: ReadSseStreamOptions,
): Promise<ReadSseStreamResult> {
  const response = await fetch(url, {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: opts.body,
    signal: opts.signal,
    // Session cookie must ride along on split-origin hosted deploys.
    credentials: 'include',
  });

  // Pre-stream errors are standard JSON 4xx/5xx responses, NOT SSE frames.
  if (!response.ok) {
    let code: string | undefined;
    let message = `Request failed with status ${response.status}`;
    try {
      const json = (await response.json()) as { error?: { code?: string; message?: string } };
      code = json.error?.code;
      if (json.error?.message) message = json.error.message;
    } catch {
      // Non-JSON error body — keep the default message.
    }
    throw new SsePreStreamError(response.status, code, message);
  }

  if (!response.body) {
    // No stream body and a 2xx status: treat as a transport-level failure.
    opts.onError('STREAM_DISCONNECTED');
    throw new Error('SSE response had no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let result: ReadSseStreamResult | null = null;

  const handleFrame = (frame: ParsedFrame): void => {
    switch (frame.event) {
      case 'token': {
        const data = parseJson('token', frame.data) as { delta?: string };
        opts.onToken(data.delta ?? '');
        return;
      }
      case 'usage': {
        const data = parseJson('usage', frame.data) as SseUsage;
        opts.onUsage?.({
          promptTokens: data.promptTokens ?? null,
          completionTokens: data.completionTokens ?? null,
        });
        return;
      }
      case 'tool_call': {
        const data = parseJson('tool_call', frame.data) as {
          id?: string;
          name?: string;
          argumentsPreview?: string;
        };
        opts.onToolCall?.({
          id: data.id ?? '',
          name: data.name ?? '',
          argumentsPreview: data.argumentsPreview ?? '',
        });
        return;
      }
      case 'tool_result': {
        const data = parseJson('tool_result', frame.data) as {
          toolCallId?: string;
          status?: 'ok' | 'error';
          summary?: string;
        };
        opts.onToolResult?.({
          toolCallId: data.toolCallId ?? '',
          status: data.status === 'error' ? 'error' : 'ok',
          summary: data.summary ?? '',
        });
        return;
      }
      case 'done': {
        const data = parseJson('done', frame.data) as { messageId: string; deduped?: boolean };
        result = { messageId: data.messageId, deduped: data.deduped ?? false };
        opts.onDone(data.messageId);
        return;
      }
      case 'notice': {
        // Non-terminal informational frame (e.g. BILLING_MODE). The stream
        // continues; surfacing it lets the client render the turn's billing
        // mode and other disclosures (wallet-billing REQ-6.5).
        const data = parseJson('notice', frame.data) as { code?: string };
        if (data.code) opts.onNotice?.(data as SseNotice);
        return;
      }
      case 'error': {
        const data = parseJson('error', frame.data) as { code: string };
        opts.onError(data.code);
        return;
      }
      default:
        // Unknown event names (e.g. SSE comments / keep-alives have no event)
        // are ignored, but a non-JSON `data:` line is never silently dropped:
        // any frame we dispatch above validates its payload.
        return;
    }
  };

  // Splits the buffer into complete frames (separated by a blank line) and
  // dispatches each. Leaves any trailing partial frame in `buffer`.
  const drainBuffer = (): void => {
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of rawFrame.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          event = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
        }
      }

      if (dataLines.length > 0) {
        handleFrame({ event, data: dataLines.join('\n') });
      }

      boundary = buffer.indexOf('\n\n');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalise CRLF so frame-boundary detection works regardless of the
      // server's line endings.
      buffer = buffer.replace(/\r\n/g, '\n');
      drainBuffer();
    }
    // Flush any decoder state and process a trailing frame missing its blank line.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.trim() !== '') {
      buffer += '\n\n';
      drainBuffer();
    }
  } catch (cause) {
    // A SseParseError (malformed data) must propagate — do not mask it as a
    // transport disconnect.
    if (cause instanceof SseParseError) throw cause;
    // Any other read failure is a transport-level drop. We do NOT reconnect.
    opts.onError('STREAM_DISCONNECTED');
    throw cause;
  }

  if (!result) {
    // The stream ended without a `done` frame: treat as a dropped connection.
    opts.onError('STREAM_DISCONNECTED');
    throw new Error('SSE stream closed before a done frame');
  }

  return result;
}
