import type { ProviderId, Tier, TierLimits } from '@tradr/shared';

import { currentPeriodKeyUtc } from '@/features/admin/gating.query';
import { config } from '@/lib/config';

import { isModelPriced } from './pricing';

// ---------------------------------------------------------------------------
// Tier limits & allowance-model constants (design D4 / Component 3).
//
// The one home for the REQ-5.1 cap table and the REQ-8.6 allowance-model
// designation — every enforcement point imports from here. All values are
// code constants; only the Pro platform-turn allowance is env-fed
// (REQ-5.2/5.3 — env-overridability for the others is deliberately NOT added
// in v1).
// ---------------------------------------------------------------------------

export type { TierLimits };

/**
 * The REQ-5.1 cap table. `null` = unlimited. A FUNCTION, never a
 * module-load-frozen object (D4): the Pro `platformTurns` value reads
 * `config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH` at check time, preserving
 * the repo's mutable-`config` test pattern.
 */
export function getTierLimits(tier: Tier): TierLimits {
  if (tier === 'pro') {
    return {
      accounts: null,
      positions: null,
      lookbackMonths: null,
      platformTurns: config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH,
      images: 500,
      csvImports: null,
    };
  }
  return {
    accounts: 1,
    positions: 1000,
    lookbackMonths: 6,
    platformTurns: 25,
    images: 20,
    csvImports: 10,
  };
}

/**
 * Per-provider allowance-model designation (REQ-8.6): a platform turn is
 * allowance-eligible only when it runs on this exact model. Seeded from
 * `PLATFORM_DEFAULT_MODEL`'s values (`pricing.ts`) but a SEPARATE constant —
 * `PLATFORM_DEFAULT_MODEL` stays documented as the existing-conversation
 * unpriced-model fallback only. Partial for the same reason PLATFORM_DEFAULT_MODEL
 * is: BYOK-only providers (gemini, openrouter) have no platform mode, so no
 * allowance model — `modelId === ALLOWANCE_MODEL[provider]` is simply never
 * true for them.
 */
export const ALLOWANCE_MODEL: Partial<Record<ProviderId, string>> = {
  claude: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
};

// Module-load assertion: every allowance model must be priced (the same
// invariant pricing.ts states for PLATFORM_DEFAULT_MODEL by comment). An
// unpriced allowance model would make "free" turns unmeterable — fail fast.
for (const [provider, model] of Object.entries(ALLOWANCE_MODEL) as [ProviderId, string][]) {
  if (!isModelPriced(provider, model)) {
    throw new Error(
      `ALLOWANCE_MODEL['${provider}'] = '${model}' is not in the priced set (RATE_TABLE)`,
    );
  }
}

/**
 * REQ-1.4 bound: `active`/`trialing` keeps Pro while
 * `now ≤ current_period_end + ACTIVE_PERIOD_SLACK_MS` — 72 h of
 * webhook-latency slack (D3).
 */
export const ACTIVE_PERIOD_SLACK_MS = 72 * 60 * 60 * 1000;

/**
 * REQ-1.4 bound: `past_due` keeps Pro while
 * `now ≤ entered_past_due_at + PAST_DUE_HORIZON_MS` — the 28-day dunning
 * horizon (D3). Dunning configured longer than this is unsupported.
 */
export const PAST_DUE_HORIZON_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * The canonical UTC `'YYYY-MM'` period key for all monthly tier counters —
 * re-exported so enforcement points key periods from this module (D4).
 */
export const PERIOD_KEY = currentPeriodKeyUtc;
