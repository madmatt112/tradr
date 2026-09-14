// Exact summer over decimal strings for the calendar totals (Component 12, DD6).
// It scales each value to a `BigInt` at the largest fractional length present,
// sums, and re-inserts the point — no float intermediate (R1.5) and no
// `decimal.js` in the web bundle (DD6). Inputs are the `decimalString` values the
// performance schema guarantees: `-?\d+(\.\d+)?` (schemas/performance.ts:146-153).

/** Scale `value` to an integer `BigInt` with `scale` fractional digits. */
function scaleToBigInt(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const dot = abs.indexOf('.');
  const intPart = dot >= 0 ? abs.slice(0, dot) : abs;
  const fracPart = dot >= 0 ? abs.slice(dot + 1) : '';
  const digits = (intPart || '0') + fracPart.padEnd(scale, '0');
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

/** Re-insert the decimal point `scale` digits from the right of `total`. */
function formatScaled(total: bigint, scale: number): string {
  if (scale === 0) return total.toString();
  const negative = total < BigInt(0);
  const absStr = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const cut = absStr.length - scale;
  return `${negative ? '-' : ''}${absStr.slice(0, cut)}.${absStr.slice(cut)}`;
}

/**
 * Exact sum of decimal strings. Returns `'0'` for an empty list. The output
 * carries as many fractional digits as the widest input (so `['0.1', '0.2']`
 * is `'0.3'`, never `'0.30000000000000004'`).
 */
export function sumDecimalStrings(values: readonly string[]): string {
  if (values.length === 0) return '0';

  let scale = 0;
  for (const v of values) {
    const dot = v.indexOf('.');
    if (dot >= 0) {
      const frac = v.length - dot - 1;
      if (frac > scale) scale = frac;
    }
  }

  let total = BigInt(0);
  for (const v of values) total += scaleToBigInt(v, scale);

  return formatScaled(total, scale);
}
