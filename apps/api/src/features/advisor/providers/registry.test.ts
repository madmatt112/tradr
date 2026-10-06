import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- config mock ---------------------------------------------------------
// initProviderRegistry must read the four provider base-URL config keys and
// hand each to its own adapter (design.md §C6; requirements.md 3.4, 3.5, 3.8).

const mockConfig = vi.hoisted(() => ({
  OPENAI_BASE_URL: undefined as string | undefined,
  ANTHROPIC_BASE_URL: undefined as string | undefined,
  GEMINI_BASE_URL: 'https://gemini.example/v1',
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
}));

vi.mock('@/lib/config', () => ({ config: mockConfig }));

// --- SDK mocks -------------------------------------------------------------
// Both the Anthropic and OpenAI SDK constructors are recorded so a test can
// assert which baseURL each adapter's client build received. GeminiAdapter and
// OpenRouterAdapter share the same mocked 'openai' module (they subclass
// OpenAIAdapter), so their ctor calls land in the same spy.

const anthropicCtorOptions = vi.fn();
const anthropicModelsListMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    models = { list: anthropicModelsListMock };
    constructor(opts: unknown) {
      anthropicCtorOptions(opts);
    }
  }
  return { default: Anthropic };
});

const openaiCtorOptions = vi.fn();
const openaiModelsListMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    models = { list: openaiModelsListMock };
    constructor(opts: unknown) {
      openaiCtorOptions(opts);
    }
  }
  return { default: OpenAI };
});

// Imported AFTER the mocks are registered.
const { initProviderRegistry, getProvider } = await import('./registry');
const { ListModelsCache } = await import('./list-models-cache');

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.OPENAI_BASE_URL = undefined;
  mockConfig.ANTHROPIC_BASE_URL = undefined;
  anthropicModelsListMock.mockResolvedValue(asyncIterable([]));
  openaiModelsListMock.mockResolvedValue(asyncIterable([]));
});

describe('initProviderRegistry / getProvider', () => {
  // Contract (Req 3.4):
  //   Pre-condition: config.OPENAI_BASE_URL is set before initProviderRegistry
  //     runs.
  //   Test: initProviderRegistry(cache); getProvider('openai').listModels(key)
  //     — the only seam a caller has into the registry's adapter construction.
  //   Observable: the mocked OpenAI SDK constructor's recorded options include
  //     the configured baseURL.
  //   Expected-value source: design.md §C6 — "`initProviderRegistry` ... passes
  //     `config.OPENAI_BASE_URL` to `OpenAIAdapter`" (requirements.md 3.4).
  it('passes config.OPENAI_BASE_URL to the OpenAIAdapter the registry builds', async () => {
    mockConfig.OPENAI_BASE_URL = 'http://localhost:11434/v1';

    initProviderRegistry(new ListModelsCache());
    await getProvider('openai').listModels('sk-test');

    expect(openaiCtorOptions).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:11434/v1' }),
    );
  });

  // Contract (Req 3.5):
  //   Pre-condition: config.ANTHROPIC_BASE_URL is set before
  //     initProviderRegistry runs.
  //   Test: initProviderRegistry(cache); getProvider('claude').listModels(key).
  //   Observable: the mocked Anthropic SDK constructor's recorded options
  //     include the configured baseURL.
  //   Expected-value source: design.md §C6 — "`initProviderRegistry` ... passes
  //     `config.ANTHROPIC_BASE_URL` to `ClaudeAdapter`" (requirements.md 3.5).
  it('passes config.ANTHROPIC_BASE_URL to the ClaudeAdapter the registry builds', async () => {
    mockConfig.ANTHROPIC_BASE_URL = 'http://localhost:11434/v1';

    initProviderRegistry(new ListModelsCache());
    await getProvider('claude').listModels('sk-test');

    expect(anthropicCtorOptions).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:11434/v1' }),
    );
  });
});
