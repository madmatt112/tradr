import { describe, expect, it } from 'vitest';

import {
  COACH_MARK_KEY_MAX_LENGTH,
  OnboardingPatchSchema,
  OnboardingStateSchema,
  OnboardingStatusSchema,
} from './onboarding';

describe('OnboardingStateSchema', () => {
  // The load-bearing case: users.onboarding is NOT NULL DEFAULT '{}', so every
  // row that predates the column reads back as {} with no backfill. If this
  // ever stops parsing, existing users break on login.
  it('parses {} to sensible defaults', () => {
    const result = OnboardingStateSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ status: 'pending', coachMarksSeen: [] });
      expect(result.data.calculatorFirstUsedAt).toBeUndefined();
    }
  });

  it.each(OnboardingStatusSchema.options)('round-trips status %s', (status) => {
    const result = OnboardingStateSchema.safeParse({ status });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe(status);
  });

  it.each(['complete', 'dismissed', 'PENDING', '', null, 0])(
    'rejects the invalid status %j',
    (status) => {
      const result = OnboardingStateSchema.safeParse({ status });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'status')).toBe(true);
      }
    },
  );

  it('defaults coachMarksSeen to an empty array', () => {
    const result = OnboardingStateSchema.safeParse({ status: 'done' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.coachMarksSeen).toEqual([]);
  });

  it('accepts surface keys in coachMarksSeen', () => {
    const seen = ['partial-close', 'scale-in', 'csv-import', 'options-tools', 'dashboard-widgets'];
    const result = OnboardingStateSchema.safeParse({ coachMarksSeen: seen });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.coachMarksSeen).toEqual(seen);
  });

  it.each([['not-an-array'], [[1, 2]], [[null]]])(
    'rejects a non-string-array coachMarksSeen %j',
    (coachMarksSeen) => {
      expect(OnboardingStateSchema.safeParse({ coachMarksSeen }).success).toBe(false);
    },
  );

  // The single named R4.2 exception, and a timestamp rather than a flag.
  it.each(['2026-08-06T04:12:00.000Z', '2026-01-01T00:00:00Z'])(
    'accepts the ISO timestamp %s for calculatorFirstUsedAt',
    (calculatorFirstUsedAt) => {
      const result = OnboardingStateSchema.safeParse({ calculatorFirstUsedAt });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.calculatorFirstUsedAt).toBe(calculatorFirstUsedAt);
    },
  );

  it.each(['yesterday', '2026-08-06', '', true, 1785986843966])(
    'rejects junk %j for calculatorFirstUsedAt',
    (calculatorFirstUsedAt) => {
      const result = OnboardingStateSchema.safeParse({ calculatorFirstUsedAt });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'calculatorFirstUsedAt')).toBe(true);
      }
    },
  );

  it('omits calculatorFirstUsedAt entirely when absent rather than nulling it', () => {
    const result = OnboardingStateSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect('calculatorFirstUsedAt' in result.data).toBe(false);
  });

  // Deliberately NOT .strict(): this schema parses rows read back out of the
  // database, so a key written by a newer deployment must not make an older one
  // throw on its own users table. Stripping is Zod's default and matches the
  // majority of this package's schemas; .strict() is reserved for wire bodies
  // (expense.ts, accounting.ts, dashboard.ts) where a client is the author.
  it('strips unknown keys rather than rejecting them', () => {
    const result = OnboardingStateSchema.safeParse({
      status: 'active',
      futureVersionKey: 'written by a newer deployment',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ status: 'active', coachMarksSeen: [] });
      expect('futureVersionKey' in result.data).toBe(false);
    }
  });

  // R4.2 / design.md: per-item completion is derived from real data, never
  // stored. A stray flag must not survive into the parsed state.
  it('strips a per-item completion flag if one is ever written', () => {
    const result = OnboardingStateSchema.safeParse({ accountCreated: true, positionLogged: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ status: 'pending', coachMarksSeen: [] });
    }
  });

  it('rejects a non-object', () => {
    expect(OnboardingStateSchema.safeParse(null).success).toBe(false);
    expect(OnboardingStateSchema.safeParse('{}').success).toBe(false);
  });
});

describe('OnboardingPatchSchema', () => {
  it('accepts each field on its own', () => {
    expect(OnboardingPatchSchema.safeParse({ status: 'skipped' }).success).toBe(true);
    expect(
      OnboardingPatchSchema.safeParse({ calculatorFirstUsedAt: '2026-08-06T12:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(OnboardingPatchSchema.safeParse({ coachMarkSeen: 'csv-import' }).success).toBe(true);
  });

  // The mirror image of the state schema above, and deliberately so: this
  // body's author is a client, where an unexpected key is a mistake worth
  // saying out loud rather than dropping.
  it('rejects an unknown key instead of stripping it', () => {
    expect(OnboardingPatchSchema.safeParse({ status: 'done', tourVariant: 'v2' }).success).toBe(
      false,
    );
  });

  // The stored field is plural and is never sent whole: a client that could
  // send the array could shrink the set by omission and clobber another tab's
  // mark. Only the singular append operation is on the wire.
  it('rejects the plural coachMarksSeen array', () => {
    expect(OnboardingPatchSchema.safeParse({ coachMarksSeen: ['a'] }).success).toBe(false);
  });

  it('rejects an empty body — it would have no effect', () => {
    expect(OnboardingPatchSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid status and a non-ISO timestamp', () => {
    expect(OnboardingPatchSchema.safeParse({ status: 'finished' }).success).toBe(false);
    expect(OnboardingPatchSchema.safeParse({ calculatorFirstUsedAt: '2026-08-06' }).success).toBe(
      false,
    );
  });

  // Bounded because nothing ever removes a coach-mark key: an unbounded key
  // would let one client grow one row's jsonb without limit.
  it('bounds the coach-mark key', () => {
    expect(OnboardingPatchSchema.safeParse({ coachMarkSeen: '' }).success).toBe(false);
    expect(
      OnboardingPatchSchema.safeParse({ coachMarkSeen: 'x'.repeat(COACH_MARK_KEY_MAX_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      OnboardingPatchSchema.safeParse({ coachMarkSeen: 'x'.repeat(COACH_MARK_KEY_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});
