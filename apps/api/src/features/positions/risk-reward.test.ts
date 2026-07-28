import { describe, it, expect } from 'vitest';

import { computeRiskReward } from './risk-reward';

// ---------------------------------------------------------------------------
// computeRiskReward (R14)
// ---------------------------------------------------------------------------

describe('computeRiskReward', () => {
  // 1. Long winner
  it('computes a long winner (positive actualRR)', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 110,
      side: 'long',
      targetPrice: 120,
      stopLoss: 90,
    });
    // riskPerUnit = |100 - 90| = 10
    // targetRR = |120 - 100| / 10 = 2
    // actualRR = (110 - 100) * 1 / 10 = 1
    expect(result).toEqual({ targetRR: 2, actualRR: 1 });
  });

  // 2. Long loser — negative actualRR
  it('computes a long loser (negative actualRR)', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 95,
      side: 'long',
      targetPrice: 120,
      stopLoss: 90,
    });
    // actualRR = (95 - 100) * 1 / 10 = -0.5
    expect(result).toEqual({ targetRR: 2, actualRR: -0.5 });
  });

  // 3. Short winner — price fell, positive actualRR
  it('computes a short winner (positive actualRR)', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 90,
      side: 'short',
      targetPrice: 80,
      stopLoss: 110,
    });
    // riskPerUnit = |100 - 110| = 10
    // targetRR = |80 - 100| / 10 = 2
    // actualRR = (90 - 100) * -1 / 10 = 1
    expect(result).toEqual({ targetRR: 2, actualRR: 1 });
  });

  // 4. Short loser — price rose, negative actualRR (sign check)
  it('computes a short loser (negative actualRR, sign check)', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 105,
      side: 'short',
      targetPrice: 80,
      stopLoss: 110,
    });
    // actualRR = (105 - 100) * -1 / 10 = -0.5
    expect(result).toEqual({ targetRR: 2, actualRR: -0.5 });
  });

  // 5. Missing targetPrice → targetRR null, actualRR present
  it('returns targetRR null when targetPrice is missing but keeps actualRR', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 110,
      side: 'long',
      targetPrice: null,
      stopLoss: 90,
    });
    expect(result).toEqual({ targetRR: null, actualRR: 1 });
  });

  // 6. Missing stopLoss → both null
  it('returns both null when stopLoss is missing', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 110,
      side: 'long',
      targetPrice: 120,
      stopLoss: null,
    });
    expect(result).toEqual({ targetRR: null, actualRR: null });
  });

  // 7. No exit (avgExitPrice null) → actualRR null, targetRR present
  it('returns actualRR null when there is no exit but keeps targetRR', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: null,
      side: 'long',
      targetPrice: 120,
      stopLoss: 90,
    });
    expect(result).toEqual({ targetRR: 2, actualRR: null });
  });

  // 7b. Draft (no entry fills yet) → avgEntryPrice null → both null
  it('returns both null on a pure draft (avgEntryPrice null)', () => {
    const result = computeRiskReward({
      avgEntryPrice: null,
      avgExitPrice: null,
      side: 'long',
      targetPrice: 120,
      stopLoss: 90,
    });
    expect(result).toEqual({ targetRR: null, actualRR: null });
  });

  // 8. riskPerUnit 0 (stop == entry) → both null, no throw
  it('returns both null when riskPerUnit is 0 (stop == entry), no throw', () => {
    let result: ReturnType<typeof computeRiskReward>;
    expect(() => {
      result = computeRiskReward({
        avgEntryPrice: 100,
        avgExitPrice: 110,
        side: 'long',
        targetPrice: 120,
        stopLoss: 100,
      });
    }).not.toThrow();
    expect(result!).toEqual({ targetRR: null, actualRR: null });
  });

  // 9. Rounding half-up to 2 dp
  it('rounds half-up to 2 decimal places', () => {
    const result = computeRiskReward({
      avgEntryPrice: 100,
      avgExitPrice: 301,
      side: 'long',
      targetPrice: 301,
      stopLoss: 300,
    });
    // riskPerUnit = |100 - 300| = 200
    // targetRR = |301 - 100| / 200 = 201/200 = 1.005 → half-up → 1.01
    // actualRR = (301 - 100) * 1 / 200 = 201/200 = 1.005 → half-up → 1.01
    expect(result).toEqual({ targetRR: 1.01, actualRR: 1.01 });
  });

  // 10. No throw where calculateTrade would throw — wrong-side stop (long, stop above entry)
  it('does not throw on a wrong-side stop (long stop above entry)', () => {
    let result: ReturnType<typeof computeRiskReward>;
    expect(() => {
      result = computeRiskReward({
        avgEntryPrice: 100,
        avgExitPrice: 110,
        side: 'long',
        targetPrice: 130,
        stopLoss: 120,
      });
    }).not.toThrow();
    // riskPerUnit = |100 - 120| = 20
    // targetRR = |130 - 100| / 20 = 1.5
    // actualRR = (110 - 100) * 1 / 20 = 0.5
    expect(result!).toEqual({ targetRR: 1.5, actualRR: 0.5 });
  });

  // 11. Accepts decimal-string inputs for targetPrice/stopLoss (Drizzle numeric columns)
  it('accepts decimal-string targetPrice/stopLoss without precision loss', () => {
    const result = computeRiskReward({
      avgEntryPrice: 0.3,
      avgExitPrice: 0.5,
      side: 'long',
      targetPrice: '0.5',
      stopLoss: '0.1',
    });
    // riskPerUnit = |0.3 - 0.1| = 0.2 (exact via Decimal)
    // targetRR = |0.5 - 0.3| / 0.2 = 1
    // actualRR = (0.5 - 0.3) * 1 / 0.2 = 1
    expect(result).toEqual({ targetRR: 1, actualRR: 1 });
  });
});
