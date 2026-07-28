import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentPeriodKeyUtc } from '@/features/admin/gating.query';
import { config } from '@/lib/config';

import { isModelPriced, PLATFORM_DEFAULT_MODEL, RATE_TABLE } from './pricing';
import {
  ACTIVE_PERIOD_SLACK_MS,
  ALLOWANCE_MODEL,
  getTierLimits,
  PAST_DUE_HORIZON_MS,
  PERIOD_KEY,
} from './tier-limits.constants';

describe('getTierLimits — the REQ-5.1 table', () => {
  let prevTurns: number;

  beforeEach(() => {
    prevTurns = config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH;
  });

  afterEach(() => {
    config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH = prevTurns;
  });

  it('free tier matches the pinned values', () => {
    expect(getTierLimits('free')).toEqual({
      accounts: 1,
      positions: 1000,
      lookbackMonths: 6,
      platformTurns: 25,
      images: 20,
      csvImports: 10,
    });
  });

  it('pro tier matches the pinned values (null = unlimited; turns from config)', () => {
    config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH = 200;
    expect(getTierLimits('pro')).toEqual({
      accounts: null,
      positions: null,
      lookbackMonths: null,
      platformTurns: 200,
      images: 500,
      csvImports: null,
    });
  });

  it('reads a mutated config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH at check time (D4: function, not frozen object)', () => {
    config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH = 7;
    expect(getTierLimits('pro').platformTurns).toBe(7);

    config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH = 999;
    expect(getTierLimits('pro').platformTurns).toBe(999);
  });

  it('free platformTurns is a code constant, unaffected by the env var', () => {
    config.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH = 999;
    expect(getTierLimits('free').platformTurns).toBe(25);
  });

  it('returns a fresh object per call (mutating a result cannot poison later reads)', () => {
    const a = getTierLimits('free');
    a.accounts = 42;
    expect(getTierLimits('free').accounts).toBe(1);
  });
});

describe('ALLOWANCE_MODEL — REQ-8.6 designation', () => {
  it('every value is a priced model (the module-load assertion invariant)', () => {
    for (const [provider, model] of Object.entries(ALLOWANCE_MODEL) as [
      keyof typeof RATE_TABLE,
      string,
    ][]) {
      expect(isModelPriced(provider, model)).toBe(true);
    }
  });

  it('covers both providers with the pinned models', () => {
    expect(ALLOWANCE_MODEL).toEqual({ claude: 'claude-sonnet-4-5', openai: 'gpt-4o' });
  });

  it('is a separate constant, not the PLATFORM_DEFAULT_MODEL object', () => {
    // Values coincide today (seeded from it), but the objects must be distinct
    // so re-documenting/changing one never silently changes the other.
    expect(ALLOWANCE_MODEL).not.toBe(PLATFORM_DEFAULT_MODEL);
  });
});

describe('REQ-1.4 bound constants', () => {
  it('ACTIVE_PERIOD_SLACK_MS is 72 hours', () => {
    expect(ACTIVE_PERIOD_SLACK_MS).toBe(72 * 60 * 60 * 1000);
  });

  it('PAST_DUE_HORIZON_MS is 28 days', () => {
    expect(PAST_DUE_HORIZON_MS).toBe(28 * 24 * 60 * 60 * 1000);
  });
});

describe('PERIOD_KEY re-export', () => {
  it('is currentPeriodKeyUtc itself', () => {
    expect(PERIOD_KEY).toBe(currentPeriodKeyUtc);
  });

  it("produces the UTC 'YYYY-MM' key", () => {
    expect(PERIOD_KEY()).toMatch(/^\d{4}-\d{2}$/);
  });
});
