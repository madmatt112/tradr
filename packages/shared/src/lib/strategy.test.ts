import { describe, expect, it } from 'vitest';

import { encodeOccCompact } from '../options';

import {
  computeMaxLoss,
  computeNetEntry,
  detectStrategyLabel,
  validateLegSet,
  type StrategyLeg,
} from './strategy';

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                   | Pre-condition                                   | Call (seam)                      | Observable result                        | Source of expected value |
 * |----------------------------------------------|--------------------------------------------------|-----------------------------------|--------------------------------------------|---------------------------|
 * | AC 2.1 BCS                                    | 2 calls, 1 expiry, long lower / short higher     | detectStrategyLabel(legs)         | 'BCS'                                     | requirements.md AC 2.1 table |
 * | AC 2.1 BeCS                                   | 2 calls, 1 expiry, short lower / long higher     | detectStrategyLabel(legs)         | 'BeCS'                                    | requirements.md AC 2.1 table |
 * | AC 2.1 BPS                                    | 2 puts, 1 expiry, short higher / long lower      | detectStrategyLabel(legs)         | 'BPS'                                     | requirements.md AC 2.1 table |
 * | AC 2.1 BePS                                   | 2 puts, 1 expiry, long higher / short lower      | detectStrategyLabel(legs)         | 'BePS'                                    | requirements.md AC 2.1 table |
 * | AC 2.1 Calendar                               | same right/strike, 2 expiries, opposite sides    | detectStrategyLabel(legs)         | 'Calendar'                                | requirements.md AC 2.1 table |
 * | AC 2.1 Straddle                               | call+put, same side/expiry/strike                | detectStrategyLabel(legs)         | 'Straddle'                                | requirements.md AC 2.1 table |
 * | AC 2.1 Strangle                               | call+put, same side/expiry, put strike < call    | detectStrategyLabel(legs)         | 'Strangle'                                | requirements.md AC 2.1 table |
 * | AC 2.1 Iron condor                            | 4 legs, 1 expiry, ascending LP/SP/SC/LC strikes  | detectStrategyLabel(legs)         | 'Iron condor'                             | requirements.md AC 2.1 table |
 * | AC 2.1 near-miss: unequal entry qty           | otherwise a BCS shape, qty 1 vs 2                | detectStrategyLabel(legs)         | 'Multi-leg'                               | design.md C2 post-conditions |
 * | AC 2.1 near-miss: stock leg                   | one leg is a stock leg                           | detectStrategyLabel(legs)         | 'Multi-leg'                               | design.md C2 post-conditions |
 * | AC 2.1 near-miss: mixed underlyings           | otherwise a BCS shape, 2 underlyings             | detectStrategyLabel(legs)         | 'Multi-leg'                               | design.md C2 post-conditions |
 * | AC 2.1 near-miss: unparsable contract         | one leg's symbol fails parseOccSymbol            | detectStrategyLabel(legs)         | 'Multi-leg'                               | design.md C2 post-conditions |
 * | AC 2.1 near-miss: put strike above call       | same-side call+put, put strike > call strike     | detectStrategyLabel(legs)         | 'Multi-leg'                               | design.md C2 post-conditions |
 * | AC 2.1 near-miss: condor equal strikes        | iron-condor shape, two strikes equal             | detectStrategyLabel(legs)         | 'Multi-leg'                               | design.md C2 post-conditions |
 * | AC 2.2 partial exit                           | BCS legs, one leg partially exited               | detectStrategyLabel(legs)         | unchanged 'BCS'                           | requirements.md AC 2.2 |
 * | validateLegSet: bad OCC symbol                | leg 1's symbol fails parseOccSymbol              | validateLegSet(legs)              | { index: 1, message: string }             | design.md C2 post-conditions |
 * | validateLegSet: repeated symbol               | leg 0 and leg 1 share a symbol                   | validateLegSet(legs)              | { index: 1, message: string }             | design.md C2 post-conditions |
 * | validateLegSet: differing underlying          | leg 1's underlying differs from leg 0's          | validateLegSet(legs)              | { index: 1, message: string }             | design.md C2 post-conditions |
 * | validateLegSet: valid set                     | 2 legs, same underlying, unique valid symbols    | validateLegSet(legs)              | null                                      | design.md C2 post-conditions |
 * | AC 3.6 case 1 net entry                       | long 100C@5.00 / short 110C@2.00, 1 each         | computeNetEntry(legs, 2)          | 300                                       | requirements.md AC 3.6 |
 * | AC 3.6 case 1 max loss                        | same legs, 1.30 entry fees                       | computeMaxLoss(legs, 2)           | { maxLoss: 301.3, maxLossReason: null }   | requirements.md AC 3.6 |
 * | AC 3.6 case 2 net entry                       | short 100P@3.00 / long 95P@1.00, 1 each, no fees | computeNetEntry(legs, 2)          | -200                                      | requirements.md AC 3.6 |
 * | AC 3.6 case 2 max loss                        | same legs                                        | computeMaxLoss(legs, 2)           | { maxLoss: 300, maxLossReason: null }     | requirements.md AC 3.6 |
 * | AC 3.6 case 3 max loss                        | 100 long shares@50.00 / short 55C@2.00           | computeMaxLoss(legs, 2)           | { maxLoss: 4800, maxLossReason: null }    | requirements.md AC 3.6 |
 * | AC 3.6 case 4 max loss                        | short strangle (naked short call, no stock)      | computeMaxLoss(legs, 2)           | { maxLoss: null, maxLossReason: 'unbounded' } | requirements.md AC 3.6 |
 * | AC 3.5 multiple_expiries                      | open legs span 2 expiries (the Calendar fixture) | computeMaxLoss(legs, 2)           | { maxLoss: null, maxLossReason: 'multiple_expiries' } | requirements.md AC 3.5 |
 * | AC 3.5 nothing_open                           | every leg fully exited (entryQty === exitQty)    | computeMaxLoss(legs, 2)           | { maxLoss: null, maxLossReason: 'nothing_open' } | requirements.md AC 3.5 |
 * | AC 3.4 / D8 zero floor                        | lowest worked P&L is positive (guaranteed credit)| computeMaxLoss(legs, 2)           | { maxLoss: 0, maxLossReason: null }       | requirements.md AC 3.4, design.md D8 |
 * | NFR Reliability: purity                       | same legs content, two independent calls         | computeMaxLoss(legsA); computeMaxLoss(legsB) | identical results            | requirements.md NFR Reliability |
 */

