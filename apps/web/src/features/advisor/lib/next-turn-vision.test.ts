import { describe, expect, it } from 'vitest';

import {
  type ByokModel,
  nextTurnVisionEnabled,
  type NextTurnVisionInput,
} from './next-turn-vision';

function byok(id: string, vision: boolean): ByokModel {
  return { providerId: 'claude', id, displayName: id, contextWindow: 1, vision, toolUse: true };
}

const base: NextTurnVisionInput = {
  conversation: null,
  existingConversation: false,
  showPlatformPicker: false,
  platformOverride: null,
  providerKeys: [],
  byokModels: [],
  platformModels: [],
};

describe('nextTurnVisionEnabled', () => {
  it("is true for a new BYOK conversation whose key's default model sees images", () => {
    expect(
      nextTurnVisionEnabled({
        ...base,
        providerKeys: [{ providerId: 'claude', defaultModel: 'claude-sonnet-4-5' }],
        byokModels: [byok('claude-sonnet-4-5', true)],
      }),
    ).toBe(true);
  });

  it("is false for a new BYOK conversation whose key's default model is text-only", () => {
    expect(
      nextTurnVisionEnabled({
        ...base,
        providerKeys: [{ providerId: 'claude', defaultModel: 'claude-haiku-3-5' }],
        byokModels: [byok('claude-haiku-3-5', false), byok('claude-sonnet-4-5', true)],
      }),
    ).toBe(false);
  });

  it('follows the picked platform model in platform-picker mode', () => {
    const platformModels = [
      { providerId: 'openai' as const, model: 'gpt-4o', vision: true },
      { providerId: 'openai' as const, model: 'gpt-4o-mini', vision: false },
    ];
    const input = { ...base, showPlatformPicker: true, platformModels };
    expect(nextTurnVisionEnabled({ ...input, platformOverride: platformModels[0] })).toBe(true);
    expect(nextTurnVisionEnabled({ ...input, platformOverride: platformModels[1] })).toBe(false);
    expect(nextTurnVisionEnabled({ ...input, platformOverride: null })).toBe(false);
  });

  it("uses an existing conversation's pinned model, not the key's default", () => {
    const input = {
      ...base,
      existingConversation: true,
      providerKeys: [{ providerId: 'claude' as const, defaultModel: 'claude-sonnet-4-5' }],
      byokModels: [byok('claude-haiku-3-5', false), byok('claude-sonnet-4-5', true)],
    };
    expect(
      nextTurnVisionEnabled({
        ...input,
        conversation: { providerId: 'claude', model: 'claude-haiku-3-5' },
      }),
    ).toBe(false);
    expect(
      nextTurnVisionEnabled({
        ...input,
        conversation: { providerId: 'claude', model: 'claude-sonnet-4-5' },
      }),
    ).toBe(true);
  });

  it('reads the platform list for an existing conversation on a provider with no key', () => {
    expect(
      nextTurnVisionEnabled({
        ...base,
        existingConversation: true,
        conversation: { providerId: 'openai', model: 'gpt-4o' },
        platformModels: [{ providerId: 'openai', model: 'gpt-4o', vision: true }],
      }),
    ).toBe(true);
  });

  it('is false when the model is unknown or there is nothing to send on', () => {
    expect(nextTurnVisionEnabled(base)).toBe(false);
    expect(
      nextTurnVisionEnabled({
        ...base,
        providerKeys: [{ providerId: 'claude', defaultModel: 'claude-new' }],
      }),
    ).toBe(false);
  });
});
