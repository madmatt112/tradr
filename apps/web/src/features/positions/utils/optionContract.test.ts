import { describe, expect, it } from 'vitest';

import { decodeOptionContract } from './optionContract';

describe('decodeOptionContract', () => {
  it('decodes a compact OCC call symbol', () => {
    expect(decodeOptionContract('NVDA260321C120')).toEqual({
      underlying: 'NVDA',
      expiryLabel: '21 Mar 2026',
      strikeLabel: '$120',
      typeLabel: 'Call',
      compactLabel: '21 Mar 26 · $120C',
    });
  });

  it('decodes a put and trims trailing-zero strikes', () => {
    const c = decodeOptionContract('AAPL250711P205');
    expect(c?.typeLabel).toBe('Put');
    expect(c?.strikeLabel).toBe('$205');
    expect(c?.compactLabel).toBe('11 Jul 25 · $205P');
  });

  it('keeps fractional strikes without trailing zeros', () => {
    // Form-4 compact symbol with a half-dollar strike.
    expect(decodeOptionContract('SPY260320C530.5')?.strikeLabel).toBe('$530.5');
  });

  it('returns null for a non-OCC symbol (plain ticker or legacy free text)', () => {
    expect(decodeOptionContract('AAPL')).toBeNull();
    expect(decodeOptionContract('NVDA 250CALL')).toBeNull();
  });
});
