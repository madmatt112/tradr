// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CurrencyHistoryRange, derivePresetRange } from './derivePresetRange';

// ---- Fixtures --------------------------------------------------------------
const TZ_UTC = 'UTC';
const TZ_NY = 'America/New_York';
const TZ_TOKYO = 'Asia/Tokyo';

const EMPTY_HISTORY: CurrencyHistoryRange = {
  earliestClosedAt: null,
  mostRecentClosedAt: null,
  totalClosedPositions: 0,
};

function historyAt(earliestIso: string, recentIso = earliestIso): CurrencyHistoryRange {
  return {
    earliestClosedAt: earliestIso,
    mostRecentClosedAt: recentIso,
    totalClosedPositions: 1,
  };
}

// All preset tests rely on `vi.setSystemTime` so the result does not depend
// on the developer's wall clock. `nowInstant` is passed explicitly to
// `derivePresetRange` (the function is pure), but we still freeze the
// system clock to make the intent obvious and to catch any accidental
// `Date.now()` introductions.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('derivePresetRange — daily 30d', () => {
  it('UTC: end = next local midnight, start = end - 30d', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('daily', EMPTY_HISTORY, now, TZ_UTC, 0);
    expect(r.granularity).toBe('day');
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    expect(r.start).toBe('2026-05-17T00:00:00.000Z');
  });

  it('America/New_York: midnight is local 04:00Z (EDT, UTC-4 in June)', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('daily', EMPTY_HISTORY, now, TZ_NY, 0);
    expect(r.end).toBe('2026-06-16T04:00:00.000Z');
    expect(r.start).toBe('2026-05-17T04:00:00.000Z');
  });

  it('Asia/Tokyo: 12:00Z is already 21:00 local — end is the *next* local midnight', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('daily', EMPTY_HISTORY, now, TZ_TOKYO, 0);
    // Local date in Tokyo at 2026-06-15T12:00Z is 2026-06-15 21:00.
    // Next local midnight is 2026-06-16 00:00 JST = 2026-06-15T15:00Z.
    expect(r.end).toBe('2026-06-15T15:00:00.000Z');
  });
});

describe('derivePresetRange — weekly 12w', () => {
  it('UTC, weekStartDay=0 (Sun): start anchored on next Sun 2026-06-21, end clamped to today+1', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('weekly', EMPTY_HISTORY, now, TZ_UTC, 0);
    expect(r.granularity).toBe('week');
    // end is clamped to today+1 (was the future next-week-start 2026-06-21).
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    // start is still 12 weeks = 84 days back from the natural end 2026-06-21.
    expect(r.start).toBe('2026-03-29T00:00:00.000Z');
  });

  it('UTC, weekStartDay=1 (Mon): start anchored on next Mon 2026-06-22, end clamped to today+1', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('weekly', EMPTY_HISTORY, now, TZ_UTC, 1);
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    expect(r.start).toBe('2026-03-30T00:00:00.000Z');
  });
});

describe('derivePresetRange — monthly 12m', () => {
  it('UTC: end clamped to today+1 (natural end was start of July 2026), start = July 2025', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('monthly', EMPTY_HISTORY, now, TZ_UTC, 0);
    expect(r.granularity).toBe('month');
    // end clamped to today+1; the natural start-of-next-month (2026-07-01) is in
    // the future and the backend schema rejects end > today+1.
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    expect(r.start).toBe('2025-07-01T00:00:00.000Z');
  });
});

