import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ProviderKeyRejectedError } from './advisor.errors';
import { estimateTokens, resolveEncoder } from './cap-check';
import type { CanonicalMessage, ProviderAdapter } from './providers/adapter';
import { ListModelsCache } from './providers/list-models-cache';
import { OpenAIAdapter } from './providers/openai';

// --- tiktoken mock -----------------------------------------------------------
// get_encoding(name) returns an encoder whose encode() length is the token count.
// freeMock tracks that the encoder is released. The dynamic import() in cap-check
// resolves to this module.

const encodeMock = vi.fn();
const freeMock = vi.fn();
const getEncodingMock = vi.fn(() => ({ encode: encodeMock, free: freeMock }));

vi.mock('tiktoken', () => ({ get_encoding: getEncodingMock }));

// --- @anthropic-ai/sdk mock --------------------------------------------------

const countTokensMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { countTokens: countTokensMock };
  }
  return { default: Anthropic };
});

function openaiAdapter(): ProviderAdapter {
  return {
    id: 'openai',
    listModels: vi.fn(),
    translate: vi.fn(),
    prepareForTokenCount: vi.fn(() => 'system: hi\n\nuser: chart'),
    streamChat: vi.fn(),
  };
}

function claudeAdapter(): ProviderAdapter {
  return {
    id: 'claude',
    listModels: vi.fn(),
    translate: vi.fn(),
    prepareForTokenCount: vi.fn(() => ({ system: 'sys', messages: [] })),
    streamChat: vi.fn(),
  };
}

const TEXT_LIST: CanonicalMessage[] = [
  { role: 'system', content: 'You are a trading advisor.' }, // 26 chars
  { role: 'user', parts: [{ type: 'text', text: 'hello' }] }, // 5 chars
];

