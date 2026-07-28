import { parseOccSymbol } from '@tradr/shared';

export interface OptionContract {
  underlying: string;
  /** Full expiry, e.g. "21 Mar 2026". */
  expiryLabel: string;
  /** Strike with currency sign, e.g. "$120" (trailing zeros trimmed). */
  strikeLabel: string;
  /** "Call" | "Put". */
  typeLabel: string;
  /** Compact one-liner for dense rows, e.g. "21 Mar 26 · $120C". */
  compactLabel: string;
}

/**
 * Decode a v1 compact OCC option symbol (e.g. "NVDA260321C120") into friendly
 * display parts via the shared OCC parser. Returns null when the symbol is not a
 * parseable OCC symbol (legacy / free-text option rows), so callers fall back to
 * the raw symbol string. Pure; no side effects.
 */
export function decodeOptionContract(symbol: string): OptionContract | null {
  const parsed = parseOccSymbol(symbol);
  if (!parsed.ok) return null;

  const { underlying, expiration, type, strike } = parsed.value;
  // parseOccSymbol returns expiration as a UTC calendar date (YYYY-MM-DD); pin
  // the timezone so the displayed day can't drift across the local boundary.
  const date = new Date(`${expiration}T00:00:00Z`);
  const strikeLabel = `$${Number(strike)}`;
  const typeLabel = type === 'call' ? 'Call' : 'Put';
  // en-GB for unambiguous day-month-year order, e.g. "21 Mar 2026".
  const expiryLabel = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const compactExpiry = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
  const compactLabel = `${compactExpiry} · ${strikeLabel}${type === 'call' ? 'C' : 'P'}`;

  return { underlying, expiryLabel, strikeLabel, typeLabel, compactLabel };
}
