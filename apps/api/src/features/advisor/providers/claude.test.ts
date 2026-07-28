import { describe, expect, it, vi, beforeEach } from 'vitest';

import { TOOL_RESULT_CODES, bucketOf } from '../tools/error-codes';

import type { CanonicalMessage } from './adapter';
import { ListModelsCache } from './list-models-cache';

// --- SDK mock ----------------------------------------------------------------
// One mocked Anthropic client backs the whole suite. `streamEvents` is the
// async iterable the tests pre-load; `modelsListPage` is the (async-iterable)
// models.list() result.

const streamMock = vi.fn();
const modelsListMock = vi.fn();
const ctorOptions = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { stream: streamMock };
    models = { list: modelsListMock };
    constructor(opts: unknown) {
      ctorOptions(opts);
    }
  }
  return { default: Anthropic };
});

// Imported AFTER the mock is registered.
const { ClaudeAdapter } = await import('./claude');

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClaudeAdapter', () => {
  it('constructs the SDK client with the pinned 600_000ms timeout', () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    streamMock.mockReturnValue(asyncIterable([]));
    // Trigger a client construction via streamChat (lazy per-call client).
    void adapter
      .streamChat({
        apiKey: 'sk-test',
        modelId: 'claude-opus-4-7',
        messages: { system: '', messages: [] },
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]()
      .next();

    expect(ctorOptions).toHaveBeenCalledWith({ apiKey: 'sk-test', timeout: 600_000 });
  });

  it('translates canonical messages into Anthropic MessageParam + system', () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    const list: CanonicalMessage[] = [
      { role: 'system', content: 'You are a trading advisor.' },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Review this chart' },
          { type: 'image', format: 'png', dataBase64: 'AAAA' },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'Looks bullish.' }] },
    ];

    const payload = adapter.translate(list);

    expect(payload.system).toBe('You are a trading advisor.');
    expect(payload.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this chart' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Looks bullish.' }] },
    ]);
  });

  it('streamChat yields token, usage, and done events from the SDK stream', async () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    streamMock.mockReturnValue(
      asyncIterable([
        { type: 'message_start', message: { usage: { input_tokens: 42 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
        { type: 'message_delta', usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ]),
    );

    const events = [];
    for await (const event of adapter.streamChat({
      apiKey: 'sk-test',
      modelId: 'claude-opus-4-7',
      messages: { system: 'sys', messages: [] },
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', delta: 'Hello' },
      { type: 'token', delta: ' world' },
      { type: 'usage', promptTokens: 42, completionTokens: 7 },
      { type: 'done' },
    ]);
    expect(streamMock).toHaveBeenCalledWith(
      { model: 'claude-opus-4-7', system: 'sys', messages: [], max_tokens: 4096 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('listModels maps the SDK page and goes through the cache (one fetch per key)', async () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(
      asyncIterable([{ id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }]),
    );

    const first = await adapter.listModels('sk-cache');
    const second = await adapter.listModels('sk-cache');

    expect(first).toEqual([
      {
        id: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        contextWindow: 1_000_000,
        vision: true,
        toolUse: true,
      },
    ]);
    expect(second).toBe(first);
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it('listModels prefers SDK-advertised fields and uses the conservative default for unknown ids', async () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(
      asyncIterable([
        // SDK advertises context window + vision → both win over the fallback map.
        {
          id: 'claude-future-9',
          display_name: 'Claude Future 9',
          max_input_tokens: 500_000,
          capabilities: { image_input: { supported: false } },
        },
        // SDK advertises nothing and the id is not in the fallback map →
        // conservative 8k context, vision false (never blanket-defaulted to 200k/true).
        { id: 'claude-mystery-1', display_name: 'Claude Mystery 1' },
      ]),
    );

    const models = await adapter.listModels('sk-unknown');

    expect(models).toEqual([
      {
        id: 'claude-future-9',
        displayName: 'Claude Future 9',
        contextWindow: 500_000,
        vision: false,
        // 'claude-future-9' is not a recognized tool-use prefix → fail-closed false.
        toolUse: false,
      },
      {
        id: 'claude-mystery-1',
        displayName: 'Claude Mystery 1',
        contextWindow: 8_000,
        vision: false,
        toolUse: false,
      },
    ]);
  });

  it('toolUse is fail-closed: prefix fallback true for known families, false otherwise', async () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(
      asyncIterable([
        // SDK advertises tool_use explicitly → wins over the prefix fallback.
        {
          id: 'claude-sonnet-4-7',
          display_name: 'Sonnet',
          capabilities: { tool_use: { supported: false } },
        },
        // No SDK metadata, recognized prefix → true.
        { id: 'claude-opus-4-7', display_name: 'Opus' },
        // Unknown id, no metadata, no prefix → fail-closed false.
        { id: 'gpt-imposter', display_name: 'Imposter' },
      ]),
    );

    const models = await adapter.listModels('sk-tooluse');

    expect(models.map((m) => [m.id, m.toolUse])).toEqual([
      ['claude-sonnet-4-7', false],
      ['claude-opus-4-7', true],
      ['gpt-imposter', false],
    ]);
  });

  it('translate fans one assistant message out into strict alternating messages and maps tools arg', () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    const list: CanonicalMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'quote for AAPL and TSLA' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_call',
            id: 'toolu_a',
            name: 'market_data_stock_quote',
            arguments: { symbol: 'AAPL' },
          },
          {
            type: 'tool_call',
            id: 'toolu_b',
            name: 'market_data_stock_quote',
            arguments: { symbol: 'TSLA' },
          },
          { type: 'tool_result', toolCallId: 'toolu_a', status: 'ok', content: { price: 1 } },
          { type: 'tool_result', toolCallId: 'toolu_b', status: 'ok', content: { price: 2 } },
          { type: 'text', text: 'Both look fine.' },
        ],
      },
    ];

    const { messages } = adapter.translate(list);

    // user → assistant(text+2 tool_use) → user(2 tool_result) → assistant(text)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // No two adjacent user messages.
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role === 'user' && messages[i - 1].role === 'user').toBe(false);
    }
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'toolu_a',
        name: 'market_data_stock_quote',
        input: { symbol: 'AAPL' },
      },
      {
        type: 'tool_use',
        id: 'toolu_b',
        name: 'market_data_stock_quote',
        input: { symbol: 'TSLA' },
      },
    ]);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', is_error: undefined, content: '{"price":1}' },
      { type: 'tool_result', tool_use_id: 'toolu_b', is_error: undefined, content: '{"price":2}' },
    ]);
    expect(messages[3].content).toEqual([{ type: 'text', text: 'Both look fine.' }]);
  });

  it('streamChat passes the tools arg translated to Anthropic input_schema', async () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    streamMock.mockReturnValue(asyncIterable([{ type: 'message_stop' }]));

    const schema = { type: 'object', properties: { symbol: { type: 'string' } } } as Record<
      string,
      unknown
    >;
    const events = [];
    for await (const event of adapter.streamChat({
      apiKey: 'sk-test',
      modelId: 'claude-opus-4-7',
      messages: { system: 'sys', messages: [] },
      signal: new AbortController().signal,
      tools: [{ name: 'market_data_stock_quote', description: 'quote', inputJsonSchema: schema }],
    })) {
      events.push(event);
    }

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ name: 'market_data_stock_quote', description: 'quote', input_schema: schema }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('accumulates fragmented input_json_delta into one complete tool_call event', async () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    streamMock.mockReturnValue(
      asyncIterable([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_x',
            name: 'market_data_stock_quote',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"symb' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: 'ol": "AA' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: 'PL"}' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]),
    );

    const events = [];
    for await (const event of adapter.streamChat({
      apiKey: 'sk-test',
      modelId: 'claude-opus-4-7',
      messages: { system: 'sys', messages: [] },
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', delta: 'Checking' },
      {
        type: 'tool_call',
        id: 'toolu_x',
        name: 'market_data_stock_quote',
        arguments: { symbol: 'AAPL' },
      },
      { type: 'usage', promptTokens: 10, completionTokens: 5 },
      { type: 'done' },
    ]);
  });

  it('maps an error tool_result part to is_error:true; the carried code is a REQ-15 tool_result-bucket code', () => {
    const adapter = new ClaudeAdapter(new ListModelsCache());
    const code = TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID;
    const list: CanonicalMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'quote' }] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'toolu_e',
            name: 'market_data_stock_quote',
            arguments: { symbol: 'AAPL' },
          },
          {
            type: 'tool_result',
            toolCallId: 'toolu_e',
            status: 'error',
            content: { code, message: 'invalid key' },
          },
        ],
      },
    ];

    const { messages } = adapter.translate(list);

    const resultMsg = messages[2];
    expect(resultMsg.role).toBe('user');
    const block = (resultMsg.content as { type: string; is_error?: boolean; content: string }[])[0];
    expect(block.type).toBe('tool_result');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain(code);
    // REQ-15.5: the carried code belongs to the continue (tool_result) bucket.
    expect(bucketOf(code)).toBe('tool_result');
  });
});
