// Admin-feature display formatters.
//
// 1 credit = 1 micro-USD (wallet-billing design §Component 3). Credit sums
// arrive as micro-USD integer strings and are converted ONLY for display —
// never parsed to floats for arithmetic on amounts. The int Intl shape is the
// shared `@/lib/format` BigInt path (visual-design Task 4); micro-USD uses its
// own BigInt path so the full money magnitude never passes through a JS float.

export const MICRO_USD_PER_USD = 1_000_000;
const MICRO_USD_PER_CENT = 10_000n;

/**
 * Render a micro-USD integer string as USD currency. The full money magnitude
 * is carried as a `BigInt` and rounded to cents with exact integer arithmetic
 * (round half away from zero, matching `Intl`'s `halfExpand`), so no float ever
 * touches the amount — a >15-digit balance keeps full precision. We then borrow
 * the locale's currency shape (symbol, sign, grouping, decimal separator) from
 * `Intl.NumberFormat.formatToParts` on the integer dollars and substitute our
 * own cents digits.
 */
export function formatMicroUsd(microUsd: string): string {
  const negative = microUsd.startsWith('-');
  const magnitude = BigInt((negative ? microUsd.slice(1) : microUsd) || '0');

  // Round the micro-USD magnitude to whole cents (half away from zero). The
  // magnitude is non-negative, so adding half the divisor before integer
  // division gives round-half-up.
  const cents = (magnitude + MICRO_USD_PER_CENT / 2n) / MICRO_USD_PER_CENT;
  const dollars = cents / 100n;
  const centsDigits = (cents % 100n).toString().padStart(2, '0');

  // `Intl` gives us the locale-correct symbol/sign/grouping/decimal placement
  // for the dollar part; we swap in our string-computed cents. BigInt has no
  // negative zero, so a negative input that rounds to $0 loses its sign here —
  // we re-add it to match the prior float behaviour (e.g. `-1` → `-$0.00`).
  const parts = USD_FORMAT.formatToParts(negative ? -dollars : dollars);
  let out = '';
  let hasMinus = false;
  for (const part of parts) {
    if (part.type === 'minusSign') hasMinus = true;
    out += part.type === 'fraction' ? centsDigits : part.value;
  }
  return negative && !hasMinus ? `-${out}` : out;
}

const USD_FORMAT = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});

// Integer-string counts (token sums). BigInt keeps arbitrarily large values
// exact; Intl.NumberFormat accepts bigint directly.
export function formatIntString(value: string): string {
  return new Intl.NumberFormat().format(BigInt(value));
}
