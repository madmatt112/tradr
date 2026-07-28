// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSseStream, SseParseError, SsePreStreamError } from './sse';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeCallbacks() {
  return {
    onToken: vi.fn(),
    onUsage: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onNotice: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSseStream', () => {
  it('parses token, usage, and done frames and returns the messageId', async () => {
    // The frames below are deliberately chunked so that single SSE frames are
    // split across multiple reads, exercising the highest-risk buffer-
    // accumulation / partial-chunk parser path:
    //  - the first token frame's `data:` line is split mid-payload;
    //  - the `\n\n` boundary between the two token frames is itself split;
    //  - the usage frame is split across the `event:`/`data:` lines.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: token\ndata: {"del', // partial first frame
          'ta":"Hel"}\n', // completes data line, but not the boundary
          '\nevent: token\ndata: {"delta":"lo"}\n', // prior boundary + 2nd frame, no boundary yet
          '\nevent: usage\n', // boundary for 2nd frame + start of usage frame
          'data: {"promptTokens":12}\n\n', // usage frame omits completionTokens (normalised to null)
          'event: done\ndata: {"messageId":"msg-1"}\n\n',
        ]),
      ),
    );
    const cb = makeCallbacks();

    const result = await readSseStream('/api/advisor/stream', { body: '{}', ...cb });

    // The split frames are still parsed correctly once buffered into completeness.
    expect(cb.onToken.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo']);
    // Usage callback fires with the token-count fields; the missing
    // completionTokens field is normalised to null by the implementation.
    expect(cb.onUsage).toHaveBeenCalledTimes(1);
    expect(cb.onUsage).toHaveBeenCalledWith({ promptTokens: 12, completionTokens: null });
    expect(cb.onDone).toHaveBeenCalledWith('msg-1');
    expect(result).toEqual({ messageId: 'msg-1', deduped: false });
  });

  it('routes tool_call, tool_result, and notice frames to their handlers, ignores unknown, and emits one done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: tool_call\ndata: {"id":"tc-1","name":"market_data_quote","argumentsPreview":"{\\"symbol\\":\\"AAPL\\"}"}\n\n',
          // A comment line (no event) is ignored.
          ': keep-alive\n\n',
          // An unknown event name is ignored.
          'event: heartbeat\ndata: {"ts":1}\n\n',
          'event: tool_result\ndata: {"toolCallId":"tc-1","status":"ok","summary":"AAPL 190.12"}\n\n',
          // A notice frame IS surfaced to onNotice (non-terminal disclosure).
          'event: notice\ndata: {"code":"answer_incomplete"}\n\n',
          'event: token\ndata: {"delta":"done"}\n\n',
          'event: done\ndata: {"messageId":"msg-1"}\n\n',
        ]),
      ),
    );
    const cb = makeCallbacks();

    const result = await readSseStream('/api/advisor/stream', { body: '{}', ...cb });

    expect(cb.onToolCall).toHaveBeenCalledTimes(1);
    expect(cb.onToolCall).toHaveBeenCalledWith({
      id: 'tc-1',
      name: 'market_data_quote',
      argumentsPreview: '{"symbol":"AAPL"}',
    });
    expect(cb.onToolResult).toHaveBeenCalledTimes(1);
    expect(cb.onToolResult).toHaveBeenCalledWith({
      toolCallId: 'tc-1',
      status: 'ok',
      summary: 'AAPL 190.12',
    });
    // The notice frame is surfaced; the comment line + unknown event are ignored.
    expect(cb.onNotice).toHaveBeenCalledTimes(1);
    expect(cb.onNotice).toHaveBeenCalledWith({ code: 'answer_incomplete' });
    expect(cb.onToken).toHaveBeenCalledWith('done');
    // Exactly one terminal done (REQ-5.3).
    expect(cb.onDone).toHaveBeenCalledTimes(1);
    expect(cb.onDone).toHaveBeenCalledWith('msg-1');
    expect(cb.onError).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: 'msg-1', deduped: false });
  });

  it('surfaces a BILLING_MODE notice frame with its code-specific fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: notice\ndata: {"code":"BILLING_MODE","mode":"platform","fellThrough":true}\n\n',
            'event: token\ndata: {"delta":"hi"}\n\n',
            'event: done\ndata: {"messageId":"msg-3"}\n\n',
          ]),
        ),
    );
    const cb = makeCallbacks();

    await readSseStream('/api/advisor/stream', { body: '{}', ...cb });

    expect(cb.onNotice).toHaveBeenCalledWith({
      code: 'BILLING_MODE',
      mode: 'platform',
      fellThrough: true,
    });
    // A notice does NOT terminate the stream — the done frame still arrives.
    expect(cb.onDone).toHaveBeenCalledWith('msg-3');
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('preserves an error-status tool_result (loop continues, not a terminal error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: tool_result\ndata: {"toolCallId":"tc-2","status":"error","summary":"SYMBOL_NOT_FOUND: no such symbol"}\n\n',
            'event: done\ndata: {"messageId":"msg-2"}\n\n',
          ]),
        ),
    );
    const cb = makeCallbacks();

    await readSseStream('/api/advisor/stream', { body: '{}', ...cb });

    expect(cb.onToolResult).toHaveBeenCalledWith({
      toolCallId: 'tc-2',
      status: 'error',
      summary: 'SYMBOL_NOT_FOUND: no such symbol',
    });
    // A tool_result with status:'error' does NOT terminate the stream.
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onDone).toHaveBeenCalledTimes(1);
  });

  it('throws SsePreStreamError on a non-OK response without opening the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'STREAM_IN_PROGRESS', message: 'busy' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const cb = makeCallbacks();

    let caught: unknown;
    try {
      await readSseStream('/api/advisor/stream', { body: '{}', ...cb });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SsePreStreamError);
    expect((caught as SsePreStreamError).status).toBe(429);
    expect((caught as SsePreStreamError).code).toBe('STREAM_IN_PROGRESS');
    expect(cb.onToken).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('routes a mid-stream error frame to onError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: token\ndata: {"delta":"partial"}\n\n',
            'event: error\ndata: {"code":"PROVIDER_ERROR","upstreamStatus":500,"message":"boom"}\n\n',
          ]),
        ),
    );
    const cb = makeCallbacks();

    await expect(readSseStream('/api/advisor/stream', { body: '{}', ...cb })).rejects.toThrow();

    expect(cb.onToken).toHaveBeenCalledWith('partial');
    expect(cb.onError).toHaveBeenCalledWith('PROVIDER_ERROR');
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('throws SseParseError on a non-JSON data line instead of swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse(['event: token\ndata: this-is-not-json\n\n'])),
    );
    const cb = makeCallbacks();

    await expect(
      readSseStream('/api/advisor/stream', { body: '{}', ...cb }),
    ).rejects.toBeInstanceOf(SseParseError);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('surfaces STREAM_DISCONNECTED and does not reconnect when the stream ends without a done frame', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse(['event: token\ndata: {"delta":"hi"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const cb = makeCallbacks();

    await expect(readSseStream('/api/advisor/stream', { body: '{}', ...cb })).rejects.toThrow();

    expect(cb.onError).toHaveBeenCalledWith('STREAM_DISCONNECTED');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no auto-reconnect
  });
});
