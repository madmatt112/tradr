import { describe, expect, it } from 'vitest';

import { calculateTrade } from './calculator';
import type { FeeScheduleInput } from './fees';
import { DOLLAR_RISK_MAX, PRICE_MAX } from './schemas/calculator';
import type { CalculatorInput } from './schemas/calculator';

const zeroFeeSchedule: FeeScheduleInput = {
  stockPerShareCommission: '0.005',
  stockMinPerFill: '0',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0.65',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

function baseInput(overrides: Partial<CalculatorInput> = {}): CalculatorInput {
  return {
    entryPrice: '50',
    stopLoss: '48',
    dollarRisk: '1000',
    direction: 'long',
    mode: 'stock',
    ...overrides,
  };
}

function percentInput(overrides: Partial<CalculatorInput> = {}): CalculatorInput {
  return {
    entryPrice: '50',
    stopLoss: '48',
    balance: '50000',
    riskPercent: '2',
    direction: 'long',
    mode: 'stock',
    ...overrides,
  };
}

describe('calculateTrade', () => {
  it('computes long stock basic sizing', () => {
    const result = calculateTrade(baseInput());
    expect(result.positionSize).toBe(500);
    expect(result.perUnitRisk).toBe('2.00');
    expect(result.actualDollarRisk).toBe('1000.00');
    expect(result.totalPositionValue).toBe('25000.00');
  });

  it('computes short stock basic sizing with risk = stop - entry', () => {
    const result = calculateTrade(baseInput({ direction: 'short', stopLoss: '52' }));
    expect(result.positionSize).toBe(500);
    expect(result.perUnitRisk).toBe('2.00');
    expect(result.actualDollarRisk).toBe('1000.00');
    expect(result.totalPositionValue).toBe('25000.00');
  });

  it('applies 100x multiplier in options mode', () => {
    const result = calculateTrade(baseInput({ mode: 'options' }));
    expect(result.positionSize).toBe(5);
    expect(result.actualDollarRisk).toBe('1000.00');
    expect(result.totalPositionValue).toBe('25000.00');
  });

  it('rounds fractional position size down', () => {
    const result = calculateTrade(baseInput({ dollarRisk: '21.8' }));
    // 21.8 / 2 = 10.9 → floor 10
    expect(result.positionSize).toBe(10);
    expect(result.actualDollarRisk).toBe('20.00');
  });

  it('throws exact message when stop equals entry', () => {
    expect(() => calculateTrade(baseInput({ stopLoss: '50' }))).toThrow(
      'Stop loss cannot equal entry price',
    );
  });

  it('throws when long stop is above entry', () => {
    expect(() => calculateTrade(baseInput({ stopLoss: '52' }))).toThrow(
      'Stop loss must be below entry for long positions',
    );
  });

  it('throws when short stop is below entry', () => {
    expect(() => calculateTrade(baseInput({ direction: 'short', stopLoss: '48' }))).toThrow(
      'Stop loss must be above entry for short positions',
    );
  });

  it('throws when target equals entry', () => {
    expect(() => calculateTrade(baseInput({ targetPrice: '50' }))).toThrow(
      'Target cannot equal entry price',
    );
  });

  it('throws when long target is below entry', () => {
    expect(() => calculateTrade(baseInput({ targetPrice: '45' }))).toThrow(
      'Target must be above entry for long positions',
    );
  });

  it('throws when short target is above entry', () => {
    expect(() =>
      calculateTrade(baseInput({ direction: 'short', stopLoss: '52', targetPrice: '55' })),
    ).toThrow('Target must be below entry for short positions');
  });

  it('populates perUnitReward and riskRewardRatio when target provided', () => {
    const result = calculateTrade(baseInput({ targetPrice: '55' }));
    // perUnitReward = 5, perUnitRisk = 2 → ratio 2.50
    expect(result.perUnitReward).toBe('5.00');
    expect(result.riskRewardRatio).toBe('2.50');
  });

  it('omits perUnitReward and riskRewardRatio when target absent', () => {
    const result = calculateTrade(baseInput());
    expect(result.perUnitReward).toBeUndefined();
    expect(result.riskRewardRatio).toBeUndefined();
  });

  it('short-circuits to zero position size and omits all optional fields', () => {
    const result = calculateTrade(
      baseInput({
        dollarRisk: '1',
        targetPrice: '55',
        manualFees: '5',
      }),
    );
    expect(result.positionSize).toBe(0);
    expect(result.perUnitRisk).toBe('2.00');
    expect(result.actualDollarRisk).toBe('0.00');
    expect(result.totalPositionValue).toBe('0.00');
    expect(result.perUnitReward).toBeUndefined();
    expect(result.riskRewardRatio).toBeUndefined();
    expect(result.estimatedFees).toBeUndefined();
    expect(result.feeToRiskPercent).toBeUndefined();
    expect(result.adjustedDollarRisk).toBeUndefined();
    expect(result.breakeven).toBeUndefined();
    expect(result.adjustedRiskRewardRatio).toBeUndefined();
  });

  it('integrates brokerage fees for long stock with buy→sell fills', () => {
    const result = calculateTrade(baseInput({ feeSchedule: zeroFeeSchedule }));
    // 500 shares * 0.005 per share = 2.50 per fill × 2 fills = 5.00
    expect(result.estimatedFees).toBe('5.00');
  });

  it('integrates brokerage fees for short stock with sell→buy fills', () => {
    const result = calculateTrade(
      baseInput({
        direction: 'short',
        stopLoss: '52',
        feeSchedule: zeroFeeSchedule,
      }),
    );
    expect(result.estimatedFees).toBe('5.00');
    expect(result.actualDollarRisk).toBe('1000.00');
  });

  it('integrates brokerage fees for long options with option fills', () => {
    const result = calculateTrade(baseInput({ mode: 'options', feeSchedule: zeroFeeSchedule }));
    // 5 contracts * 0.65 = 3.25 per fill × 2 = 6.50
    expect(result.estimatedFees).toBe('6.50');
  });

  it('integrates brokerage fees for short options', () => {
    const result = calculateTrade(
      baseInput({
        direction: 'short',
        mode: 'options',
        stopLoss: '52',
        feeSchedule: zeroFeeSchedule,
      }),
    );
    expect(result.estimatedFees).toBe('6.50');
  });

  it('flows manual fees through as flat dollar amount', () => {
    const result = calculateTrade(baseInput({ manualFees: '7.50' }));
    expect(result.estimatedFees).toBe('7.50');
    expect(result.feeToRiskPercent).toBe('0.75'); // 7.5 / 1000 * 100
    expect(result.adjustedDollarRisk).toBe('1007.50');
  });

  it('computes fees without target (matrix case 3)', () => {
    const result = calculateTrade(baseInput({ manualFees: '10' }));
    expect(result.estimatedFees).toBe('10.00');
    expect(result.feeToRiskPercent).toBe('1.00');
    expect(result.adjustedDollarRisk).toBe('1010.00');
    expect(result.breakeven).toBe('50.02');
    expect(result.adjustedRiskRewardRatio).toBeUndefined();
  });

  it('computes breakeven for long stock as entry + fees/size', () => {
    // 500 shares, fees 10 → 10 / 500 = 0.02 → 50 + 0.02 = 50.02
    const result = calculateTrade(baseInput({ manualFees: '10' }));
    expect(result.breakeven).toBe('50.02');
  });

  it('computes breakeven for short stock as entry - fees/size', () => {
    const result = calculateTrade(
      baseInput({ direction: 'short', stopLoss: '52', manualFees: '10' }),
    );
    expect(result.breakeven).toBe('49.98');
  });

  it('computes breakeven for long options with ×100 divisor', () => {
    // 5 contracts → 10 / (5 × 100) = 0.02 → 50 + 0.02 = 50.02
    const result = calculateTrade(baseInput({ mode: 'options', manualFees: '10' }));
    expect(result.breakeven).toBe('50.02');
  });

  it('computes breakeven for short options with ×100 divisor', () => {
    const result = calculateTrade(
      baseInput({
        direction: 'short',
        mode: 'options',
        stopLoss: '52',
        manualFees: '10',
      }),
    );
    expect(result.breakeven).toBe('49.98');
  });

  it('computes positive adjusted R:R', () => {
    // entry 50, stop 48, target 60, 500 shares, fees 20
    // grossReward = 10 * 500 = 5000, adjustedReward = 4980
    // adjustedDollarRisk = 1020, adjustedRR = 4980/1020 = 4.882...
    const result = calculateTrade(baseInput({ targetPrice: '60', manualFees: '20' }));
    expect(result.adjustedRiskRewardRatio).toBe('4.88');
  });

  it('produces golden-path adjusted R:R of "2.47"', () => {
    // entry 50, stop 48, target 55, risk 1000, manualFees 10
    // perUnitRisk=2, perUnitReward=5, positionSize=500
    // grossReward=2500, adjustedReward=2490, adjustedDollarRisk=1010
    // adjustedRR = 2490/1010 = 2.4653... → "2.47"
    const result = calculateTrade(baseInput({ targetPrice: '55', manualFees: '10' }));
    expect(result.adjustedRiskRewardRatio).toBe('2.47');
  });

  it('computes negative adjusted R:R when fees exceed gross reward', () => {
    // entry 50, stop 49, target 51, 500 shares, fees 1000
    // perUnitRisk=1, perUnitReward=1, grossReward=500, adjustedReward=-500
    // adjustedDollarRisk=1500, adjustedRR = -0.333...
    const result = calculateTrade(
      baseInput({
        stopLoss: '49',
        targetPrice: '51',
        dollarRisk: '500',
        manualFees: '1000',
      }),
    );
    expect(result.adjustedRiskRewardRatio).toBe('-0.33');
  });

  it('produces stable 2dp rounding for natural trailing decimals', () => {
    // entry 100, stop 97.333, risk 1000, long
    // perUnitRisk = 2.667 → "2.67" at 2dp (half up)
    const result = calculateTrade(baseInput({ entryPrice: '100', stopLoss: '97.333' }));
    expect(result.perUnitRisk).toBe('2.67');
  });

  it('handles minimum 1-unit position', () => {
    const result = calculateTrade(baseInput({ dollarRisk: '2' }));
    expect(result.positionSize).toBe(1);
    expect(result.actualDollarRisk).toBe('2.00');
  });

  it('handles at-limit price and dollar-risk bounds without overflow', () => {
    const result = calculateTrade(
      baseInput({
        entryPrice: String(PRICE_MAX),
        stopLoss: String(PRICE_MAX - 1),
        dollarRisk: String(DOLLAR_RISK_MAX),
      }),
    );
    expect(result.positionSize).toBeGreaterThan(0);
    expect(typeof result.totalPositionValue).toBe('string');
    expect(typeof result.actualDollarRisk).toBe('string');
  });

  it('omits all percent-only fields in dollar mode', () => {
    const result = calculateTrade(baseInput({ targetPrice: '55', manualFees: '10' }));
    expect(result.derivedDollarRisk).toBeUndefined();
    expect(result.sizingStatus).toBeUndefined();
    expect(result.buyingPowerLimited).toBeUndefined();
  });
});

describe('calculateTrade — percent/dollar parity', () => {
  const combos = [
    { name: 'long stock', direction: 'long', stopLoss: '48', mode: 'stock', targetPrice: '55' },
    { name: 'short stock', direction: 'short', stopLoss: '52', mode: 'stock', targetPrice: '45' },
    { name: 'long options', direction: 'long', stopLoss: '48', mode: 'options', targetPrice: '55' },
    {
      name: 'short options',
      direction: 'short',
      stopLoss: '52',
      mode: 'options',
      targetPrice: '45',
    },
  ] as const;

  // Every field except the percent-only derivedDollarRisk must match the
  // equivalent dollar-risk calculation exactly.
  const sizingKeys = [
    'positionSize',
    'perUnitRisk',
    'actualDollarRisk',
    'totalPositionValue',
    'perUnitReward',
    'riskRewardRatio',
    'estimatedFees',
    'feeToRiskPercent',
    'adjustedDollarRisk',
    'breakeven',
    'adjustedRiskRewardRatio',
  ] as const;

  for (const c of combos) {
    it(`percent (2% of 50000 = $1000) matches dollar sizing for ${c.name}`, () => {
      // balance 50000 × 2% = 1000 = the direct dollar risk; buying power is ample
      // so the cap stays idle and the sizing fields coincide.
      const dollar = calculateTrade({
        entryPrice: '50',
        stopLoss: c.stopLoss,
        direction: c.direction,
        mode: c.mode,
        targetPrice: c.targetPrice,
        manualFees: '10',
        dollarRisk: '1000',
      });
      const percent = calculateTrade({
        entryPrice: '50',
        stopLoss: c.stopLoss,
        direction: c.direction,
        mode: c.mode,
        targetPrice: c.targetPrice,
        manualFees: '10',
        balance: '50000',
        riskPercent: '2',
      });
      for (const key of sizingKeys) {
        expect(percent[key]).toEqual(dollar[key]);
      }
      expect(percent.derivedDollarRisk).toBe('1000.00');
      expect(dollar.derivedDollarRisk).toBeUndefined();
    });
  }
});

describe('calculateTrade — percent basis outcomes', () => {
  it('sizes on the full-precision derived risk while displaying it at 2dp', () => {
    // derived = 33333.33 × 3 / 100 = 999.9999 (full precision)
    // riskDerivedSize = floor(999.9999 / 2) = 499 — re-rounding to 1000 first would give 500
    const result = calculateTrade(percentInput({ balance: '33333.33', riskPercent: '3' }));
    expect(result.positionSize).toBe(499);
    expect(result.derivedDollarRisk).toBe('1000.00');
  });

  it.each(['0', '-500'])('returns nothing-to-size-against for balance %s', (balance) => {
    const result = calculateTrade(percentInput({ balance }));
    expect(result.positionSize).toBe(0);
    expect(result.sizingStatus).toBe('nothing-to-size-against');
    expect(result.derivedDollarRisk).toBeUndefined();
    expect(result.actualDollarRisk).toBe('0.00');
  });

  it('returns exceeds-maximum when the derived risk passes DOLLAR_RISK_MAX', () => {
    // derived = 250000000 > DOLLAR_RISK_MAX (99999999.99), resolved before the cap
    const result = calculateTrade(percentInput({ balance: '250000000', riskPercent: '100' }));
    expect(result.positionSize).toBe(0);
    expect(result.sizingStatus).toBe('exceeds-maximum');
    expect(result.derivedDollarRisk).toBe('250000000.00');
    expect(DOLLAR_RISK_MAX).toBe(99999999.99);
  });

  it('returns a plain zero (no status) when derived risk cannot fund one unit', () => {
    // derived = 50 × 2 / 100 = 1.00; riskDerivedSize = floor(1 / 2) = 0 → insufficient, before the cap
    const result = calculateTrade(percentInput({ balance: '50', riskPercent: '2' }));
    expect(result.positionSize).toBe(0);
    expect(result.sizingStatus).toBeUndefined();
    expect(result.derivedDollarRisk).toBe('1.00');
    expect(result.actualDollarRisk).toBe('0.00');
  });

  it('caps the size at buying power and flags buyingPowerLimited', () => {
    // derived = 5000 → riskDerivedSize = floor(5000 / 1) = 5000; cap = floor(10000 / 100) = 100
    const result = calculateTrade(
      percentInput({ entryPrice: '100', stopLoss: '99', balance: '10000', riskPercent: '50' }),
    );
    expect(result.positionSize).toBe(100);
    expect(result.buyingPowerLimited).toBe(true);
    expect(result.derivedDollarRisk).toBe('5000.00');
    // capped actual risk is far below the derived target
    expect(result.actualDollarRisk).toBe('100.00');
  });

  it('leaves the size uncapped and unflagged when buying power is ample', () => {
    // riskDerivedSize = 500; cap = floor(50000 / 50) = 1000 ≥ 500 → idle
    const result = calculateTrade(percentInput({ balance: '50000', riskPercent: '2' }));
    expect(result.positionSize).toBe(500);
    expect(result.buyingPowerLimited).toBeUndefined();
    expect(result.derivedDollarRisk).toBe('1000.00');
  });

  it('returns buying-power-zero when the balance cannot fund one unit', () => {
    // derived = 50 → riskDerivedSize = floor(50 / 1) = 50 (≥ 1); cap = floor(50 / 100) = 0
    const result = calculateTrade(
      percentInput({ entryPrice: '100', stopLoss: '99', balance: '50', riskPercent: '100' }),
    );
    expect(result.positionSize).toBe(0);
    expect(result.sizingStatus).toBe('buying-power-zero');
    expect(result.derivedDollarRisk).toBe('50.00');
  });

  it('prefers insufficient-risk over buying-power-zero (no discriminator)', () => {
    // derived = 0.50 → riskDerivedSize = floor(0.5 / 1) = 0 (insufficient) AND cap = floor(50 / 100) = 0
    const result = calculateTrade(
      percentInput({ entryPrice: '100', stopLoss: '99', balance: '50', riskPercent: '1' }),
    );
    expect(result.positionSize).toBe(0);
    expect(result.sizingStatus).toBeUndefined();
    expect(result.derivedDollarRisk).toBe('0.50');
  });

  it('applies the options multiplier in both the cap and the sizing', () => {
    // entry 50 / stop 48 → perUnitRisk 2, multiplier 100
    // derived = 15000 → riskDerivedSize = floor(15000 / (2 × 100)) = 75
    // cap = floor(30000 / (50 × 100)) = 6 — without the ×100 the cap would be 600 and stay idle
    const result = calculateTrade(
      percentInput({ mode: 'options', balance: '30000', riskPercent: '50' }),
    );
    expect(result.positionSize).toBe(6);
    expect(result.buyingPowerLimited).toBe(true);
    expect(result.actualDollarRisk).toBe('1200.00'); // 2 × 6 × 100
    expect(result.totalPositionValue).toBe('30000.00'); // 50 × 6 × 100
  });
});
