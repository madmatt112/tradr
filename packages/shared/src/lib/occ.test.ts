import { describe, expect, it } from 'vitest';

import { parseOccUnderlying } from './occ';

describe('parseOccUnderlying', () => {
  it('extracts underlying from space-separated compact form', () => {
    expect(parseOccUnderlying('AAPL 250320C150')).toBe('AAPL');
  });

  it('extracts underlying from compact-no-space form (v2 AS1 regression)', () => {
    expect(parseOccUnderlying('AAPL250320C150')).toBe('AAPL');
  });

  it('extracts single-char root with space', () => {
    expect(parseOccUnderlying('F 250320C012')).toBe('F');
  });

  it('extracts single-char root with no space', () => {
    expect(parseOccUnderlying('F250320C012')).toBe('F');
  });

  it('extracts dot-class share-class ticker', () => {
    expect(parseOccUnderlying('BRK.B 250320C400')).toBe('BRK.B');
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseOccUnderlying('  AAPL 250320C150  ')).toBe('AAPL');
  });

  it('returns null for empty string', () => {
    expect(parseOccUnderlying('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseOccUnderlying('   ')).toBeNull();
  });

  it('returns null for leading-digit input', () => {
    expect(parseOccUnderlying('1234567890')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseOccUnderlying(null as unknown as string)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseOccUnderlying(undefined as unknown as string)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseOccUnderlying(123 as unknown as string)).toBeNull();
  });

  it('delegates to strict parser for canonical Form-1 OCC symbol', () => {
    expect(parseOccUnderlying('AAPL  250620C00150000')).toBe('AAPL');
  });

  it('uppercases lowercase input via legacy fallback', () => {
    expect(parseOccUnderlying('aapl')).toBe('AAPL');
  });

  it('fallback regex stops at 6th character including dot', () => {
    expect(parseOccUnderlying('AAPL.X.Y')).toBe('AAPL.X');
  });

  it('falls back to leading alpha run when strict parser rejects underscore', () => {
    expect(parseOccUnderlying('AAPL_OPT')).toBe('AAPL');
  });
});
