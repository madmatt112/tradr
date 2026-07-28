// Deterministic initial default-model selection (REQ-6.4, v3 — pinned rule).
//
// On first key-save the server — not the user — picks the initial
// `defaultModel` from the validation probe's listModels response, so two users
// who sign up at different times land on the same default. Each adapter file
// owns its hardcoded preference list (providers/claude.ts, providers/openai.ts)
// and calls this shared matcher.

import type { ProviderModel } from '@tradr/shared';

/**
 * Pick a model id from `models` using the REQ-6.4 rule:
 *   1. First preference-list entry with a match in `models` (case-insensitive
 *      exact id, else prefix — exact wins so `gpt-4o` never resolves to
 *      `gpt-4o-mini`; among prefix matches the lexicographically-highest id
 *      wins, which sorts dated ids newest-first regardless of API ordering).
 *   2. Else the lexicographically-highest id passing `fallbackEligible`.
 *   3. Else `nominalDefault` (listModels empty — probe timeout / outage; the
 *      user can change it once listModels works).
 */
export function selectPreferredModel(
  models: ProviderModel[],
  preferences: string[],
  fallbackEligible: (m: ProviderModel) => boolean,
  nominalDefault: string,
): string {
  for (const preferred of preferences) {
    const wanted = preferred.toLowerCase();
    const matches = models.filter((m) => m.id.toLowerCase().startsWith(wanted));
    if (matches.length === 0) continue;
    const exact = matches.find((m) => m.id.toLowerCase() === wanted);
    if (exact) return exact.id;
    return matches.map((m) => m.id).sort()[matches.length - 1] as string;
  }
  const eligible = models
    .filter(fallbackEligible)
    .map((m) => m.id)
    .sort();
  return eligible.length > 0 ? (eligible[eligible.length - 1] as string) : nominalDefault;
}