// Same text-only prefix as TEXT_LIST plus a tool-heavy assistant turn: a
// tool_call with bulky arguments and a tool_result with a bulky payload. The
// fallback estimator (§Component 8) must count these serialized parts.
const bigArgs = { symbols: 'A'.repeat(200) };
const bigResult = { quotes: 'Q'.repeat(800) };
const TOOL_HEAVY_LIST: CanonicalMessage[] = [
  ...TEXT_LIST,
  {
    role: 'assistant',
    parts: [
      { type: 'tool_call', id: 'tc1', name: 'market_data_stock_quote', arguments: bigArgs },
      { type: 'tool_result', toolCallId: 'tc1', status: 'ok', content: bigResult },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveEncoder', () => {
  it('maps gpt-4o family to o200k_base (first match wins over gpt-4)', () => {
    expect(resolveEncoder('gpt-4o')).toBe('o200k_base');
    expect(resolveEncoder('gpt-4o-mini-2024-07-18')).toBe('o200k_base');
  });

  it('maps gpt-4 and gpt-3.5 prefixes to cl100k_base', () => {
    expect(resolveEncoder('gpt-4-turbo')).toBe('cl100k_base');
    expect(resolveEncoder('gpt-4-0613')).toBe('cl100k_base');
    expect(resolveEncoder('gpt-3.5-turbo')).toBe('cl100k_base');
  });

  it('returns null for unknown models (no silent cl100k_base default)', () => {
    expect(resolveEncoder('mystery-model-1')).toBeNull();
    expect(resolveEncoder('o1-preview')).toBeNull();
  });
});

describe('estimateTokens — OpenAI', () => {
  it('encodes via tiktoken, adds 765 per image, and frees the encoder', async () => {
    encodeMock.mockReturnValue(new Uint32Array(40)); // 40 text tokens
    const result = await estimateTokens({
      adapter: openaiAdapter(),
      list: TEXT_LIST,
      modelId: 'gpt-4o',
      apiKey: 'sk-test',
      imageCount: 2,
    });

    expect(getEncodingMock).toHaveBeenCalledWith('o200k_base');
    expect(result).toEqual({ tokens: 40 + 2 * 765, source: 'tiktoken' });
    expect(freeMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the heuristic for unknown models without loading tiktoken', async () => {
    const result = await estimateTokens({
      adapter: openaiAdapter(),
      list: TEXT_LIST,
      modelId: 'mystery-model-1',
      apiKey: 'sk-test',
      imageCount: 1,
    });

    // ceil((26 + 5) / 3) + 1500 * 1 = 11 + 1500
    expect(result).toEqual({ tokens: 11 + 1500, source: 'fallback' });
    expect(getEncodingMock).not.toHaveBeenCalled();
  });

  it('routes OpenAI-compatible adapters (gemini/openrouter) to the LOCAL path, never Anthropic countTokens', async () => {
    // Regression (v6): dispatch was `id === 'openai'`, which dropped the compat
    // adapters into the Claude branch — a live Anthropic countTokens call with
    // a non-Anthropic key → spurious PROVIDER_KEY_REJECTED before every stream.
    for (const id of ['gemini', 'openrouter'] as const) {
      const adapter = { ...openaiAdapter(), id };
      const result = await estimateTokens({
        adapter,
        list: TEXT_LIST,
        modelId: id === 'gemini' ? 'gemini-2.5-pro' : 'openrouter/auto',
        apiKey: 'not-an-anthropic-key',
        imageCount: 0,
      });
      expect(result.source).toBe('fallback'); // unknown encoder → local heuristic
      expect(countTokensMock).not.toHaveBeenCalled();
    }
  });
});

describe('estimateTokens — tool-part counting (§Component 8)', () => {
  // contextWindow proxy for the 0.75 trigger: a tool-heavy turn must estimate
  // materially higher than text-only — enough to cross 0.75 where text-only stays
  // under it. Uses the fallback path (unknown model → no tiktoken), which exercises
  // the shared fallbackTokens estimator for both providers.
  function fallbackEstimate(list: CanonicalMessage[]): Promise<number> {
    return estimateTokens({
      adapter: openaiAdapter(),
      list,
      modelId: 'mystery-model-1', // unknown → fallback heuristic
      apiKey: 'sk-test',
      imageCount: 0,
    }).then((r) => {
      expect(r.source).toBe('fallback');
      return r.tokens;
    });
  }

  it('estimates a tool-heavy turn materially higher than text-only', async () => {
    const textOnly = await fallbackEstimate(TEXT_LIST);
    const toolHeavy = await fallbackEstimate(TOOL_HEAVY_LIST);

    // tool_call name (24) + JSON args (~217) + tool_result JSON content (~819)
    // dominate the 31 text chars: the tool-heavy estimate is far larger.
    expect(toolHeavy).toBeGreaterThan(textOnly * 10);
  });

  it('trips 0.75 of a context window the text-only turn stays under', async () => {
    const textOnly = await fallbackEstimate(TEXT_LIST);
    const toolHeavy = await fallbackEstimate(TOOL_HEAVY_LIST);

    // A window where text-only sits below 0.75 but the tool-heavy turn exceeds it.
    const contextWindow = Math.ceil(toolHeavy / 0.75) - 1;
    expect(textOnly).toBeLessThan(0.75 * contextWindow);
    expect(toolHeavy).toBeGreaterThan(0.75 * contextWindow);
  });

  it('real OpenAI prepareForTokenCount serializes tool-call args + tool_result content', () => {
    const adapter = new OpenAIAdapter(new ListModelsCache());
    const text = adapter.prepareForTokenCount(TEXT_LIST);
    const tool = adapter.prepareForTokenCount(TOOL_HEAVY_LIST);

    // The flat string now carries the tool name, serialized arguments, and the
    // serialized tool_result content — so it is materially longer than text-only
    // and (via tiktoken on this string) estimates higher.
    expect(tool).toContain('market_data_stock_quote');
    expect(tool).toContain('A'.repeat(200));
    expect(tool).toContain('Q'.repeat(800));
    expect(tool.length).toBeGreaterThan(text.length * 10);
  });
});

describe('estimateTokens — tool-declaration counting (§Component 8 step 1)', () => {
  const DECLS = [
    {
      name: 'market_data_stock_quote',
      description: 'D'.repeat(300),
      inputJsonSchema: { type: 'object', properties: { symbols: { type: 'string' } } },
    },
  ];

  it('fallback path: declarations raise the estimate', async () => {
    const base = await estimateTokens({
      adapter: openaiAdapter(),
      list: TEXT_LIST,
      modelId: 'mystery-model-1', // unknown → fallback heuristic
      apiKey: 'sk-test',
      imageCount: 0,
    });
    const withDecls = await estimateTokens({
      adapter: openaiAdapter(),
      list: TEXT_LIST,
      modelId: 'mystery-model-1',
      apiKey: 'sk-test',
      imageCount: 0,
      toolDeclarations: DECLS,
    });

    expect(base.source).toBe('fallback');
    expect(withDecls.source).toBe('fallback');
    expect(withDecls.tokens).toBeGreaterThan(base.tokens);
  });

  it('OpenAI tiktoken path: the declaration JSON is appended to the encoded string', async () => {
    encodeMock.mockImplementation((s: string) => new Uint32Array(s.length));
    const result = await estimateTokens({
      adapter: openaiAdapter(), // flat string 'system: hi\n\nuser: chart' (22 chars)
      list: TEXT_LIST,
      modelId: 'gpt-4o',
      apiKey: 'sk-test',
      imageCount: 0,
      toolDeclarations: DECLS,
    });

    const encoded = encodeMock.mock.calls[0][0] as string;
    expect(encoded).toContain('market_data_stock_quote');
    expect(encoded).toContain(JSON.stringify(DECLS));
    expect(result.tokens).toBe(encoded.length); // > the 22-char flat-only string
  });

  it('Claude countTokens path: the declaration JSON is folded into system', async () => {
    countTokensMock.mockResolvedValue({ input_tokens: 1234 });
    await estimateTokens({
      adapter: claudeAdapter(), // system: 'sys'
      list: TEXT_LIST,
      modelId: 'claude-opus-4-7',
      apiKey: 'sk-ant',
      imageCount: 0,
      toolDeclarations: DECLS,
    });

    const arg = countTokensMock.mock.calls[0][0] as { system: string };
    expect(arg.system).toContain('sys');
    expect(arg.system).toContain(JSON.stringify(DECLS));
  });

  it('empty / omitted declarations add no cost and leave system untouched', async () => {
    countTokensMock.mockResolvedValue({ input_tokens: 1234 });
    await estimateTokens({
      adapter: claudeAdapter(),
      list: TEXT_LIST,
      modelId: 'claude-opus-4-7',
      apiKey: 'sk-ant',
      imageCount: 0,
      toolDeclarations: [],
    });

    expect(countTokensMock).toHaveBeenCalledWith({
      model: 'claude-opus-4-7',
      system: 'sys',
      messages: [],
    });
  });
});

describe('estimateTokens — Claude', () => {
  it('returns countTokens input_tokens on success', async () => {
    countTokensMock.mockResolvedValue({ input_tokens: 1234 });
    const result = await estimateTokens({
      adapter: claudeAdapter(),
      list: TEXT_LIST,
      modelId: 'claude-opus-4-7',
      apiKey: 'sk-ant',
      imageCount: 0,
    });

    expect(countTokensMock).toHaveBeenCalledWith({
      model: 'claude-opus-4-7',
      system: 'sys',
      messages: [],
    });
    expect(result).toEqual({ tokens: 1234, source: 'countTokens' });
  });

  it('throws ProviderKeyRejectedError on 401/403 without falling back', async () => {
    countTokensMock.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));

    await expect(
      estimateTokens({
        adapter: claudeAdapter(),
        list: TEXT_LIST,
        modelId: 'claude-opus-4-7',
        apiKey: 'sk-ant',
        imageCount: 0,
      }),
    ).rejects.toBeInstanceOf(ProviderKeyRejectedError);
  });

  it('falls back to the heuristic on a 5xx error', async () => {
    countTokensMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }));
    const result = await estimateTokens({
      adapter: claudeAdapter(),
      list: TEXT_LIST,
      modelId: 'claude-opus-4-7',
      apiKey: 'sk-ant',
      imageCount: 2,
    });

    // ceil(31 / 3) + 1500 * 2 = 11 + 3000
    expect(result).toEqual({ tokens: 11 + 3000, source: 'fallback' });
  });

  it('falls back to the heuristic when countTokens exceeds the timeout', async () => {
    countTokensMock.mockReturnValue(new Promise(() => {})); // never resolves
    const result = await estimateTokens({
      adapter: claudeAdapter(),
      list: TEXT_LIST,
      modelId: 'claude-opus-4-7',
      apiKey: 'sk-ant',
      imageCount: 0,
      countTokensTimeoutMs: 10, // production default is 5_000 (COUNT_TOKENS_TIMEOUT_MS)
    });

    expect(result).toEqual({ tokens: 11, source: 'fallback' });
  });
});
