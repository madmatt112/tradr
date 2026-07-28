// GeminiAdapter (REQ-6.3 v6) — the Gemini-specific surface only: base URL
// wiring, `models/` prefix stripping, chat-family filtering, and metadata
// fallbacks. The inherited chat-completions translate/stream paths are covered
// by openai.test.ts.

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

const { GeminiAdapter, GEMINI_DEFAULT_BASE_URL } = await import('./gemini');

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

describe('GeminiAdapter', () => {
  it('constructs the SDK client against the Gemini compat endpoint', async () => {
    const adapter = new GeminiAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(asyncIterable([]));
    await adapter.listModels('gm-key');
    expect(ctorOptions).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: GEMINI_DEFAULT_BASE_URL }),
    );
  });

  it('strips the models/ prefix and keeps only gemini chat families', async () => {
    const adapter = new GeminiAdapter(new ListModelsCache());
    modelsListMock.mockResolvedValue(
      asyncIterable([
        { id: 'models/gemini-2.5-pro' },
        { id: 'models/gemini-embedding-001' },
        { id: 'models/gemma-3-27b-it' },
        { id: 'models/imagen-4.0' },
        { id: 'models/gemini-1.0-legacy' },
      ]),
    );
    const models = await adapter.listModels('gm-key');
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-1.0-legacy']);
    // Known family → 1M-token fallback metadata; unknown → conservative floor.
    expect(models[0]).toMatchObject({ contextWindow: 1_048_576, vision: true, toolUse: true });
    expect(models[1]).toMatchObject({ contextWindow: 8_000, vision: false, toolUse: false });
  });

  it('registers under its own id (cache key separation from openai)', () => {
    expect(new GeminiAdapter(new ListModelsCache()).id).toBe('gemini');
  });
});
