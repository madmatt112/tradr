import { describe, expect, it } from 'vitest';

import { decodeContract, encodeContract, occErrorField } from './occForm';

describe('encodeContract', () => {
  it('upper-cases the underlying and returns the compact symbol for a valid contract', () => {
    const r = encodeContract({
      underlying: 'nvda',
      expiry: '2026-03-21',
      type: 'call',
      strike: ' 120 ',
    });
    expect(r).toEqual({ ok: true, value: 'NVDA260321C120' });
  });

  it('returns the boundary error for a strike beyond 6 significant figures', () => {
    const r = encodeContract({
      underlying: 'NVDA',
      expiry: '2026-03-21',
      type: 'call',
      strike: '1234.567',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_STRIKE_NOT_REPRESENTABLE');
  });
});

describe('decodeContract', () => {
  it('decodes a call and normalises an integer strike (no trailing zeros)', () => {
    expect(decodeContract('NVDA260321C120')).toEqual({
      underlying: 'NVDA',
      expiry: '2026-03-21',
      type: 'call',
      strike: '120',
    });
  });

  it('normalises a fractional strike to "0.5", not "5.00000e-1"', () => {
    expect(decodeContract('SPY260321C0.5')?.strike).toBe('0.5');
  });

  it('returns null for a non-OCC symbol', () => {
    expect(decodeContract('AAPL')).toBeNull();
    expect(decodeContract('NVDA 250CALL')).toBeNull();
  });
});

describe('occErrorField', () => {
  it('maps each code to the correct field', () => {
    expect(occErrorField('OCC_BAD_UNDERLYING')).toBe('underlying');
    expect(occErrorField('OCC_STRIKE_RANGE')).toBe('strike');
    expect(occErrorField('OCC_STRIKE_PRECISION')).toBe('strike');
    expect(occErrorField('OCC_STRIKE_NOT_REPRESENTABLE')).toBe('strike');
    expect(occErrorField('OCC_BAD_DATE')).toBe('expiry');
    expect(occErrorField('OCC_DATE_RANGE')).toBe('expiry');
  });

  it('maps OCC_COMPACT_TOO_LONG and unknown codes to the form slot', () => {
    expect(occErrorField('OCC_COMPACT_TOO_LONG')).toBe('form');
    expect(occErrorField('OCC_SOMETHING_ELSE')).toBe('form');
  });
});
