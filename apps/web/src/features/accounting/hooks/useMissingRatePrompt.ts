import { useDashboardTotalQuery } from '@/features/accounting/hooks/useDashboardTotal';

export interface MissingPair {
  baseCurrency: string;
  quoteCurrency: string;
}

export interface MissingRatePromptResult {
  /** True when the dashboard total response includes at least one missing pair. */
  shouldPrompt: boolean;
  /** The first missing pair (the deeplink target). */
  missingPair: MissingPair | null;
  /** All missing pairs (for surfaces that want to enumerate them). */
  missingPairs: readonly MissingPair[];
  /** Deeplink to the FX settings tab with `(base, quote)` query params prefilled. */
  deeplinkTo: string | null;
}

/**
 * Detects missing exchange-rate pairs from the dashboard total response and
 * exposes the data for an inline "enter rate" prompt. Deeplink targets
 * `missingPairs[0]`; Task 11's `computeDashboardTotal` guarantees the array
 * is sorted by `(baseCurrency ASC, quoteCurrency ASC)`, so the deeplink is
 * deterministic and testable.
 *
 * Returns `shouldPrompt: false` when there are no missing pairs, when the
 * dashboard query is still loading, or when it errored.
 */
export function useMissingRatePrompt(): MissingRatePromptResult {
  const { data } = useDashboardTotalQuery();
  const missingPairs = data?.missingPairs ?? [];
  const missingPair = missingPairs[0] ?? null;
  const shouldPrompt = missingPair !== null;
  // The FX/exchange-rate entry form lives on the Profile settings tab
  // (`/settings/profile`), which reads `base`/`quote` to prefill the form.
  // Bare `/settings` redirects to `/settings/advisor` and drops the params, so
  // the deeplink must target the profile tab directly.
  const deeplinkTo = missingPair
    ? `/settings/profile?base=${encodeURIComponent(missingPair.baseCurrency)}&quote=${encodeURIComponent(missingPair.quoteCurrency)}`
    : null;
  return { shouldPrompt, missingPair, missingPairs, deeplinkTo };
}
