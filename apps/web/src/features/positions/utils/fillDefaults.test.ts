import { describe, expect, it } from 'vitest';

import { QUANTITY_PRESETS, defaultFillPrice, presetQuantity } from './fillDefaults';

describe('presetQuantity', () => {
  it('returns the exact open size for All, without rounding', () => {
    expect(presetQuantity(100, 1, 'stock')).toBe('100');
    expect(presetQuantity(7, 1, 'option')).toBe('7');
  });

  it('rounds fractions DOWN so an exit can never exceed the open size', () => {
    // ⅓ of 100 is 33.33…; 33.34 would be a 400 from the server.
    expect(presetQuantity(100, 1 / 3, 'option')).toBe('33');
    expect(presetQuantity(10, 1 / 3, 'option')).toBe('3');
  });

  it('keeps option quantities whole', () => {
    expect(presetQuantity(7, 1 / 2, 'option')).toBe('3');
    expect(presetQuantity(7, 1 / 4, 'option')).toBe('1');
  });

  it('allows fractional stock quantities', () => {
    expect(presetQuantity(7, 1 / 2, 'stock')).toBe('3.5');
  });

  it('never exceeds the open size for any preset', () => {
    for (const openUnits of [1, 3, 7, 10, 100, 953]) {
      for (const preset of QUANTITY_PRESETS) {
        const qty = Number(presetQuantity(openUnits, preset.fraction, 'stock'));
        expect(qty).toBeLessThanOrEqual(openUnits);
      }
    }
  });

  it('degrades to 0 when nothing is open', () => {
    expect(presetQuantity(0, 1 / 2, 'stock')).toBe('0');
    expect(presetQuantity(-5, 1, 'stock')).toBe('0');
  });
});

describe('defaultFillPrice', () => {
  const plan = { avgEntryPrice: 150, stopLoss: 140, targetPrice: 195 };

  it('prefers the target on an exit', () => {
    expect(defaultFillPrice('exit', plan)).toBe('195');
  });

  it('prefers the average entry on an entry', () => {
    expect(defaultFillPrice('entry', plan)).toBe('150');
  });

  it('falls back through stop to entry on an exit', () => {
    expect(defaultFillPrice('exit', { ...plan, targetPrice: null })).toBe('140');
    expect(defaultFillPrice('exit', { ...plan, targetPrice: null, stopLoss: null })).toBe('150');
  });

  it('falls back through stop to target on an entry', () => {
    expect(defaultFillPrice('entry', { ...plan, avgEntryPrice: null })).toBe('140');
    expect(defaultFillPrice('entry', { ...plan, avgEntryPrice: null, stopLoss: null })).toBe('195');
  });

  it('returns empty rather than guessing when the position has no prices', () => {
    const empty = { avgEntryPrice: null, stopLoss: null, targetPrice: null };
    expect(defaultFillPrice('entry', empty)).toBe('');
    expect(defaultFillPrice('exit', empty)).toBe('');
  });

  it('ignores non-positive prices', () => {
    expect(defaultFillPrice('entry', { avgEntryPrice: 0, stopLoss: 140, targetPrice: 195 })).toBe(
      '140',
    );
  });
});
