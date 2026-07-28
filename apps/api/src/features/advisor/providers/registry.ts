// Provider adapter registry. Per design.md §Component 2 ("registry.ts").
//
// Holds the stateless adapter singletons (ClaudeAdapter, OpenAIAdapter, plus
// the OpenAI-compatible GeminiAdapter and OpenRouterAdapter), each constructed
// ONCE at bootstrap with the shared ListModelsCache. There is no auto-init:
// the bootstrap path (Task 28) calls `initProviderRegistry(new
// ListModelsCache())` exactly once before the HTTP listener opens. The
// streaming orchestration (Task 21) reads adapters via `getProvider(id)`.
//
// Adapters are NOT recreated per call — `getProvider` returns the singleton from
// the module-level map built at init.

import { config } from '@/lib/config';

import type { ProviderAdapter, ProviderId } from './adapter';
import { ClaudeAdapter } from './claude';
import { GeminiAdapter } from './gemini';
import type { ListModelsCache } from './list-models-cache';
import { OpenAIAdapter } from './openai';
import { OpenRouterAdapter } from './openrouter';

let registry: Record<ProviderId, ProviderAdapter> | null = null;

/**
 * Construct the adapter singletons once with the shared cache. Called exactly
 * once at bootstrap. Calling again replaces the registry (adapters rebuilt) —
 * the bootstrap contract is a single call. Gemini/OpenRouter base URLs come
 * from config (production defaults; overridable as an E2E/stub seam).
 */
export function initProviderRegistry(cache: ListModelsCache): void {
  registry = {
    claude: new ClaudeAdapter(cache),
    openai: new OpenAIAdapter(cache),
    gemini: new GeminiAdapter(cache, config.GEMINI_BASE_URL),
    openrouter: new OpenRouterAdapter(cache, config.OPENROUTER_BASE_URL),
  };
}

/**
 * Return the singleton adapter for `id`. Throws if the registry has not
 * been initialised (programmer error: bootstrap must call
 * `initProviderRegistry` before any streaming request).
 */
export function getProvider(id: ProviderId): ProviderAdapter {
  if (registry === null) {
    throw new Error(
      'Provider registry not initialised: call initProviderRegistry(cache) at bootstrap',
    );
  }
  return registry[id];
}