const UNDERLYING = 'XYZ';
const OTHER_UNDERLYING = 'ABC';
const EXPIRY_1 = '2026-06-19';
const EXPIRY_2 = '2026-09-18';

function occSymbol(
  underlying: string,
  expiration: string,
  type: 'call' | 'put',
  strike: string,
): string {
  const result = encodeOccCompact({ underlying, expiration, type, strike });
  if (!result.ok) {
    throw new Error(`fixture OCC symbol invalid: ${result.error.message}`);
  }
  return result.value;
}

function optionLeg(overrides: Partial<StrategyLeg> = {}): StrategyLeg {
  return {
    symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
    side: 'long',
    assetType: 'option',
    entryQty: '1',
    exitQty: '0',
    entryCost: '0',
    entryFees: '0',
    ...overrides,
  };
}

describe('detectStrategyLabel', () => {
  it('labels two calls, long the lower strike and short the higher, as BCS', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'), side: 'short' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('BCS');
  });

  it('labels two calls, short the lower strike and long the higher, as BeCS', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'short' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('BeCS');
  });

  it('labels two puts, short the higher strike and long the lower, as BPS', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '100'), side: 'short' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '95'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('BPS');
  });

  it('labels two puts, long the higher strike and short the lower, as BePS', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '100'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '95'), side: 'short' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('BePS');
  });

  it('labels the same right and strike at two expiries, opposite sides, as Calendar', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_2, 'call', '100'), side: 'short' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Calendar');
  });

  it('labels a call and put, same side, expiry and strike, as Straddle', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '100'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Straddle');
  });

  it('labels a call and put, same side and expiry, put strike below call strike, as Strangle', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '100'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Strangle');
  });

  it('labels four legs, one expiry, strictly ascending long put/short put/short call/long call, as Iron condor', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '90'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '95'), side: 'short' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '105'), side: 'short' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Iron condor');
  });

  it('falls back to Multi-leg when entry quantities are unequal', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '2',
      }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Multi-leg');
  });

  it('falls back to Multi-leg when one leg is a stock leg', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: UNDERLYING, assetType: 'stock', side: 'long', entryQty: '1' }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        assetType: 'option',
        side: 'short',
        entryQty: '1',
      }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Multi-leg');
  });

  it('falls back to Multi-leg when the legs span mixed underlyings', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'long' }),
      optionLeg({ symbol: occSymbol(OTHER_UNDERLYING, EXPIRY_1, 'call', '110'), side: 'short' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Multi-leg');
  });

  it('falls back to Multi-leg when a leg carries an unparsable contract', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'long' }),
      optionLeg({ symbol: 'NOT-AN-OCC-SYMBOL', assetType: 'option', side: 'short' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Multi-leg');
  });

  it('falls back to Multi-leg for a same-side call and put with the put strike above the call strike', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '110'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Multi-leg');
  });

  it('falls back to Multi-leg for an iron-condor shape with two equal strikes', () => {
    const legs: StrategyLeg[] = [
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '90'), side: 'long' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '95'), side: 'short' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '95'), side: 'short' }),
      optionLeg({ symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'), side: 'long' }),
    ];
    expect(detectStrategyLabel(legs)).toBe('Multi-leg');
  });

  it('keeps the detected label unchanged across a partial exit', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '2',
        exitQty: '0',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '2',
        exitQty: '1',
      }),
    ];
    expect(detectStrategyLabel(legs)).toBe('BCS');
  });
});

