import { describe, expect, it } from 'vitest';

import type { Tag, TradingRule, TradingRuleDefinition } from '@tradr/shared';
import { describeRule } from '@tradr/shared/lib/trading-rules';

import {
  buildScoringContext,
  evaluateRule,
  scorePosition,
  type BalanceEntry,
  type ScoringData,
  type ScoringPosition,
} from './rule-evaluator';

// --- Fixtures ---

type Fill = ScoringPosition['fills'][number];

const OPEN = '2026-01-05T02:00:00Z'; // America/New_York: 2026-01-04 (Sunday, weekday 0)

function entry(price: string, quantity: string, filledAt: string, fees = '0'): Fill {
  return { type: 'entry', price, quantity, fees, filledAt };
}
function exit(price: string, quantity: string, filledAt: string, fees = '0'): Fill {
  return { type: 'exit', price, quantity, fees, filledAt };
}

function pos(over: Partial<ScoringPosition> = {}): ScoringPosition {
  return {
    id: 'target',
    side: 'long',
    assetType: 'stock',
    symbol: 'AAPL',
    currency: 'USD',
    closedAt: null,
    status: 'open',
    lastFlatAt: null,
    lastFlatNetPnl: null,
    fills: [entry('10', '100', OPEN)],
    tags: [],
    accountId: 'acct-1',
    openedAt: OPEN,
    createdAt: OPEN,
    stopLoss: '9',
    targetPrice: null,
    hasNotes: false,
    accountTimezone: 'America/New_York',
    startingBalance: '10000',
    ...over,
  };
}

