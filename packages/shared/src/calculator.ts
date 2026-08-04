import Decimal from 'decimal.js';

import { calculateFees } from './fees';
import type { FillInput } from './fees';
import { DOLLAR_RISK_MAX } from './schemas/calculator';
import type { CalculatorInput, CalculatorOutput } from './schemas/calculator';

function to2dp(value: Decimal): string {
  return value.toFixed(2, Decimal.ROUND_HALF_UP);
}

function zeroOut(
  perUnitRiskStr: string,
  status: CalculatorOutput['sizingStatus'],
): CalculatorOutput {
  return {
    positionSize: 0,
    perUnitRisk: perUnitRiskStr,
    actualDollarRisk: '0.00',
    totalPositionValue: '0.00',
    sizingStatus: status,
  };
}

export function calculateTrade(input: CalculatorInput): CalculatorOutput {
  const entry = new Decimal(input.entryPrice);
  const stop = new Decimal(input.stopLoss);
  const isLong = input.direction === 'long';
  const multiplier = input.mode === 'options' ? new Decimal(100) : new Decimal(1);

  if (stop.eq(entry)) {
    throw new Error('Stop loss cannot equal entry price');
  }
  if (isLong && stop.gt(entry)) {
    throw new Error('Stop loss must be below entry for long positions');
  }
  if (!isLong && stop.lt(entry)) {
    throw new Error('Stop loss must be above entry for short positions');
  }

  const target = input.targetPrice ? new Decimal(input.targetPrice) : null;
  if (target) {
    if (target.eq(entry)) {
      throw new Error('Target cannot equal entry price');
    }
    if (isLong && target.lt(entry)) {
      throw new Error('Target must be above entry for long positions');
    }
    if (!isLong && target.gt(entry)) {
      throw new Error('Target must be below entry for short positions');
    }
  }

  const perUnitRisk = entry.minus(stop).abs();
  const perUnitRiskStr = to2dp(perUnitRisk);

  const isPercent = input.balance !== undefined && input.riskPercent !== undefined;

  let effectiveRisk: Decimal;
  let derivedDollarRisk: Decimal | null = null;
  let balanceDec: Decimal | null = null;

  if (isPercent) {
    balanceDec = new Decimal(input.balance!);
    // Non-positive balance funds nothing; no cap is computed.
    if (balanceDec.lte(0)) return zeroOut(perUnitRiskStr, 'nothing-to-size-against');

    // Full precision → sizing; displayed at 2dp.
    derivedDollarRisk = balanceDec.times(input.riskPercent!).div(100);

    // Derived risk beyond the ceiling — resolved BEFORE the cap.
    if (derivedDollarRisk.gt(DOLLAR_RISK_MAX)) {
      return {
        ...zeroOut(perUnitRiskStr, 'exceeds-maximum'),
        derivedDollarRisk: to2dp(derivedDollarRisk),
      };
    }

    effectiveRisk = derivedDollarRisk;
  } else {
    // Dollar basis — guaranteed present by the schema refine.
    effectiveRisk = new Decimal(input.dollarRisk!);
  }

  const riskDerivedSize = effectiveRisk.div(perUnitRisk.times(multiplier)).floor().toNumber();

  // Risk too small for one unit — plain zero output, NO discriminator. Takes
  // precedence over the buying-power cap.
  if (riskDerivedSize === 0) {
    const base = {
      positionSize: 0,
      perUnitRisk: perUnitRiskStr,
      actualDollarRisk: '0.00',
      totalPositionValue: '0.00',
    };
    return derivedDollarRisk ? { ...base, derivedDollarRisk: to2dp(derivedDollarRisk) } : base;
  }

  // The figure the cap is computed against:
  //
  //   explicit `buyingPower`  → use it, in EITHER risk basis
  //   percent basis, no field → `balance`, the original REQ-8 behaviour
  //   dollar basis, no field  → none; the size is uncapped, as it always was
  //
  // The cap used to be percent-only because a balance only existed there. It is
  // keyed on having a cap basis at all, not on the risk basis: "can I afford
  // this" is the same question however the risk was expressed, and a direct
  // dollar risk overshoots exactly as readily as a percentage one — $1,000 of
  // risk at a $2 stop is $25,000 of stock no matter which box it was typed in.
  //
  // The risk budget is untouched by all of this. `balance` answers "risk 1% of
  // my account" (equity); the cap answers "can I afford this" (liquid funds).
  let capBasis: Decimal | null = null;
  if (input.buyingPower !== undefined) {
    capBasis = new Decimal(input.buyingPower);
  } else if (isPercent) {
    capBasis = balanceDec!;
  }

  let finalSize = riskDerivedSize;
  let buyingPowerLimited = false;
  if (capBasis !== null) {
    // entry is a validated positive decimal and multiplier ∈ {1,100} ⇒
    // entry×multiplier > 0 ⇒ no divide-by-zero.
    const cap = capBasis.div(entry.times(multiplier)).floor().toNumber();

    // `<= 0`, not `=== 0`. The old strict check was safe only because the cap
    // basis was `balance`, already proven positive above. `buyingPower` carries
    // no such guarantee — a fully-deployed or margined account can present zero
    // or negative cash, and `floor(negative / positive)` is negative, which
    // would otherwise sail past the guard and cap the size to a negative number.
    if (cap <= 0) {
      const zero = zeroOut(perUnitRiskStr, 'buying-power-zero');
      // `derivedDollarRisk` is a percent-basis echo and has no dollar-basis
      // meaning. The conditional is load-bearing, not tidiness: `to2dp(null!)`
      // constructs `new Decimal(null)`, which throws — so a dollar-basis
      // position whose account cannot fund one unit would 500 instead of
      // returning this outcome.
      return derivedDollarRisk ? { ...zero, derivedDollarRisk: to2dp(derivedDollarRisk) } : zero;
    }
    if (cap < riskDerivedSize) {
      finalSize = cap;
      buyingPowerLimited = true;
    }
  }

  const positionSize = finalSize;
  const sizeDec = new Decimal(positionSize);
  const actualDollarRisk = perUnitRisk.times(sizeDec).times(multiplier);
  const totalPositionValue = entry.times(sizeDec).times(multiplier);

  const output: CalculatorOutput = {
    positionSize,
    perUnitRisk: perUnitRiskStr,
    actualDollarRisk: to2dp(actualDollarRisk),
    totalPositionValue: to2dp(totalPositionValue),
  };

  if (derivedDollarRisk) {
    output.derivedDollarRisk = to2dp(derivedDollarRisk);
  }
  if (buyingPowerLimited) {
    output.buyingPowerLimited = true;
  }

  let perUnitReward: Decimal | null = null;
  if (target) {
    perUnitReward = target.minus(entry).abs();
    output.perUnitReward = to2dp(perUnitReward);
    output.riskRewardRatio = to2dp(perUnitReward.div(perUnitRisk));
  }

  let totalFees: Decimal | null = null;

  if (input.feeSchedule) {
    const fillType: FillInput['type'] = input.mode === 'options' ? 'option' : 'stock';
    const entrySide: FillInput['side'] = isLong ? 'buy' : 'sell';
    const exitSide: FillInput['side'] = isLong ? 'sell' : 'buy';
    const quantityStr = sizeDec.toString();
    const fills: FillInput[] = [
      { quantity: quantityStr, price: entry.toString(), type: fillType, side: entrySide },
      { quantity: quantityStr, price: stop.toString(), type: fillType, side: exitSide },
    ];
    const { totalFees: totalFeesStr } = calculateFees(fills, input.feeSchedule);
    totalFees = new Decimal(totalFeesStr);
  } else if (input.manualFees !== undefined) {
    totalFees = new Decimal(input.manualFees);
  }

  if (totalFees) {
    const estimatedFees = totalFees;
    const feeToRiskPercent = estimatedFees.div(actualDollarRisk).times(100);
    const adjustedDollarRisk = actualDollarRisk.plus(estimatedFees);

    const perUnitBreakevenAdjustment = estimatedFees.div(sizeDec.times(multiplier));
    const breakeven = isLong
      ? entry.plus(perUnitBreakevenAdjustment)
      : entry.minus(perUnitBreakevenAdjustment);

    output.estimatedFees = to2dp(estimatedFees);
    output.feeToRiskPercent = to2dp(feeToRiskPercent);
    output.adjustedDollarRisk = to2dp(adjustedDollarRisk);
    output.breakeven = to2dp(breakeven);

    if (perUnitReward) {
      const grossReward = perUnitReward.times(sizeDec).times(multiplier);
      const adjustedReward = grossReward.minus(estimatedFees);
      const adjustedRR = adjustedReward.div(adjustedDollarRisk);
      output.adjustedRiskRewardRatio = to2dp(adjustedRR);
    }
  }

  return output;
}