describe('validateLegSet', () => {
  it('returns the leg index and a message when a symbol fails parseOccSymbol', () => {
    const legs = [
      { symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), assetType: 'option' as const },
      { symbol: 'NOT-AN-OCC-SYMBOL', assetType: 'option' as const },
    ];
    const result = validateLegSet(legs);
    expect(result?.index).toBe(1);
    expect(typeof result?.message).toBe('string');
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it('returns the leg index and a message when two legs repeat a symbol', () => {
    const symbol = occSymbol(UNDERLYING, EXPIRY_1, 'call', '100');
    const legs = [
      { symbol, assetType: 'option' as const },
      { symbol, assetType: 'option' as const },
    ];
    const result = validateLegSet(legs);
    expect(result?.index).toBe(1);
    expect(typeof result?.message).toBe('string');
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it('returns the leg index and a message when a leg underlying differs from leg 0', () => {
    const legs = [
      { symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), assetType: 'option' as const },
      {
        symbol: occSymbol(OTHER_UNDERLYING, EXPIRY_1, 'call', '110'),
        assetType: 'option' as const,
      },
    ];
    const result = validateLegSet(legs);
    expect(result?.index).toBe(1);
    expect(typeof result?.message).toBe('string');
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it('returns null for a valid leg set', () => {
    const legs = [
      { symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'), assetType: 'option' as const },
      { symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'), assetType: 'option' as const },
    ];
    expect(validateLegSet(legs)).toBeNull();
  });
});

describe('computeNetEntry', () => {
  it('gives 300 for long 100 call at 5.00 and short 110 call at 2.00, one contract each', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
        entryCost: '5.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '1',
        entryCost: '2.00',
      }),
    ];
    expect(computeNetEntry(legs, 2)).toBe(300);
  });

  it('gives -200 for short 100 put at 3.00 and long 95 put at 1.00, one contract each, no fees', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '100'),
        side: 'short',
        entryQty: '1',
        entryCost: '3.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '95'),
        side: 'long',
        entryQty: '1',
        entryCost: '1.00',
      }),
    ];
    expect(computeNetEntry(legs, 2)).toBe(-200);
  });
});

describe('computeMaxLoss', () => {
  it('gives 301.30 for long 100 call at 5.00 and short 110 call at 2.00, 1.30 entry fees', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
        entryCost: '5.00',
        entryFees: '0',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '1',
        entryCost: '2.00',
        entryFees: '1.30',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({ maxLoss: 301.3, maxLossReason: null });
  });

  it('gives 300 for short 100 put at 3.00 and long 95 put at 1.00, no fees', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '100'),
        side: 'short',
        entryQty: '1',
        entryCost: '3.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '95'),
        side: 'long',
        entryQty: '1',
        entryCost: '1.00',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({ maxLoss: 300, maxLossReason: null });
  });

  it('gives 4800 for 100 long shares at 50.00 and one short 55 call at 2.00', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: UNDERLYING,
        assetType: 'stock',
        side: 'long',
        entryQty: '100',
        entryCost: '5000.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '55'),
        assetType: 'option',
        side: 'short',
        entryQty: '1',
        entryCost: '2.00',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({ maxLoss: 4800, maxLossReason: null });
  });

  it('gives unbounded for a short strangle', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '1',
        entryCost: '2.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'put', '90'),
        side: 'short',
        entryQty: '1',
        entryCost: '1.50',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({ maxLoss: null, maxLossReason: 'unbounded' });
  });

  it('gives multiple_expiries when open legs span two option expiries', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
        entryCost: '5.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_2, 'call', '100'),
        side: 'short',
        entryQty: '1',
        entryCost: '6.00',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({
      maxLoss: null,
      maxLossReason: 'multiple_expiries',
    });
  });

  it('gives nothing_open when every leg has no open units', () => {
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
        exitQty: '1',
        entryCost: '5.00',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '1',
        exitQty: '1',
        entryCost: '2.00',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({ maxLoss: null, maxLossReason: 'nothing_open' });
  });

  it('floors max loss at zero when the lowest worked P&L is positive', () => {
    // Long 100 call at 0.50, short 110 call at 4.00: a guaranteed-credit
    // spread whose P&L at 0, 100 and 110 is 350, 350 and 1350 — never negative.
    const legs: StrategyLeg[] = [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
        entryCost: '0.50',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '1',
        entryCost: '4.00',
      }),
    ];
    expect(computeMaxLoss(legs, 2)).toEqual({ maxLoss: 0, maxLossReason: null });
  });

  it('gives the same result for two separately-built but equal leg sets', () => {
    const build = (): StrategyLeg[] => [
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '100'),
        side: 'long',
        entryQty: '1',
        entryCost: '5.00',
        entryFees: '0',
      }),
      optionLeg({
        symbol: occSymbol(UNDERLYING, EXPIRY_1, 'call', '110'),
        side: 'short',
        entryQty: '1',
        entryCost: '2.00',
        entryFees: '1.30',
      }),
    ];
    expect(computeMaxLoss(build(), 2)).toEqual(computeMaxLoss(build(), 2));
  });
});