let ruleSeq = 0;
function rule(definition: TradingRuleDefinition, over: Partial<TradingRule> = {}): TradingRule {
  ruleSeq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(ruleSeq).padStart(12, '0')}`,
    definition,
    description: describeRule(definition),
    weight: 'critical',
    enabled: true,
    accountId: null,
    tagId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function tag(id: string): Tag {
  return { id, name: id, category: 'general', color: null };
}

// Score one rule against one target, with an optional wider population/ledger.
function evalOne(
  definition: TradingRuleDefinition,
  posOver: Partial<ScoringPosition> = {},
  ruleOver: Partial<TradingRule> = {},
  extra: { positions?: ScoringPosition[]; ledger?: BalanceEntry[]; weekStartDay?: 0 | 1 } = {},
) {
  const target = pos(posOver);
  const r = rule(definition, ruleOver);
  const data: ScoringData = {
    rules: [r],
    positions: [target, ...(extra.positions ?? [])],
    ledger: extra.ledger ?? [],
  };
  const ctx = buildScoringContext(data, extra.weekStartDay ?? 0);
  return evaluateRule(r, target, ctx);
}

// A closed, losing helper position that realises `net` (< 0) at `exitAt`.
function losingPosition(id: string, net: number, openAt: string, exitAt: string): ScoringPosition {
  const perShare = 10 + net / 100; // exit price so (exit - 10) * 100 === net
  return pos({
    id,
    status: 'closed',
    openedAt: openAt,
    createdAt: openAt,
    closedAt: exitAt,
    lastFlatAt: exitAt,
    lastFlatNetPnl: String(net),
    stopLoss: null,
    fills: [entry('10', '100', openAt), exit(String(perShare), '100', exitAt)],
  });
}

// A flat, grouped leg that realises `net` (can be positive or negative) at
// `flatAt`, so a group of these can be summed by `classifyGroup` (task 8
// exports) into one unit's winning/losing figure (design C9).
function leg(
  id: string,
  groupId: string,
  net: number,
  openAt: string,
  flatAt: string,
  tags: Tag[] = [],
): ScoringPosition {
  const perShare = 10 + net / 100;
  return pos({
    id,
    groupId,
    status: 'closed',
    openedAt: openAt,
    createdAt: openAt,
    closedAt: flatAt,
    lastFlatAt: flatAt,
    lastFlatNetPnl: String(net),
    stopLoss: null,
    tags,
    fills: [entry('10', '100', openAt), exit(String(perShare), '100', flatAt)],
  });
}

// --- Per-type: at the limit passes (daily/weekly loss breach), one over breaches ---

describe('per-type limit and breach boundaries', () => {
  it('max_risk_percent: 1% passes at the limit, above breaches', () => {
    const pass = evalOne({ type: 'max_risk_percent', params: { percent: '1' } });
    expect(pass).toMatchObject({ outcome: 'pass', unit: 'percent', measured: '1', limit: '1' });

    const breach = evalOne(
      { type: 'max_risk_percent', params: { percent: '1' } },
      { stopLoss: '8' },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '2' });
  });

  it('max_risk_amount: risk equal to the amount passes, one cent over breaches', () => {
    const pass = evalOne({ type: 'max_risk_amount', params: { amount: '100', currency: 'USD' } });
    expect(pass).toMatchObject({
      outcome: 'pass',
      unit: 'currency',
      currency: 'USD',
      measured: '100',
    });

    const breach = evalOne({
      type: 'max_risk_amount',
      params: { amount: '99.99', currency: 'USD' },
    });
    expect(breach).toMatchObject({ outcome: 'breach', measured: '100' });
  });

  it('max_position_size: notional equal to the amount passes, one cent over breaches', () => {
    const pass = evalOne({
      type: 'max_position_size',
      params: { amount: '1000', currency: 'USD' },
    });
    expect(pass).toMatchObject({ outcome: 'pass', measured: '1000' });

    const breach = evalOne({
      type: 'max_position_size',
      params: { amount: '999.99', currency: 'USD' },
    });
    expect(breach).toMatchObject({ outcome: 'breach', measured: '1000' });
  });

  it('min_risk_reward: ratio equal to the limit passes, below breaches', () => {
    const pass = evalOne(
      { type: 'min_risk_reward', params: { ratio: '2' } },
      { targetPrice: '12' },
    );
    expect(pass).toMatchObject({ outcome: 'pass', unit: 'ratio', measured: '2', limit: '2' });

    const breach = evalOne(
      { type: 'min_risk_reward', params: { ratio: '2' } },
      { targetPrice: '11.99' },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '1.99' });
  });

  it('max_daily_loss: a loss equal to the limit breaches (D8), a smaller loss passes', () => {
    const breach = evalOne(
      { type: 'max_daily_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions: [losingPosition('b', -100, '2026-01-04T20:00:00Z', '2026-01-04T23:00:00Z')] },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '-100', limit: '-100' });

    const pass = evalOne(
      { type: 'max_daily_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions: [losingPosition('b', -50, '2026-01-04T20:00:00Z', '2026-01-04T23:00:00Z')] },
    );
    expect(pass).toMatchObject({ outcome: 'pass', measured: '-50' });
  });

  it('max_weekly_loss: a loss equal to the limit breaches, a smaller loss passes', () => {
    const breach = evalOne(
      { type: 'max_weekly_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions: [losingPosition('b', -100, '2026-01-04T20:00:00Z', '2026-01-04T23:00:00Z')] },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '-100', limit: '-100' });

    const pass = evalOne(
      { type: 'max_weekly_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions: [losingPosition('b', -50, '2026-01-04T20:00:00Z', '2026-01-04T23:00:00Z')] },
    );
    expect(pass).toMatchObject({ outcome: 'pass', measured: '-50' });
  });

  it('max_total_exposure: notional plus others equal to the amount passes, above breaches', () => {
    // target notional 1000 + one other open position's basis 1000 = 2000.
    const other = pos({ id: 'e', fills: [entry('10', '100', '2026-01-05T01:00:00Z')] });
    const pass = evalOne(
      { type: 'max_total_exposure', params: { amount: '2000', currency: 'USD' } },
      {},
      {},
      { positions: [other] },
    );
    expect(pass).toMatchObject({ outcome: 'pass', measured: '2000' });

    const breach = evalOne(
      { type: 'max_total_exposure', params: { amount: '1999.99', currency: 'USD' } },
      {},
      {},
      { positions: [other] },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '2000' });
  });

  it('required_fields: all present passes, a missing field breaches', () => {
    const pass = evalOne(
      { type: 'required_fields', params: { fields: ['stop_loss', 'target_price'] } },
      { targetPrice: '12' },
    );
    expect(pass).toMatchObject({ outcome: 'pass', unit: 'list', measured: '' });

    const breach = evalOne({ type: 'required_fields', params: { fields: ['notes'] } });
    expect(breach).toMatchObject({ outcome: 'breach', measured: 'notes' });
  });

  it('allowed_markets: the asset type in the set passes, otherwise breaches', () => {
    const pass = evalOne({ type: 'allowed_markets', params: { markets: ['stock'] } });
    expect(pass).toMatchObject({ outcome: 'pass', measured: 'stock' });

    const breach = evalOne({ type: 'allowed_markets', params: { markets: ['option'] } });
    expect(breach).toMatchObject({ outcome: 'breach', measured: 'stock' });
  });

  it('allowed_directions: the side in the set passes, otherwise breaches', () => {
    const pass = evalOne({ type: 'allowed_directions', params: { directions: ['long'] } });
    expect(pass).toMatchObject({ outcome: 'pass', measured: 'long' });

    const breach = evalOne({ type: 'allowed_directions', params: { directions: ['short'] } });
    expect(breach).toMatchObject({ outcome: 'breach', measured: 'long' });
  });

  it('no_trading_days: a non-listed weekday passes, a listed weekday breaches', () => {
    const pass = evalOne({ type: 'no_trading_days', params: { weekdays: [6] } });
    expect(pass).toMatchObject({ outcome: 'pass', measured: '0' });

    const breach = evalOne({ type: 'no_trading_days', params: { weekdays: [0] } });
    expect(breach).toMatchObject({ outcome: 'breach', measured: '0', limit: '0' });
  });

  it('max_trades_per_day: at the count passes, above breaches', () => {
    const earlier = pos({
      id: 'earlier',
      openedAt: '2026-01-05T01:00:00Z',
      createdAt: '2026-01-05T01:00:00Z',
    });
    const pass = evalOne(
      { type: 'max_trades_per_day', params: { count: 2 } },
      {},
      {},
      {
        positions: [earlier],
      },
    );
    expect(pass).toMatchObject({ outcome: 'pass', unit: 'count', measured: '2' });

    const breach = evalOne(
      { type: 'max_trades_per_day', params: { count: 1 } },
      {},
      {},
      {
        positions: [earlier],
      },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '2' });
  });

  it('cooldown_after_loss: a flat exactly at the limit passes, just under breaches', () => {
    const passLoss = losingPosition('f', -100, '2026-01-05T00:00:00Z', '2026-01-05T01:00:00Z');
    const pass = evalOne(
      { type: 'cooldown_after_loss', params: { minutes: 60 } },
      {},
      {},
      {
        positions: [passLoss],
      },
    );
    expect(pass).toMatchObject({ outcome: 'pass', unit: 'minutes', measured: '60' });

    const breachLoss = losingPosition('f', -100, '2026-01-05T00:00:00Z', '2026-01-05T01:01:00Z');
    const breach = evalOne(
      { type: 'cooldown_after_loss', params: { minutes: 60 } },
      {},
      {},
      {
        positions: [breachLoss],
      },
    );
    expect(breach).toMatchObject({ outcome: 'breach', measured: '59' });
  });

  it('cooldown_after_loss: no prior loss is a pass with null measured (D9)', () => {
    const result = evalOne({ type: 'cooldown_after_loss', params: { minutes: 60 } });
    expect(result).toMatchObject({ outcome: 'pass', measured: null });
  });
});

// --- Reasons and their precedence ---

describe('not-evaluable reasons', () => {
  it('max_risk_percent without a stop is not_evaluable no_stop_loss', () => {
    const e = evalOne({ type: 'max_risk_percent', params: { percent: '1' } }, { stopLoss: null });
    expect(e).toMatchObject({ outcome: 'not_evaluable', reason: 'no_stop_loss', measured: null });
  });

  it('max_risk_amount without a stop is not_evaluable no_stop_loss', () => {
    const e = evalOne(
      { type: 'max_risk_amount', params: { amount: '100', currency: 'USD' } },
      { stopLoss: null },
    );
    expect(e).toMatchObject({ outcome: 'not_evaluable', reason: 'no_stop_loss' });
  });

  it('max_risk_percent with a non-positive balance is not_evaluable non_positive_balance', () => {
    const e = evalOne(
      { type: 'max_risk_percent', params: { percent: '1' } },
      { startingBalance: '0' },
    );
    expect(e).toMatchObject({ outcome: 'not_evaluable', reason: 'non_positive_balance' });
  });

  it('max_risk_percent prefers no_stop_loss over non_positive_balance', () => {
    const e = evalOne(
      { type: 'max_risk_percent', params: { percent: '1' } },
      { stopLoss: null, startingBalance: '0' },
    );
    expect(e).toMatchObject({ outcome: 'not_evaluable', reason: 'no_stop_loss' });
  });

  it('min_risk_reward reasons follow precedence: stop, then target, then planned R:R', () => {
    const noStop = evalOne(
      { type: 'min_risk_reward', params: { ratio: '2' } },
      { stopLoss: null, targetPrice: null },
    );
    expect(noStop).toMatchObject({ reason: 'no_stop_loss' });

    const noTarget = evalOne(
      { type: 'min_risk_reward', params: { ratio: '2' } },
      { stopLoss: '9', targetPrice: null },
    );
    expect(noTarget).toMatchObject({ reason: 'no_target_price' });

    // stop equals the average entry ⇒ zero per-unit risk ⇒ null planned R:R.
    const noRr = evalOne(
      { type: 'min_risk_reward', params: { ratio: '2' } },
      { stopLoss: '10', targetPrice: '12' },
    );
    expect(noRr).toMatchObject({ reason: 'no_planned_rr' });
  });
});

// --- Applicability (Requirement 3.1) ---

describe('applicability', () => {
  it('does not apply to a draft', () => {
    expect(
      evalOne({ type: 'allowed_markets', params: { markets: ['stock'] } }, { status: 'draft' }),
    ).toBeNull();
  });

  it('does not apply outside an account scope', () => {
    const e = evalOne(
      { type: 'allowed_markets', params: { markets: ['stock'] } },
      {},
      {
        accountId: 'acct-2',
      },
    );
    expect(e).toBeNull();
  });

  it('applies only when the position carries the scoped tag now', () => {
    const withoutTag = evalOne(
      { type: 'allowed_markets', params: { markets: ['stock'] } },
      {},
      {
        tagId: 'tag-1',
      },
    );
    expect(withoutTag).toBeNull();

    const withTag = evalOne(
      { type: 'allowed_markets', params: { markets: ['stock'] } },
      { tags: [tag('tag-1')] },
      { tagId: 'tag-1' },
    );
    expect(withTag).toMatchObject({ outcome: 'pass' });
  });

  it('a currency-amount rule does not apply to a different account currency', () => {
    const e = evalOne(
      { type: 'max_risk_amount', params: { amount: '100', currency: 'EUR' } },
      { currency: 'USD' },
    );
    expect(e).toBeNull();
  });
});

// --- The score: weights and half-up rounding ---

describe('scorePosition', () => {
  it('weights pass/breach and rounds the percentage half up', () => {
    // pass weight 1 (nice_to_have), breach weight 7 (critical 3 + important 2 + important 2)
    // ⇒ 100 × 1 / 8 = 12.5 ⇒ ROUND_HALF_UP ⇒ 13.
    const rules: TradingRule[] = [
      rule(
        { type: 'max_position_size', params: { amount: '1000', currency: 'USD' } },
        {
          weight: 'nice_to_have',
        },
      ),
      rule({ type: 'allowed_markets', params: { markets: ['option'] } }, { weight: 'critical' }),
      rule(
        { type: 'allowed_directions', params: { directions: ['short'] } },
        { weight: 'important' },
      ),
      rule({ type: 'no_trading_days', params: { weekdays: [0] } }, { weight: 'important' }),
    ];
    const target = pos();
    const ctx = buildScoringContext({ rules, positions: [target], ledger: [] }, 0);
    const result = scorePosition(ctx, 'target');
    expect(result).toMatchObject({ score: 13, status: 'non_compliant', finality: 'provisional' });
    expect(result.entries).toHaveLength(4);
  });

  it('is unscored when no enabled rule passed or breached', () => {
    // Only a not_evaluable rule ⇒ zero denominator ⇒ null score, unscored.
    const r = rule({ type: 'max_risk_amount', params: { amount: '100', currency: 'USD' } });
    const target = pos({ stopLoss: null });
    const ctx = buildScoringContext({ rules: [r], positions: [target], ledger: [] }, 0);
    const result = scorePosition(ctx, 'target');
    expect(result).toMatchObject({ score: null, status: 'unscored' });
    expect(result.entries).toHaveLength(1);
  });

  it('a draft has no finality, no score and no entries (D19)', () => {
    const r = rule({ type: 'allowed_markets', params: { markets: ['stock'] } });
    const target = pos({ status: 'draft' });
    const ctx = buildScoringContext({ rules: [r], positions: [target], ledger: [] }, 0);
    expect(scorePosition(ctx, 'target')).toEqual({
      finality: null,
      score: null,
      status: 'unscored',
      entries: [],
    });
  });

  it('is final and compliant when closed with no breach', () => {
    const r = rule({ type: 'allowed_markets', params: { markets: ['stock'] } });
    const target = pos({ status: 'closed', closedAt: OPEN, lastFlatAt: OPEN });
    const ctx = buildScoringContext({ rules: [r], positions: [target], ledger: [] }, 0);
    expect(scorePosition(ctx, 'target')).toMatchObject({
      finality: 'final',
      status: 'compliant',
      score: 100,
    });
  });

  it('skips disabled rules', () => {
    const r = rule(
      { type: 'allowed_markets', params: { markets: ['option'] } },
      { enabled: false },
    );
    const target = pos();
    const ctx = buildScoringContext({ rules: [r], positions: [target], ledger: [] }, 0);
    expect(scorePosition(ctx, 'target')).toMatchObject({
      score: null,
      status: 'unscored',
      entries: [],
    });
  });
});

// --- Context is read as of the open instant ---

describe('context read as of the open instant', () => {
  it('a later trade leaves a daily-loss and trades-per-day score unchanged', () => {
    const before = losingPosition('b', -50, '2026-01-04T20:00:00Z', '2026-01-04T23:00:00Z');
    const target = pos();
    const daily = rule({ type: 'max_daily_loss', params: { amount: '100', currency: 'USD' } });
    const trades = rule({ type: 'max_trades_per_day', params: { count: 5 } });

    const withoutLater: ScoringData = {
      rules: [daily, trades],
      positions: [target, before],
      ledger: [],
    };
    const ctxA = buildScoringContext(withoutLater, 0);
    const dailyA = evaluateRule(daily, target, ctxA);
    const tradesA = evaluateRule(trades, target, ctxA);

    // A trade opened AFTER the target, same day, that also realises a loss.
    const later = losingPosition('c', -80, '2026-01-05T03:00:00Z', '2026-01-05T04:00:00Z');
    const withLater: ScoringData = {
      rules: [daily, trades],
      positions: [target, before, later],
      ledger: [],
    };
    const ctxB = buildScoringContext(withLater, 0);
    const dailyB = evaluateRule(daily, target, ctxB);
    const tradesB = evaluateRule(trades, target, ctxB);

    expect(dailyB?.measured).toBe(dailyA?.measured);
    expect(dailyB?.measured).toBe('-50');
    expect(tradesB?.measured).toBe(tradesA?.measured);
    expect(tradesB?.measured).toBe('2'); // target + the one earlier trade
  });
});

// --- Trading day and week across UTC midnight ---

describe('trading day and week across UTC midnight', () => {
  it('daily loss sums the target-day events on both sides of UTC midnight', () => {
    const positions = [
      // NY 2026-01-04 (same day, before open): both count.
      losingPosition('a', -100, '2026-01-04T18:00:00Z', '2026-01-04T23:00:00Z'),
      losingPosition('b', -50, '2026-01-04T18:00:00Z', '2026-01-05T01:30:00Z'),
      // NY 2026-01-03 (previous day): excluded even though it is the same-or-earlier UTC day.
      losingPosition('c', -100, '2026-01-04T02:00:00Z', '2026-01-04T04:00:00Z'),
    ];
    const e = evalOne(
      { type: 'max_daily_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions },
    );
    expect(e).toMatchObject({ outcome: 'breach', measured: '-150' });
  });

  it('weekly loss membership depends on the week start day', () => {
    // Event on NY Saturday 2026-01-03; target opens NY Sunday 2026-01-04.
    const positions = [losingPosition('a', -100, '2026-01-03T18:00:00Z', '2026-01-03T20:00:00Z')];

    const weekStart0 = evalOne(
      { type: 'max_weekly_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions, weekStartDay: 0 },
    );
    // Sunday-start weeks: Saturday Jan 3 and Sunday Jan 4 are in different weeks.
    expect(weekStart0).toMatchObject({ outcome: 'pass', measured: '0' });

    const weekStart1 = evalOne(
      { type: 'max_weekly_loss', params: { amount: '100', currency: 'USD' } },
      {},
      {},
      { positions, weekStartDay: 1 },
    );
    // Monday-start weeks: Saturday Jan 3 and Sunday Jan 4 share the Dec 29 week.
    expect(weekStart1).toMatchObject({ outcome: 'breach', measured: '-100' });
  });
});

// --- Exposure from earlier fills only ---

describe('exposure', () => {
  it('counts only fills filled strictly before the open instant', () => {
    const other = pos({
      id: 'e',
      fills: [
        entry('10', '100', '2026-01-05T01:00:00Z'), // before target open — counts (basis 1000)
        entry('10', '100', '2026-01-05T03:00:00Z'), // after — ignored
      ],
    });
    const e = evalOne(
      { type: 'max_total_exposure', params: { amount: '2000', currency: 'USD' } },
      {},
      {},
      { positions: [other] },
    );
    // 1000 (target notional) + 1000 (other's earlier fill only) = 2000, not 3000.
    expect(e).toMatchObject({ outcome: 'pass', measured: '2000' });
  });
});

// --- createdAt fallback (D7) ---

describe('createdAt fallback', () => {
  it('uses the creation time as the open instant when openedAt is null', () => {
    // createdAt is NY Sunday (weekday 0); a no-trading-days rule on Sunday breaches.
    const e = evalOne(
      { type: 'no_trading_days', params: { weekdays: [0] } },
      { openedAt: null, createdAt: OPEN },
    );
    expect(e).toMatchObject({ outcome: 'breach', measured: '0' });
  });
});

// --- Group-aware rules (AC 5.10, design C9) ---

describe('group-aware rules', () => {
  it('max_trades_per_day counts a two-leg group once toward another same-day position, and each leg scores the same count', () => {
    const legA = pos({
      id: 'legA',
      groupId: 'g1',
      openedAt: '2026-01-04T14:00:00Z',
      createdAt: '2026-01-04T14:00:00Z',
    });
    const legB = pos({
      id: 'legB',
      groupId: 'g1',
      openedAt: '2026-01-04T14:05:00Z',
      createdAt: '2026-01-04T14:05:00Z',
    });
    const other = pos({
      id: 'other',
      openedAt: '2026-01-04T15:00:00Z',
      createdAt: '2026-01-04T15:00:00Z',
    });
    const r = rule({ type: 'max_trades_per_day', params: { count: 5 } });
    const ctx = buildScoringContext({ rules: [r], positions: [legA, legB, other], ledger: [] }, 0);

    // The group opened before `other`, same day, and counts once: 1 earlier
    // unit (the group) + itself = 2, not 3 (one per leg).
    expect(evaluateRule(r, other, ctx)).toMatchObject({ measured: '2' });

    // Each leg skips its own sibling, so both score the same count.
    const forA = evaluateRule(r, legA, ctx);
    const forB = evaluateRule(r, legB, ctx);
    expect(forA?.measured).toBe(forB?.measured);
    expect(forA?.measured).toBe('1');
  });

  it("max_trades_per_day uses a group's earliest leg open for the day, even when scoring a leg that opened the next day", () => {
    const legA = pos({
      id: 'legA',
      groupId: 'g2',
      openedAt: '2026-01-04T14:00:00Z', // NY 2026-01-04
      createdAt: '2026-01-04T14:00:00Z',
    });
    const legB = pos({
      id: 'legB',
      groupId: 'g2',
      openedAt: '2026-01-05T15:00:00Z', // NY 2026-01-05 — opened the next day
      createdAt: '2026-01-05T15:00:00Z',
    });
    const posD = pos({
      id: 'posD',
      openedAt: '2026-01-04T13:00:00Z', // NY 2026-01-04, before legA
      createdAt: '2026-01-04T13:00:00Z',
    });
    const r = rule({ type: 'max_trades_per_day', params: { count: 5 } });
    const ctx = buildScoringContext({ rules: [r], positions: [legA, legB, posD], ledger: [] }, 0);

    // legB's own day is NY 2026-01-05, but its group's earliest leg (legA)
    // opened NY 2026-01-04, so legB counts on 2026-01-04 and sees posD.
    expect(evaluateRule(r, legB, ctx)).toMatchObject({ measured: '2' });
  });

  it("cooldown_after_loss triggers at a losing group's flat instant, even when one leg won", () => {
    const legLose = leg('legLose', 'g3', -200, '2026-01-04T23:00:00Z', '2026-01-05T00:00:00Z');
    const legWin = leg('legWin', 'g3', 50, '2026-01-04T23:30:00Z', '2026-01-05T01:00:00Z');
    const target = pos({ openedAt: '2026-01-05T01:30:00Z', createdAt: '2026-01-05T01:30:00Z' });
    const r = rule({ type: 'cooldown_after_loss', params: { minutes: 60 } });
    const ctx = buildScoringContext(
      { rules: [r], positions: [target, legLose, legWin], ledger: [] },
      0,
    );

    // Group net = -200 + 50 = -150 (losing); its flat instant is the LATEST
    // leg flat (legWin's, 01:00), 30 minutes before the target opens.
    expect(evaluateRule(r, target, ctx)).toMatchObject({ outcome: 'breach', measured: '30' });
  });

  it('cooldown_after_loss does not trigger for a winning group, even when one leg lost', () => {
    const legLose = leg('legLose2', 'g4', -50, '2026-01-04T23:00:00Z', '2026-01-05T00:00:00Z');
    const legWin = leg('legWin2', 'g4', 200, '2026-01-04T23:15:00Z', '2026-01-05T00:15:00Z');
    const target = pos({ openedAt: '2026-01-05T00:30:00Z', createdAt: '2026-01-05T00:30:00Z' });
    const r = rule({ type: 'cooldown_after_loss', params: { minutes: 60 } });
    const ctx = buildScoringContext(
      { rules: [r], positions: [target, legLose, legWin], ledger: [] },
      0,
    );

    // Group net = -50 + 200 = 150 (winning): no losing flat for this unit,
    // even though legLose alone realised a loss 30 minutes before the target.
    expect(evaluateRule(r, target, ctx)).toMatchObject({ outcome: 'pass', measured: null });
  });

  it('cooldown_after_loss adds no losing flat for a group that has never gone flat', () => {
    const legLose = leg('legLose3', 'g5', -100, '2026-01-04T23:00:00Z', '2026-01-05T00:00:00Z');
    const legOpen = pos({
      id: 'legOpen3',
      groupId: 'g5',
      status: 'open',
      openedAt: '2026-01-04T23:30:00Z',
      createdAt: '2026-01-04T23:30:00Z',
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
    });
    const target = pos({ openedAt: '2026-01-05T00:30:00Z', createdAt: '2026-01-05T00:30:00Z' });
    const r = rule({ type: 'cooldown_after_loss', params: { minutes: 60 } });
    const ctx = buildScoringContext(
      { rules: [r], positions: [target, legLose, legOpen], ledger: [] },
      0,
    );

    // legOpen is still open, so the group has never gone flat: classifyGroup
    // returns null and nothing is added, even though legLose alone realised a
    // loss 30 minutes before the target.
    expect(evaluateRule(r, target, ctx)).toMatchObject({ outcome: 'pass', measured: null });
  });

  it("cooldown_after_loss reads a group's whole sum even when a rule's tag scope matches only one leg", () => {
    const legWinTagged = leg(
      'legWinTagged',
      'g6',
      50,
      '2026-01-04T22:00:00Z',
      '2026-01-05T00:00:00Z',
      [tag('tag-1')],
    );
    const legLoseUntagged = leg(
      'legLoseUntagged',
      'g6',
      -200,
      '2026-01-04T22:30:00Z',
      '2026-01-05T00:50:00Z',
    );
    const target = pos({
      tags: [tag('tag-1')],
      openedAt: '2026-01-05T01:20:00Z',
      createdAt: '2026-01-05T01:20:00Z',
    });
    const r = rule({ type: 'cooldown_after_loss', params: { minutes: 60 } }, { tagId: 'tag-1' });
    const ctx = buildScoringContext(
      { rules: [r], positions: [target, legWinTagged, legLoseUntagged], ledger: [] },
      0,
    );

    // Only legWinTagged carries the rule's tag, but the group's sum (-150,
    // losing) and its flat instant (legLoseUntagged's, the later one) still
    // govern the cooldown — the tag scope cannot truncate it to one leg.
    expect(evaluateRule(r, target, ctx)).toMatchObject({ outcome: 'breach', measured: '30' });
  });

  // Regression guard (retro P10/P12): no existing assertion compares a
  // grouped leg against an otherwise-identical ungrouped one for a rule type
  // task 10 does not change. `max_daily_loss` shares `getPopulation`'s
  // `events`, which must stay summed per leg (design C9, "events stay per
  // leg") even when two of its positions are grouped — this already holds on
  // the current, un-group-aware code and must keep holding.
  it('max_daily_loss sums every leg of a group separately, unaffected by grouping (regression guard)', () => {
    const r = rule({ type: 'max_daily_loss', params: { amount: '1000', currency: 'USD' } });

    const targetUngrouped = pos();
    const otherUngrouped = losingPosition(
      'otherX',
      -50,
      '2026-01-04T20:00:00Z',
      '2026-01-04T23:00:00Z',
    );
    const ctxUngrouped = buildScoringContext(
      { rules: [r], positions: [targetUngrouped, otherUngrouped], ledger: [] },
      0,
    );
    const ungrouped = evaluateRule(r, targetUngrouped, ctxUngrouped);

    const targetGrouped = pos({ groupId: 'gY' });
    const otherGrouped = {
      ...losingPosition('otherX', -50, '2026-01-04T20:00:00Z', '2026-01-04T23:00:00Z'),
      groupId: 'gY',
    };
    const ctxGrouped = buildScoringContext(
      { rules: [r], positions: [targetGrouped, otherGrouped], ledger: [] },
      0,
    );
    const grouped = evaluateRule(r, targetGrouped, ctxGrouped);

    expect(grouped).toEqual(ungrouped);
  });
});
