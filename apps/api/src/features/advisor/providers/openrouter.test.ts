// OpenRouterAdapter (REQ-6.3 v6) — the OpenRouter-specific surface only: base
// URL wiring and the advertised-metadata mapping (context_length, input
// modalities, supported_parameters). The inherited chat-completions paths are
// covered by openai.test.ts.

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ListModelsCache } from './list-models-cache';

const modelsListMock = vi.fn();
const ctorOptions = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: vi.fn() } };
    models = { list: modelsListMock };
    constructor(opts: unknown) {
      ctorOptions(opts);
    }
  }
  return { default: OpenAI };
});

const { OpenRouterAdapter, OPENROUTER_DEFAULT_BASE_URL } = await import('./openrouter');

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

describe('OpenRouterAdapter', () => {
  it('constructs the SDK client against the OpenRouter endpoint', async () => {
    const adapter = new OpenRouterAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(asyncIterable([]));
    await adapter.listModels('or-key');
    expect(ctorOptions).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: OPENROUTER_DEFAULT_BASE_URL }),
    );
  });

  it('reads advertised metadata and fails closed where absent', async () => {
    const adapter = new OpenRouterAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(
      asyncIterable([
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Anthropic: Claude Sonnet 4.5',
          context_length: 200_000,
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['tools', 'temperature'],
        },
        // No metadata advertised → conservative floor, vision/tools off.
        { id: 'mystery/model' },
      ]),
    );
    const models = await adapter.listModels('or-key');
    expect(models[0]).toEqual({
      id: 'anthropic/claude-sonnet-4.5',
      displayName: 'Anthropic: Claude Sonnet 4.5',
      contextWindow: 200_000,
      vision: true,
      toolUse: true,
    });
    expect(models[1]).toEqual({
      id: 'mystery/model',
      displayName: 'mystery/model',
      contextWindow: 8_000,
      vision: false,
      toolUse: false,
    });
  });

  it('registers under its own id (cache key separation from openai)', () => {
    expect(new OpenRouterAdapter(new ListModelsCache()).id).toBe('openrouter');
  });
});
