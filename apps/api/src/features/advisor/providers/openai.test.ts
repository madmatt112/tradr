import { describe, expect, it, vi, beforeEach } from 'vitest';

import { TOOL_RESULT_CODES, bucketOf } from '../tools/error-codes';

import type { CanonicalMessage, ProviderToolDecl } from './adapter';
import { ListModelsCache } from './list-models-cache';

// --- SDK mock ----------------------------------------------------------------
// One mocked OpenAI client backs the whole suite. `createMock` returns the
// async-iterable stream the tests pre-load; `modelsListMock` is the
// (async-iterable) models.list() result; `ctorOptions` records constructor args.

const createMock = vi.fn();
const modelsListMock = vi.fn();
const ctorOptions = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    models = { list: modelsListMock };
    constructor(opts: unknown) {
      ctorOptions(opts);
    }
  }
  return { default: OpenAI };
});

// Imported AFTER the mock is registered.
const { OpenAIAdapter } = await import('./openai');

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

describe('OpenAIAdapter', () => {
  it('constructs the SDK client with the pinned 600_000ms timeout', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    createMock.mockResolvedValue(asyncIterable([]));
    // Trigger a client construction via streamChat (lazy per-call client).
    await adapter
      .streamChat({
        apiKey: 'sk-test',
        modelId: 'gpt-4o',
        messages: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]()
      .next();

    expect(ctorOptions).toHaveBeenCalledWith({ apiKey: 'sk-test', timeout: 600_000 });
  });

  it('translates canonical messages into ChatCompletionMessageParam (system first)', () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
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

    const messages = adapter.translate(list);

    expect(messages).toEqual([
      { role: 'system', content: 'You are a trading advisor.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this chart' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      // Assistant text parts collapse onto a string `content` (fan-out, REQ-2.4).
      { role: 'assistant', content: 'Looks bullish.' },
    ]);
  });

  it('streamChat filters empty deltas and yields token, usage, then done', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    createMock.mockResolvedValue(
      asyncIterable([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: '' } }] }, // empty delta is filtered
        { choices: [{ delta: {} }] }, // no content is filtered
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
      ]),
    );

    const events = [];
    for await (const event of adapter.streamChat({
      apiKey: 'sk-test',
      modelId: 'gpt-4o',
      messages: [],
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
    expect(createMock).toHaveBeenCalledWith(
      {
        model: 'gpt-4o',
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('listModels maps via the prefix fallback and caches (one fetch per key)', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(asyncIterable([{ id: 'gpt-4o' }]));

    const first = await adapter.listModels('sk-cache');
    const second = await adapter.listModels('sk-cache');

    expect(first).toEqual([
      { id: 'gpt-4o', displayName: 'gpt-4o', contextWindow: 128_000, vision: true, toolUse: true },
    ]);
    expect(second).toBe(first);
    expect(modelsListMock).toHaveBeenCalledTimes(1);
  });

  it('listModels falls back to a conservative floor with vision off for unknown ids', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(
      asyncIterable([{ id: 'gpt-4o-mini' }, { id: 'mystery-model-1' }]),
    );

    const models = await adapter.listModels('sk-unknown');

    expect(models).toEqual([
      // gpt-4o-mini matches its dedicated prefix before the broader gpt-4o entry,
      // and gpt-4o is a recognized function-calling family → toolUse:true.
      {
        id: 'gpt-4o-mini',
        displayName: 'gpt-4o-mini',
        contextWindow: 128_000,
        vision: true,
        toolUse: true,
      },
      // Unknown id is never blanket-defaulted to 128k/true, and toolUse is
      // fail-closed false for unrecognized ids (REQ-2.1).
      {
        id: 'mystery-model-1',
        displayName: 'mystery-model-1',
        contextWindow: 8_000,
        vision: false,
        toolUse: false,
      },
    ]);
  });

  it('translates ProviderToolDecl into non-strict tools[{type:function}] (optional fields preserved)', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    createMock.mockResolvedValue(asyncIterable([]));
    const tools: ProviderToolDecl[] = [
      {
        name: 'market_data_options_flow',
        description: 'Recent options flow',
        // Flat draft-07 schema with an OPTIONAL field (no all-required, no strict).
        inputJsonSchema: {
          type: 'object',
          properties: { symbol: { type: 'string' }, limit: { type: 'number' } },
          required: ['symbol'],
          additionalProperties: false,
        },
      },
    ];

    const events = [];
    for await (const event of adapter.streamChat({
      apiKey: 'sk-test',
      modelId: 'gpt-4o',
      messages: [],
      signal: new AbortController().signal,
      tools,
    })) {
      events.push(event);
    }

    const callBody = createMock.mock.calls[0][0];
    expect(callBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'market_data_options_flow',
          description: 'Recent options flow',
          parameters: {
            type: 'object',
            properties: { symbol: { type: 'string' }, limit: { type: 'number' } },
            required: ['symbol'],
            additionalProperties: false,
          },
        },
      },
    ]);
    // NON-STRICT: no strict flag is emitted.
    expect(callBody.tools[0].function.strict).toBeUndefined();
  });

  it('omits tools entirely for a conversation-only (no-tools) call', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    createMock.mockResolvedValue(asyncIterable([]));

    await adapter
      .streamChat({
        apiKey: 'sk-test',
        modelId: 'gpt-4o',
        messages: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]()
      .next();

    expect(createMock.mock.calls[0][0]).not.toHaveProperty('tools');
  });

  it('fans an assistant message out into tool_calls + role:tool result messages', () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    const list: CanonicalMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'quote AAPL' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'market_data_stock_quote',
            arguments: { symbol: 'AAPL' },
          },
          {
            type: 'tool_result',
            toolCallId: 'call_1',
            status: 'ok',
            content: { price: 100 },
          },
          { type: 'text', text: 'AAPL is at 100.' },
        ],
      },
    ];

    const messages = adapter.translate(list);

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'quote AAPL' }] },
      {
        role: 'assistant',
        content: 'Checking.AAPL is at 100.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'market_data_stock_quote', arguments: '{"symbol":"AAPL"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"price":100}' },
    ]);
  });

  it('maps an error tool_result to a role:tool message carrying a REQ-15 tool_result-bucket code', () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    const code = TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID;
    const list: CanonicalMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'quote' }] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call_e',
            name: 'market_data_stock_quote',
            arguments: { symbol: 'AAPL' },
          },
          {
            type: 'tool_result',
            toolCallId: 'call_e',
            status: 'error',
            content: { code, message: 'invalid key' },
          },
        ],
      },
    ];

    const messages = adapter.translate(list);

    const toolMsg = messages[2] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_e');
    // Content carries the error code AND message so the model can adapt.
    expect(toolMsg.content).toContain(code);
    expect(toolMsg.content).toContain('invalid key');
    // REQ-15.5: the carried code belongs to the continue (tool_result) bucket.
    expect(bucketOf(code)).toBe('tool_result');
  });

  it('accumulates fragmented tool_call argument deltas into one complete tool_call', async () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    createMock.mockResolvedValue(
      asyncIterable([
        // Opening fragment carries id + name + partial args.
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'market_data_stock_quote', arguments: '{"sym' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        // Continuation fragments carry only argument text.
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'bol":"A' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'APL"}' } }] },
              finish_reason: null,
            },
          ],
        },
        // Close: finish_reason:'tool_calls' flushes the accumulated call.
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9 } },
      ]),
    );

    const events = [];
    for await (const event of adapter.streamChat({
      apiKey: 'sk-test',
      modelId: 'gpt-4o',
      messages: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'market_data_stock_quote',
        arguments: { symbol: 'AAPL' },
      },
      { type: 'usage', promptTokens: 12, completionTokens: 9 },
      { type: 'done' },
    ]);
  });
});
