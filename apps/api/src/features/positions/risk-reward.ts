import Decimal from 'decimal.js';

export interface RiskRewardInput {
  // avgEntryPrice / avgExitPrice come from PnlResult (number | null).
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  side: 'long' | 'short';
  // targetPrice / stopLoss arrive from Drizzle numeric columns as strings
  // (kept as strings until decimal.js, per the spec's numeric rule); numbers
  // are also accepted for convenience.
  targetPrice: string | number | null;
  stopLoss: string | number | null;
}

export interface RiskRewardResult {
  targetRR: number | null;
  actualRR: number | null;
}

/**
 * Compute planned and realized risk/reward ratios (R14).
 *
 * Unlike `calculateTrade` in `packages/shared/src/calculator.ts`, this never
 * throws — it returns `null` for the stop==entry and "wrong-side" stop cases
 * that occur legitimately in journaled positions, and it adds a signed
 * realized `actualRR`.
 *
 * - `riskPerUnit = |avgEntryPrice − stopLoss|`
 * - `targetRR = |targetPrice − avgEntryPrice| / riskPerUnit` — non-negative
 *   magnitude; null if avgEntryPrice/targetPrice/stopLoss is null or
 *   riskPerUnit is 0.
 * - `actualRR = ((avgExitPrice − avgEntryPrice) × sideMultiplier) / riskPerUnit`
 *   — signed (negative when the realized move went against the position); null
 *   if avgEntryPrice/avgExitPrice/stopLoss is null or riskPerUnit is 0.
 *
 * Both are rounded half-up to 2 decimal places. The contract multiplier
 * (×100 for options) cancels in a ratio, so no assetType is needed.
 */
export function computeRiskReward({
  avgEntryPrice,
  avgExitPrice,
  side,
  targetPrice,
  stopLoss,
}: RiskRewardInput): RiskRewardResult {
  // Both ratios are anchored to the realized avgEntryPrice and divided by the
  // risk-per-unit, so without an entry price or a stop neither can be computed.
  if (avgEntryPrice == null || stopLoss == null) {
    return { targetRR: null, actualRR: null };
  }

  const entry = new Decimal(avgEntryPrice);
  const riskPerUnit = entry.minus(new Decimal(stopLoss)).abs();

  // Zero-risk denominator (stop == entry) — no divide-by-zero; both null.
  if (riskPerUnit.isZero()) {
    return { targetRR: null, actualRR: null };
  }

  const targetRR =
    targetPrice == null
      ? null
      : new Decimal(targetPrice)
          .minus(entry)
          .abs()
          .div(riskPerUnit)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toNumber();

  const sideMultiplier = side === 'long' ? 1 : -1;
  const actualRR =
    avgExitPrice == null
      ? null
      : new Decimal(avgExitPrice)
          .minus(entry)
          .times(sideMultiplier)
          .div(riskPerUnit)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toNumber();

  return { targetRR, actualRR };
}