describe('derivePresetRange — yearly (year-boundary edges)', () => {
  it('mid-year 2026-03-01 UTC: history starts 2024 → start=2024-01-01, end clamped to today+1', () => {
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const now = new Date('2026-03-01T12:00:00Z');
    const history = historyAt('2024-04-15T10:00:00Z');
    const r = derivePresetRange('yearly', history, now, TZ_UTC, 0);
    expect(r.granularity).toBe('year');
    expect(r.start).toBe('2024-01-01T00:00:00.000Z');
    // natural next-year start (2027-01-01) is in the future → clamped to today+1.
    expect(r.end).toBe('2026-03-02T00:00:00.000Z');
  });

  it('end-of-year 2026-12-31T23:00Z UTC: still year 2026 → end=2027-01-01', () => {
    // Pin a moment that is *still* in 2026 wall-clock UTC. End of year boundary
    // is the classic spot where naive arithmetic flips a year early.
    vi.setSystemTime(new Date('2026-12-31T23:00:00Z'));
    const now = new Date('2026-12-31T23:00:00Z');
    const history = historyAt('2024-04-15T10:00:00Z');
    const r = derivePresetRange('yearly', history, now, TZ_UTC, 0);
    expect(r.start).toBe('2024-01-01T00:00:00.000Z');
    expect(r.end).toBe('2027-01-01T00:00:00.000Z');
  });

  it('end-of-year in Tokyo: 2026-12-31T16:00Z is already 2027-01-01 01:00 JST → end clamped to today+1', () => {
    // This is the timezone-shifted year-boundary case: UTC clock is still 2026
    // but local clock is already 2027. derivePresetRange must use *local* year.
    vi.setSystemTime(new Date('2026-12-31T16:00:00Z'));
    const now = new Date('2026-12-31T16:00:00Z');
    const history = historyAt('2024-04-15T10:00:00Z');
    const r = derivePresetRange('yearly', history, now, TZ_TOKYO, 0);
    // Tokyo year is 2027; natural end (2028 Jan 1 = 2027-12-31T15:00Z) is in the
    // future → clamped to today+1 = next local midnight = 2027-01-01T15:00Z.
    expect(r.end).toBe('2027-01-01T15:00:00.000Z');
  });

  it('no history → just current year window', () => {
    vi.setSystemTime(new Date('2026-12-31T23:00:00Z'));
    const now = new Date('2026-12-31T23:00:00Z');
    const r = derivePresetRange('yearly', EMPTY_HISTORY, now, TZ_UTC, 0);
    expect(r.start).toBe('2026-01-01T00:00:00.000Z');
    expect(r.end).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('derivePresetRange — YTD', () => {
  it('UTC: Jan 1 of current year through today+1 (year-to-date, not full year)', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('ytd', EMPTY_HISTORY, now, TZ_UTC, 0);
    expect(r.granularity).toBe('month');
    expect(r.start).toBe('2026-01-01T00:00:00.000Z');
    // natural next-Jan-1 (2027-01-01) is in the future → clamped to today+1.
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
  });

  it('America/New_York: local Jan 1 midnight = 05:00Z (EST), end clamped to today+1', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('ytd', EMPTY_HISTORY, now, TZ_NY, 0);
    expect(r.start).toBe('2026-01-01T05:00:00.000Z');
    // local next-midnight is 2026-06-16 00:00 EDT = 2026-06-16T04:00Z.
    expect(r.end).toBe('2026-06-16T04:00:00.000Z');
  });
});

describe('derivePresetRange — All-Time', () => {
  it('with history: start = startOfMonth(earliest), end clamped to today+1', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const history = historyAt('2024-04-15T10:00:00Z');
    const r = derivePresetRange('all-time', history, now, TZ_UTC, 0);
    expect(r.granularity).toBe('month');
    expect(r.start).toBe('2024-04-01T00:00:00.000Z');
    // natural start-of-next-month (2026-07-01) is in the future → clamped.
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
  });

  it('no history: start = current-month start, end clamped to today+1', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const r = derivePresetRange('all-time', EMPTY_HISTORY, now, TZ_UTC, 0);
    expect(r.start).toBe('2026-06-01T00:00:00.000Z');
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
  });

  it('end-of-year boundary: now=2026-12-31T23Z UTC → end=2027-02-01? no, Jan only', () => {
    // 2026-12-31 → next month start is 2027-01-01, NOT 2027-02-01.
    vi.setSystemTime(new Date('2026-12-31T23:00:00Z'));
    const now = new Date('2026-12-31T23:00:00Z');
    const history = historyAt('2024-04-15T10:00:00Z');
    const r = derivePresetRange('all-time', history, now, TZ_UTC, 0);
    expect(r.end).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('derivePresetRange — a close dated in the future', () => {
  // Exit fills carry no future-date guard, so a mistyped year on a close puts
  // `earliestClosedAt` ahead of the clock. Anchoring `start` on it would put
  // `start` after `end` (which is held at today+1), and the backend rejects
  // `start >= end` with a 400 START_NOT_BEFORE_END — every widget on the window
  // would show its error state. An all-time window stops at the end of today
  // regardless, so a start beyond that could only describe an empty range.
  const now = new Date('2026-06-15T12:00:00Z');

  it('all-time: a sole future close anchors on the current month, not on 2027', () => {
    const history = historyAt('2027-03-04T10:00:00Z');
    const r = derivePresetRange('all-time', history, now, TZ_UTC, 0);
    expect(r.start).toBe('2026-06-01T00:00:00.000Z');
    expect(r.end).toBe('2026-06-16T00:00:00.000Z');
    expect(new Date(r.start).getTime()).toBeLessThan(new Date(r.end).getTime());
  });

  it('yearly: same, anchoring on the current year', () => {
    const history = historyAt('2027-03-04T10:00:00Z');
    const r = derivePresetRange('yearly', history, now, TZ_UTC, 0);
    expect(r.start).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(r.start).getTime()).toBeLessThan(new Date(r.end).getTime());
  });

  it('all-time: real past history is NOT truncated by a future close alongside it', () => {
    // `mostRecentClosedAt` in the future while `earliestClosedAt` is real — the
    // window must still reach back to the earliest close. The fix clamps the
    // ANCHOR, not the history.
    const history = historyAt('2024-04-15T10:00:00Z', '2027-03-04T10:00:00Z');
    const r = derivePresetRange('all-time', history, now, TZ_UTC, 0);
    expect(r.start).toBe('2024-04-01T00:00:00.000Z');
  });

  it.each([TZ_UTC, TZ_NY, TZ_TOKYO])(
    'keeps start strictly before end for every preset in %s when all history is ahead of the clock',
    (tz) => {
      const history = historyAt('2027-03-04T10:00:00Z');
      for (const preset of ['daily', 'weekly', 'monthly', 'yearly', 'ytd', 'all-time'] as const) {
        const r = derivePresetRange(preset, history, now, tz, 0);
        expect(
          new Date(r.start).getTime(),
          `${preset} in ${tz} derived start ${r.start} >= end ${r.end}`,
        ).toBeLessThan(new Date(r.end).getTime());
      }
    },
  );
});

describe('derivePresetRange — end never exceeds the schema max (today + 1 day)', () => {
  // The backend PerformanceQuerySchema rejects any `end` past local
  // start-of-tomorrow (today + 1 day) with a 400 VALIDATION_ERROR. The `daily`
  // preset's end IS exactly that maximum, so we use it as the reference bound
  // and assert EVERY preset clamps to it. The reference date is mid-month and
  // mid-year so the monthly / yearly / ytd / all-time ends would otherwise fall
  // in the future (the original bug). start must stay strictly before end.
  const PRESETS = ['daily', 'weekly', 'monthly', 'yearly', 'ytd', 'all-time'] as const;
  const HISTORY = historyAt('2024-04-15T10:00:00Z');

  it.each([TZ_UTC, TZ_NY, TZ_TOKYO])(
    'clamps every preset end to <= today+1 in %s on a non-boundary date',
    (tz) => {
      const now = new Date('2026-06-15T12:00:00Z');
      const maxEnd = new Date(derivePresetRange('daily', HISTORY, now, tz, 0).end);
      for (const preset of PRESETS) {
        const r = derivePresetRange(preset, HISTORY, now, tz, 0);
        expect(new Date(r.end).getTime()).toBeLessThanOrEqual(maxEnd.getTime());
        expect(new Date(r.start).getTime()).toBeLessThan(new Date(r.end).getTime());
      }
    },
  );
});
