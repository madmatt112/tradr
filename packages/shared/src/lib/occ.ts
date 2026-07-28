import { parseOccSymbol } from '../options';

/**
 * Extract the underlying ticker from a v1 compact option-symbol string.
 *
 * Delegates to `parseOccSymbol` (the strict OCC parser) first. When the strict
 * parse succeeds, returns the canonical `underlying` field. Otherwise falls
 * back to the legacy leading-alpha regex against `symbol.trim().toUpperCase()`.
 *
 * Tradr v1 stores option symbols in compact display form only — see design
 * Component 2 (spec: expenses-tax) for the storage rationale.
 *
 * Returns:
 * - the uppercased underlying ticker on success
 * - null when the input does not start with an alpha character or is empty
 *
 * Pure function; no side effects.
 */
export function parseOccUnderlying(symbol: string): string | null {
  if (!symbol || typeof symbol !== 'string') return null;

  const parsed = parseOccSymbol(symbol);
  if (parsed.ok === true) {
    return parsed.value.underlying;
  }

  const trimmed = symbol.trim().toUpperCase();
  if (trimmed.length === 0) return null;

  // Compact / display form: leading alpha run is the underlying. The trailing
  // class deliberately EXCLUDES digits so the match stops at the digit boundary
  // in compact-no-space inputs like 'AAPL250320C150' (post-v2-fix #1 — the
  // earlier `[A-Z0-9.]` class greedy-captured digits and would have returned
  // 'AAPL25'). Dots are kept for share-class tickers like 'BRK.B'.
  const match = trimmed.match(/^([A-Z][A-Z.]{0,5})/);
  if (!match) return null;
  return match[1];
}
