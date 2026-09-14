// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { currentMonthInTz, deriveCalendarWindow, parseMonthParam } from './deriveCalendarWindow';

const TZ_UTC = 'UTC';
const TZ_NY = 'America/New_York';

describe('parseMonthParam', () => {
  it('parses a well-formed YYYY-MM', () => {
    expect(parseMonthParam('2026-03')).toEqual({ year: 2026, month1: 3 });
    expect(parseMonthParam('2000-01')).toEqual({ year: 2000, month1: 1 });
    expect(parseMonthParam('2026-12')).toEqual({ year: 2026, month1: 12 });
  });

  it('returns null on anything else', () => {
    expect(parseMonthParam(undefined)).toBeNull();
    expect(parseMonthParam('')).toBeNull();
    expect(parseMonthParam('2026')).toBeNull();
    expect(parseMonthParam('2026-3')).toBeNull(); // month not zero-padded
    expect(parseMonthParam('2026-13')).toBeNull(); // month out of range
    expect(parseMonthParam('2026-00')).toBeNull();
    expect(parseMonthParam('garbage')).toBeNull();
  });
});

describe('currentMonthInTz', () => {
  it('computes the local month for a valid zone', () => {
    expect(currentMonthInTz(new Date('2026-03-15T12:00:00Z'), TZ_UTC)).toBe('2026-03');
    // 02:00 UTC on Mar 1 is still Feb 28 (21:00 EST) in New York.
    expect(currentMonthInTz(new Date('2026-03-01T02:00:00Z'), TZ_NY)).toBe('2026-02');
  });

  it('falls back to UTC on an invalid IANA string without throwing', () => {
    expect(() => currentMonthInTz(new Date('2026-03-15T12:00:00Z'), 'Foo')).not.toThrow();
    expect(currentMonthInTz(new Date('2026-03-15T12:00:00Z'), 'Foo')).toBe('2026-03');
  });
});

describe('deriveCalendarWindow', () => {
  it('clamps end to local start-of-tomorrow for the current month', () => {
    const w = deriveCalendarWindow('2026-03', new Date('2026-03-15T12:00:00Z'), TZ_UTC);
    expect(w.start).toBe('2026-03-01T00:00:00.000Z');
    expect(w.end).toBe('2026-03-16T00:00:00.000Z'); // clamped, not 2026-04-01
    expect(w.nextDisabled).toBe(true);
    expect(w.prevDisabled).toBe(false);
  });

  it('leaves end at the next-month start for a fully-past month', () => {
    const w = deriveCalendarWindow('2026-01', new Date('2026-03-15T12:00:00Z'), TZ_UTC);
    expect(w.start).toBe('2026-01-01T00:00:00.000Z');
    expect(w.end).toBe('2026-02-01T00:00:00.000Z');
    expect(w.nextDisabled).toBe(false);
  });

  it('disables next at equality — next-month start === start-of-tomorrow (DD13, >=)', () => {
    const w = deriveCalendarWindow('2026-03', new Date('2026-03-31T12:00:00Z'), TZ_UTC);
    expect(w.end).toBe('2026-04-01T00:00:00.000Z');
    expect(w.nextDisabled).toBe(true);
  });

  it('disables prev at the MIN_START month (2000-01)', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    expect(deriveCalendarWindow('2000-01', now, TZ_UTC).prevDisabled).toBe(true);
    expect(deriveCalendarWindow('1999-12', now, TZ_UTC).prevDisabled).toBe(true);
    expect(deriveCalendarWindow('2000-02', now, TZ_UTC).prevDisabled).toBe(false);
  });

  it('rolls the year for December via Date.UTC overflow', () => {
    const w = deriveCalendarWindow('2026-12', new Date('2027-06-01T12:00:00Z'), TZ_UTC);
    expect(w.start).toBe('2026-12-01T00:00:00.000Z');
    expect(w.end).toBe('2027-01-01T00:00:00.000Z');
    expect(w.nextDisabled).toBe(false);
  });
});
