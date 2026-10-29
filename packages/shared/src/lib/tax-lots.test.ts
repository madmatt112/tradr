import { describe, expect, it } from 'vitest';

import { defaultLotMethod, holdTerm, resolveLotMethod } from './tax-lots';

// Contract (per AC):
// - AC 3.11 / AC 5.6 — holdTerm(openedAt, realisedAt): pre-condition is a pair of
//   Date or ISO-string timestamps; call is `holdTerm(openedAt, realisedAt)`;
//   observable result is 'short' | 'long'; expected values are taken from the
//   365-days-inclusive rule and the AC 3.11 negative-span case.
// - AC 2.1 — defaultLotMethod(jurisdiction): pre-condition is one of
//   'US' | 'CA' | 'other' | null; call is `defaultLotMethod(jurisdiction)`;
//   observable result is 'fifo' | 'average'; expected values are taken from
//   requirements.md Req 2 AC 2.1 ("average cost if ... CA, FIFO if ... US, other
//   or NULL").
// - AC 2.2 — resolveLotMethod(stored, jurisdiction): pre-condition is a stored
//   value (LotMethod | null) and a jurisdiction; call is
//   `resolveLotMethod(stored, jurisdiction)`; observable result is
//   `{ method, isDefault }`; expected values are taken from requirements.md
//   Req 2 AC 2.2 ("a stored value SHALL override the jurisdiction default").

const DAY_MS = 24 * 60 * 60 * 1000;

describe('holdTerm', () => {
  it('364 days — short (AC 3.11, AC 5.6)', () => {
    const opened = new Date('2026-01-01T00:00:00Z');
    const realised = new Date(opened.getTime() + 364 * DAY_MS);
    expect(holdTerm(opened, realised)).toBe('short');
  });

  it('exactly 365 days — short, inclusive boundary (AC 5.6)', () => {
    const opened = new Date('2026-01-01T00:00:00Z');
    const realised = new Date(opened.getTime() + 365 * DAY_MS);
    expect(holdTerm(opened, realised)).toBe('short');
  });

  it('366 days — long (AC 5.6)', () => {
    const opened = new Date('2026-01-01T00:00:00Z');
    const realised = new Date(opened.getTime() + 366 * DAY_MS);
    expect(holdTerm(opened, realised)).toBe('long');
  });

  it('negative span — short (AC 3.11: an exit dated before its lot counts as a zero-day hold)', () => {
    const opened = new Date('2026-06-15T00:00:00Z');
    const realised = new Date(opened.getTime() - 10 * DAY_MS);
    expect(holdTerm(opened, realised)).toBe('short');
  });

  it('accepts ISO-string inputs (364 days — short)', () => {
    const opened = '2026-01-01T00:00:00.000Z';
    const realised = new Date(new Date(opened).getTime() + 364 * DAY_MS).toISOString();
    expect(holdTerm(opened, realised)).toBe('short');
  });

  it('accepts ISO-string inputs (366 days — long)', () => {
    const opened = '2026-01-01T00:00:00.000Z';
    const realised = new Date(new Date(opened).getTime() + 366 * DAY_MS).toISOString();
    expect(holdTerm(opened, realised)).toBe('long');
  });
});

describe('defaultLotMethod', () => {
  it("'CA' — average (AC 2.1)", () => {
    expect(defaultLotMethod('CA')).toBe('average');
  });

  it("'US' — fifo (AC 2.1)", () => {
    expect(defaultLotMethod('US')).toBe('fifo');
  });

  it("'other' — fifo (AC 2.1)", () => {
    expect(defaultLotMethod('other')).toBe('fifo');
  });

  it('null — fifo (AC 2.1)', () => {
    expect(defaultLotMethod(null)).toBe('fifo');
  });
});

describe('resolveLotMethod', () => {
  it('stored value wins over the jurisdiction default (AC 2.2)', () => {
    expect(resolveLotMethod('fifo', 'CA')).toEqual({ method: 'fifo', isDefault: false });
  });

  it('stored value equal to the default is still not the default (AC 2.2)', () => {
    expect(resolveLotMethod('average', 'CA')).toEqual({ method: 'average', isDefault: false });
  });

  it('null stored value falls back to the jurisdiction default (AC 2.1, AC 2.2)', () => {
    expect(resolveLotMethod(null, 'CA')).toEqual({ method: 'average', isDefault: true });
  });

  it('null stored value for a US user falls back to fifo (AC 2.1, AC 2.2)', () => {
    expect(resolveLotMethod(null, 'US')).toEqual({ method: 'fifo', isDefault: true });
  });
});
