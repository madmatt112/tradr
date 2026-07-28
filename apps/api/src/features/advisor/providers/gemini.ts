// Google Gemini provider adapter (REQ-6.3 v6). Rides Gemini's OpenAI-compatible
// endpoint via the shared OpenAIAdapter base class — chat-completions streaming,
// tool-call accumulation, and token-count prep are inherited unchanged. Only the
// base URL and the model-list metadata mapping are Gemini-specific.
//
// The compat endpoint returns model ids prefixed `models/` (e.g.
// `models/gemini-2.5-pro`); chat completions accept the bare id, so the prefix
// is stripped at list time and bare ids are what get stored and sent.

import type OpenAI from 'openai';

import type { ProviderId, ProviderModel } from './adapter';
import { selectPreferredModel } from './default-model';
import type { ListModelsCache } from './list-models-cache';
import { CONSERVATIVE_CONTEXT_WINDOW, OpenAIAdapter } from './openai';

/** Production compat endpoint; overridable via GEMINI_BASE_URL (E2E seam). */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Hardcoded context windows / vision flags keyed by model-id prefix (REQ-9.5) —
 * the compat models list advertises neither. All Gemini 2+ families are
 * natively multimodal with a ~1M-token context window. Do NOT widen beyond
 * known families: it is a fallback, not the source of truth.
 */
const FALLBACK_PREFIXES: { prefix: string; contextWindow: number; vision: boolean }[] = [
  { prefix: 'gemini-3', contextWindow: 1_048_576, vision: true },
  { prefix: 'gemini-2.5', contextWindow: 1_048_576, vision: true },
  { prefix: 'gemini-2.0', contextWindow: 1_048_576, vision: true },
];

/**
 * Conservative tool-use prefix fallback (REQ-2.1): the compat list payload has
 * no capability flags. Fail-closed — an unrecognized id is conversation-only.
 */
const TOOL_USE_PREFIXES = ['gemini-3', 'gemini-2.5', 'gemini-2.0'];

/**
 * REQ-6.4 initial default-model preference list. Maintained here (adapter
 * code) and updated when newer models ship. Prefix matching resolves preview /
 * dated variants (e.g. `gemini-3-pro-preview`).
 */
const DEFAULT_MODEL_PREFERENCE = [
  'gemini-3-pro',
  'gemini-3-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

/** Nominal default saved when listModels is empty (probe timeout / outage). */
const NOMINAL_DEFAULT_MODEL = 'gemini-2.5-pro';

/**
 * Select the initial `defaultModel` for a first key-save (REQ-6.4): preference
 * list first, else the lexicographically-highest vision-capable id, else the
 * nominal default.
 */
export function selectDefaultGeminiModel(models: ProviderModel[]): string {
  return selectPreferredModel(
    models,
    DEFAULT_MODEL_PREFERENCE,
    (m) => m.vision,
    NOMINAL_DEFAULT_MODEL,
  );
}

export class GeminiAdapter extends OpenAIAdapter {
  override readonly id: ProviderId = 'gemini';

  constructor(cache: ListModelsCache, baseURL: string = GEMINI_DEFAULT_BASE_URL) {
    super(cache, baseURL);
  }

  /**
   * The compat list mixes chat models with embedding / media models under the
   * same `models/` namespace. Keep only the `gemini-*` chat families (drops
   * `gemma-*`, `text-embedding-*`, imagen/veo ids) and skip embedding variants
   * that share the `gemini-` prefix.
   */
  protected override toProviderModel(m: OpenAI.Model): ProviderModel | null {
    const id = m.id.replace(/^models\//, '');
    if (!id.startsWith('gemini-') || id.includes('embedding')) return null;
    const fallback = FALLBACK_PREFIXES.find((f) => id.startsWith(f.prefix));
    return {
      id,
      displayName: id,
      contextWindow: fallback?.contextWindow ?? CONSERVATIVE_CONTEXT_WINDOW,
      vision: fallback?.vision ?? false,
      toolUse: TOOL_USE_PREFIXES.some((p) => id.startsWith(p)),
    };
  }
}
