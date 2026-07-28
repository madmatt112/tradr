import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '@/db';
import { config } from '@/lib/config';

import type { SubscriptionRow } from './subscription.query';
import { ACTIVE_PERIOD_SLACK_MS, PAST_DUE_HORIZON_MS } from './tier-limits.constants';
import { deriveTier, getTierContext } from './tier.query';

// Pure-function tests for deriveTier (design D3, REQ-1.3/1.4/1.5) plus the
// getTierContext pass-through doctrine (REQ-1.6/6.7). No database rows are
// touched — rows are built in memory.

const NOW = new Date('2026-07-16T12:00:00Z');
const FUTURE_PERIOD_END = new Date('2026-08-01T00:00:00Z'); // after NOW

function subRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-0000000000aa',
    stripeCustomerId: 'cus_test',
    stripeSubscriptionId: 'sub_test',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: FUTURE_PERIOD_END,
    priceId: 'price_test',
    priceUnitAmount: 1000,
    priceCurrency: 'usd',
    stripeCreatedAt: new Date('2026-07-01T00:00:00Z'),
    enteredPastDueAt: null,
    lastEventCreated: new Date('2026-07-01T00:00:00Z'),
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('deriveTier — REQ-1.3 total status mapping', () => {
  it('no rows ⇒ free, qualifying null', () => {
    expect(deriveTier([], NOW)).toEqual({ tier: 'free', qualifying: null });
  });

  it('active within the period ⇒ pro', () => {
    const row = subRow({ status: 'active' });
    expect(deriveTier([row], NOW)).toEqual({ tier: 'pro', qualifying: row });
  });

  it('trialing within the period ⇒ pro', () => {
    const row = subRow({ status: 'trialing' });
    expect(deriveTier([row], NOW)).toEqual({ tier: 'pro', qualifying: row });
  });

  it('past_due within the horizon (anchored) ⇒ pro', () => {
    const row = subRow({
      status: 'past_due',
      enteredPastDueAt: new Date('2026-07-10T00:00:00Z'),
    });
    expect(deriveTier([row], NOW)).toEqual({ tier: 'pro', qualifying: row });
  });

  it.each(['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    '%s ⇒ free (default-deny), even with a future period end',
    (status) => {
      expect(deriveTier([subRow({ status })], NOW)).toEqual({ tier: 'free', qualifying: null });
    },
  );

  it('an unknown future status ⇒ free (default-deny keeps the mapping total)', () => {
    const row = subRow({ status: 'some_status_stripe_invents_later' });
    expect(deriveTier([row], NOW)).toEqual({ tier: 'free', qualifying: null });
  });
});

describe('deriveTier — REQ-1.4 bounds', () => {
  it('active qualifies at exactly current_period_end + ACTIVE_PERIOD_SLACK_MS (inclusive)', () => {
    const row = subRow({ status: 'active' });
    const atBound = new Date(FUTURE_PERIOD_END.getTime() + ACTIVE_PERIOD_SLACK_MS);
    expect(deriveTier([row], atBound).tier).toBe('pro');
  });

  it('active lapses 1 ms past the slack bound ⇒ free', () => {
    const row = subRow({ status: 'active' });
    const pastBound = new Date(FUTURE_PERIOD_END.getTime() + ACTIVE_PERIOD_SLACK_MS + 1);
    expect(deriveTier([row], pastBound)).toEqual({ tier: 'free', qualifying: null });
  });

  it('past_due qualifies at exactly entered_past_due_at + PAST_DUE_HORIZON_MS (inclusive)', () => {
    const anchor = new Date('2026-07-10T00:00:00Z');
    const row = subRow({ status: 'past_due', enteredPastDueAt: anchor });
    const atBound = new Date(anchor.getTime() + PAST_DUE_HORIZON_MS);
    expect(deriveTier([row], atBound).tier).toBe('pro');
  });

  it('past_due lapses 1 ms past the dunning horizon ⇒ free', () => {
    const anchor = new Date('2026-07-10T00:00:00Z');
    const row = subRow({ status: 'past_due', enteredPastDueAt: anchor });
    const pastBound = new Date(anchor.getTime() + PAST_DUE_HORIZON_MS + 1);
    expect(deriveTier([row], pastBound)).toEqual({ tier: 'free', qualifying: null });
  });

  it('a null anchor on past_due is expired ⇒ free (default-deny backstop), even with a future period end', () => {
    const row = subRow({
      status: 'past_due',
      enteredPastDueAt: null,
      currentPeriodEnd: FUTURE_PERIOD_END,
    });
    expect(deriveTier([row], NOW)).toEqual({ tier: 'free', qualifying: null });
  });
});

describe('deriveTier — cancel_at_period_end', () => {
  it('canceled-pending (active + cancel_at_period_end) keeps pro until period end', () => {
    const row = subRow({ status: 'active', cancelAtPeriodEnd: true });
    expect(deriveTier([row], NOW)).toEqual({ tier: 'pro', qualifying: row });
  });

  it('canceled-pending lapses after period end + slack like any active row', () => {
    const row = subRow({ status: 'active', cancelAtPeriodEnd: true });
    const pastBound = new Date(FUTURE_PERIOD_END.getTime() + ACTIVE_PERIOD_SLACK_MS + 1);
    expect(deriveTier([row], pastBound)).toEqual({ tier: 'free', qualifying: null });
  });
});

describe('deriveTier — D3 total order among qualifying rows', () => {
  it('earliest stripe_created_at wins regardless of array order', () => {
    const earlier = subRow({
      id: '00000000-0000-0000-0000-000000000001',
      stripeSubscriptionId: 'sub_earlier',
      stripeCreatedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const later = subRow({
      id: '00000000-0000-0000-0000-000000000002',
      stripeSubscriptionId: 'sub_later',
      stripeCreatedAt: new Date('2026-07-02T00:00:00Z'),
    });
    expect(deriveTier([later, earlier], NOW).qualifying).toBe(earlier);
    expect(deriveTier([earlier, later], NOW).qualifying).toBe(earlier);
  });

  it('a same-second stripe_created_at tie is resolved by ascending stripe_subscription_id', () => {
    const created = new Date('2026-07-01T00:00:00Z'); // Stripe created has second granularity
    const subA = subRow({
      id: '00000000-0000-0000-0000-000000000001',
      stripeSubscriptionId: 'sub_a',
      stripeCreatedAt: created,
    });
    const subB = subRow({
      id: '00000000-0000-0000-0000-000000000002',
      stripeSubscriptionId: 'sub_b',
      stripeCreatedAt: created,
    });
    // Deterministic in both arrival orders — the load-bearing tiebreak.
    expect(deriveTier([subB, subA], NOW).qualifying).toBe(subA);
    expect(deriveTier([subA, subB], NOW).qualifying).toBe(subA);
  });

  it('an earlier-created NON-qualifying row never wins over a later qualifying one', () => {
    const earlierCanceled = subRow({
      id: '00000000-0000-0000-0000-000000000001',
      stripeSubscriptionId: 'sub_dead',
      status: 'canceled',
      stripeCreatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const laterActive = subRow({
      id: '00000000-0000-0000-0000-000000000002',
      stripeSubscriptionId: 'sub_live',
      status: 'active',
      stripeCreatedAt: new Date('2026-07-02T00:00:00Z'),
    });
    expect(deriveTier([earlierCanceled, laterActive], NOW)).toEqual({
      tier: 'pro',
      qualifying: laterActive,
    });
  });

  it('does not mutate the input array', () => {
    const later = subRow({
      stripeSubscriptionId: 'sub_later',
      stripeCreatedAt: new Date('2026-07-02T00:00:00Z'),
    });
    const earlier = subRow({
      stripeSubscriptionId: 'sub_earlier',
      stripeCreatedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const rows = [later, earlier];
    deriveTier(rows, NOW);
    expect(rows).toEqual([later, earlier]);
  });
});

describe('getTierContext — pass-through doctrine (REQ-1.6/6.7)', () => {
  // A db stand-in that throws on ANY use: proves the pass-through branch
  // performs no database read (the feature-gate.middleware.ts:31-32 shape).
  const explodingDb = new Proxy({} as Database, {
    get() {
      throw new Error('pass-through must not touch the database');
    },
  });

  let prevGating: boolean;

  beforeEach(() => {
    prevGating = config.FEATURE_GATING;
  });

  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  it('gating off ⇒ { enforced: false } with no DB read', async () => {
    config.FEATURE_GATING = false;
    await expect(getTierContext(explodingDb, { userId: 'u1', isAdmin: false })).resolves.toEqual({
      enforced: false,
    });
  });

  it('admin ⇒ { enforced: false } with no DB read, even with gating on', async () => {
    config.FEATURE_GATING = true;
    await expect(getTierContext(explodingDb, { userId: 'u1', isAdmin: true })).resolves.toEqual({
      enforced: false,
    });
  });
});
