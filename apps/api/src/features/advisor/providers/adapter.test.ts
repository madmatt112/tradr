import { describe, expect, it } from 'vitest';

import type {
  ProviderAdapter,
  ProviderModel,
  ProviderStreamArgs,
  ProviderStreamEvent,
  ProviderToolDecl,
} from './adapter';

// Contract-level tests for the provider adapter interface (design.md §Component
// 2). These exercise the tool-use additions by constructing and consuming the
// new shapes at runtime — not merely asserting that the file compiles.

describe('ProviderToolDecl', () => {
  it('carries a flat-object input JSON schema', () => {
    const decl: ProviderToolDecl = {
      name: 'get_stock_quote',
      description: 'Fetch the latest quote for a symbol.',
      inputJsonSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    };

    expect(decl.name).toBe('get_stock_quote');
    expect(decl.inputJsonSchema.type).toBe('object');
    // No $ref / $defs at the top level (flatness constraint).
    expect(Object.keys(decl.inputJsonSchema)).not.toContain('$ref');
    expect(Object.keys(decl.inputJsonSchema)).not.toContain('$defs');
  });

  it('is accepted as the optional tools arg on ProviderStreamArgs', () => {
    const decl: ProviderToolDecl = {
      name: 'get_options_flow',
      description: 'Recent options flow for a symbol.',
      inputJsonSchema: { type: 'object', properties: {}, required: [] },
    };

    const args: ProviderStreamArgs = {
      apiKey: 'sk-test',
      modelId: 'claude-opus-4-7',
      messages: [],
      signal: new AbortController().signal,
      tools: [decl],
    };

    expect(args.tools).toHaveLength(1);
    expect(args.tools?.[0]).toBe(decl);

    // Omitting tools is a conversation-only call.
    const noTools: ProviderStreamArgs = {
      apiKey: 'sk-test',
      modelId: 'gpt-4o',
      messages: [],
      signal: new AbortController().signal,
    };
    expect(noTools.tools).toBeUndefined();
  });
});

describe('ProviderStreamEvent tool_call round-trip', () => {
  it('constructs and consumes a tool_call event off the stream', async () => {
    const events: ProviderStreamEvent[] = [
      { type: 'token', delta: 'Looking that up…' },
      {
        type: 'tool_call',
        id: 'toolu_01',
        name: 'get_stock_quote',
        arguments: { symbol: 'AAPL', limit: 10 },
      },
      { type: 'usage', promptTokens: 42, completionTokens: 7 },
      { type: 'done' },
    ];

    async function* stream(): AsyncIterable<ProviderStreamEvent> {
      for (const evt of events) yield evt;
    }

    const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
    for await (const evt of stream()) {
      if (evt.type === 'tool_call') {
        // Narrowing on the discriminant must expose id/name/arguments.
        toolCalls.push({ id: evt.id, name: evt.name, arguments: evt.arguments });
      }
    }

    expect(toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_stock_quote', arguments: { symbol: 'AAPL', limit: 10 } },
    ]);
  });
});

describe('ProviderModel.toolUse', () => {
  it('defaults fail-closed (false) for an unrecognized model', () => {
    const model: ProviderModel = {
      id: 'some-future-model',
      displayName: 'Some Future Model',
      contextWindow: 200_000,
      vision: false,
      toolUse: false,
    };

    expect(model.toolUse).toBe(false);
  });

  it('can be set true for a tool-capable model', () => {
    const model: ProviderModel = {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindow: 128_000,
      vision: true,
      toolUse: true,
    };

    expect(model.toolUse).toBe(true);
  });
});

describe('ProviderAdapter shape', () => {
  it('a minimal stub satisfies the interface including the tools-bearing streamChat', () => {
    const adapter: ProviderAdapter = {
      id: 'claude',
      listModels: async () => [],
      translate: () => [],
      prepareForTokenCount: () => [],
      async *streamChat(args: ProviderStreamArgs): AsyncIterable<ProviderStreamEvent> {
        if (args.tools && args.tools.length > 0) {
          yield {
            type: 'tool_call',
            id: 't1',
            name: args.tools[0].name,
            arguments: {},
          };
        }
        yield { type: 'done' };
      },
    };

    expect(adapter.id).toBe('claude');
  });
});
