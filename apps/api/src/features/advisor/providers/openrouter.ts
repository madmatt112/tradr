// OpenRouter provider adapter (REQ-6.3 v6). OpenRouter is an aggregator whose
// API speaks the OpenAI chat-completions dialect, so it rides the shared
// OpenAIAdapter base class — only the base URL and the model-list metadata
// mapping are OpenRouter-specific.
//
// Unlike OpenAI/Gemini, OpenRouter's /models payload ADVERTISES capability
// metadata per model (context_length, input modalities, supported parameters),
// so no hardcoded fallback map is needed: metadata is read from the payload,
// fail-closed where absent.

import type OpenAI from 'openai';

import type { ProviderId, ProviderModel } from './adapter';
import { selectPreferredModel } from './default-model';
import type { ListModelsCache } from './list-models-cache';
import { CONSERVATIVE_CONTEXT_WINDOW, OpenAIAdapter } from './openai';

/** Production endpoint; overridable via OPENROUTER_BASE_URL (E2E seam). */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The extra per-model fields OpenRouter returns beyond the OpenAI list shape.
 * The SDK types entries as OpenAI.Model; the extras ride along untyped.
 */
interface OpenRouterModelExtras {
  name?: string | null;
  context_length?: number | null;
  architecture?: { input_modalities?: string[] | null } | null;
  supported_parameters?: string[] | null;
}

/**
 * REQ-6.4 initial default-model preference list. `openrouter/auto` is
 * OpenRouter's own model router — the sensible provider-neutral default for an
 * aggregator (preferring any single vendor's model here would be arbitrary).
 */
const DEFAULT_MODEL_PREFERENCE = ['openrouter/auto'];

/** Nominal default saved when listModels is empty (probe timeout / outage). */
const NOMINAL_DEFAULT_MODEL = 'openrouter/auto';

/**
 * Select the initial `defaultModel` for a first key-save (REQ-6.4): preference
 * list first, else the lexicographically-highest vision-capable id, else the
 * nominal default.
 */
export function selectDefaultOpenRouterModel(models: ProviderModel[]): string {
  return selectPreferredModel(
    models,
    DEFAULT_MODEL_PREFERENCE,
    (m) => m.vision,
    NOMINAL_DEFAULT_MODEL,
  );
}

export class OpenRouterAdapter extends OpenAIAdapter {
  override readonly id: ProviderId = 'openrouter';

  constructor(cache: ListModelsCache, baseURL: string = OPENROUTER_DEFAULT_BASE_URL) {
    super(cache, baseURL);
  }

  /** Read the advertised metadata; fail-closed (vision/tools off) when absent. */
  protected override toProviderModel(m: OpenAI.Model): ProviderModel | null {
    const extras = m as OpenAI.Model & OpenRouterModelExtras;
    const contextWindow =
      typeof extras.context_length === 'number' && extras.context_length > 0
        ? extras.context_length
        : CONSERVATIVE_CONTEXT_WINDOW;
    return {
      id: m.id,
      displayName: extras.name ?? m.id,
      contextWindow,
      vision: extras.architecture?.input_modalities?.includes('image') ?? false,
      toolUse: extras.supported_parameters?.includes('tools') ?? false,
    };
  }
}
