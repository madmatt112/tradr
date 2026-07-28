// REQ-6.4 deterministic initial default-model selection — covers the shared
// matcher plus both adapters' configured selectors: preference-list order,
// exact-over-prefix precedence, dated-id resolution, the vision fallback, and
// the nominal default when listModels is empty (probe timeout / outage).

import { describe, expect, it } from 'vitest';

import type { ProviderModel } from '@tradr/shared';

import { selectDefaultClaudeModel } from './claude';
import { selectDefaultGeminiModel } from './gemini';
import { selectDefaultOpenAIModel } from './openai';
import { selectDefaultOpenRouterModel } from './openrouter';

function model(id: string, vision = true): ProviderModel {
  return { id, displayName: id, contextWindow: 200_000, vision, toolUse: true };
}

describe('selectDefaultClaudeModel', () => {
  it('picks the highest-ranked preference-list entry present in listModels', () => {
    const picked = selectDefaultClaudeModel([
      model('claude-sonnet-4-6'),
      model('claude-opus-4-7'),
      model('claude-haiku-4-5'),
    ]);
    expect(picked).toBe('claude-opus-4-7');
  });

  it('resolves dated ids via prefix match, newest date first', () => {
    const picked = selectDefaultClaudeModel([
      model('claude-opus-4-8-20260210'),
      model('claude-opus-4-8-20251101'),
      model('claude-sonnet-4-6-20250514'),
    ]);
    expect(picked).toBe('claude-opus-4-8-20260210');
  });

  it('falls back to the lexicographically-highest vision model when nothing matches', () => {
    const picked = selectDefaultClaudeModel([
      model('claude-2-1', false),
      model('claude-experimental-a'),
      model('claude-experimental-b'),
    ]);
    expect(picked).toBe('claude-experimental-b');
  });

  it('returns the nominal default when listModels is empty', () => {
    expect(selectDefaultClaudeModel([])).toBe('claude-opus-4-8');
  });
});

describe('selectDefaultGeminiModel', () => {
  it('prefers the newest pro family, resolving preview variants via prefix', () => {
    const picked = selectDefaultGeminiModel([
      model('gemini-2.5-flash'),
      model('gemini-3-pro-preview'),
      model('gemini-2.5-pro'),
    ]);
    expect(picked).toBe('gemini-3-pro-preview');
  });

  it('returns the nominal default when listModels is empty', () => {
    expect(selectDefaultGeminiModel([])).toBe('gemini-2.5-pro');
  });
});

describe('selectDefaultOpenRouterModel', () => {
  it('prefers the openrouter/auto router when listed', () => {
    const picked = selectDefaultOpenRouterModel([
      model('anthropic/claude-sonnet-4.5'),
      model('openrouter/auto'),
      model('deepseek/deepseek-chat'),
    ]);
    expect(picked).toBe('openrouter/auto');
  });

  it('returns the nominal default when listModels is empty', () => {
    expect(selectDefaultOpenRouterModel([])).toBe('openrouter/auto');
  });
});

describe('selectDefaultOpenAIModel', () => {
  it('prefers the exact id over prefix matches (gpt-4o beats gpt-4o-mini)', () => {
    const picked = selectDefaultOpenAIModel([
      model('gpt-4o-mini'),
      model('gpt-4o'),
      model('gpt-3.5-turbo', false),
    ]);
    expect(picked).toBe('gpt-4o');
  });

  it('falls back to the highest vision-capable gpt-4* id when nothing matches', () => {
    const picked = selectDefaultOpenAIModel([
      model('gpt-4.1', true),
      model('gpt-4.1-nano', true),
      model('o3-mini', false),
    ]);
    expect(picked).toBe('gpt-4.1-nano');
  });

  it('returns the nominal default when listModels is empty', () => {
    expect(selectDefaultOpenAIModel([])).toBe('gpt-4o');
  });
});
