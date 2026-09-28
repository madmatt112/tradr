import { describe, expect, it } from 'vitest';

import { canonicalDefinition, describeRule } from '../lib/trading-rules';

import {
  TRADING_RULE_TYPES,
  TradingRuleDefinitionSchema,
  TradingRuleInputSchema,
  type TradingRuleDefinition,
  type TradingRuleType,
} from './trading-rule';

// A valid definition for every type, reused by the describeRule and input tests.
const VALID_DEFINITIONS: Record<TradingRuleType, TradingRuleDefinition> = {
  max_risk_percent: { type: 'max_risk_percent', params: { percent: '2' } },
  max_risk_amount: { type: 'max_risk_amount', params: { amount: '500', currency: 'USD' } },
  max_position_size: { type: 'max_position_size', params: { amount: '10000', currency: 'USD' } },
  min_risk_reward: { type: 'min_risk_reward', params: { ratio: '2' } },
  max_daily_loss: { type: 'max_daily_loss', params: { amount: '300', currency: 'USD' } },
  max_weekly_loss: { type: 'max_weekly_loss', params: { amount: '1000', currency: 'USD' } },
  max_total_exposure: { type: 'max_total_exposure', params: { amount: '50000', currency: 'USD' } },
  required_fields: { type: 'required_fields', params: { fields: ['stop_loss', 'notes'] } },
  allowed_markets: { type: 'allowed_markets', params: { markets: ['stock'] } },
  allowed_directions: { type: 'allowed_directions', params: { directions: ['long'] } },
  no_trading_days: { type: 'no_trading_days', params: { weekdays: [0, 6] } },
  max_trades_per_day: { type: 'max_trades_per_day', params: { count: 5 } },
  cooldown_after_loss: { type: 'cooldown_after_loss', params: { minutes: 60 } },
};

function accepts(definition: unknown): boolean {
  return TradingRuleDefinitionSchema.safeParse(definition).success;
}

describe('TradingRuleDefinitionSchema — percent and ratio bounds', () => {
  it('accepts a value above 0, at most 100, with at most two decimals', () => {
    expect(accepts({ type: 'max_risk_percent', params: { percent: '0.01' } })).toBe(true);
    expect(accepts({ type: 'max_risk_percent', params: { percent: '2.5' } })).toBe(true);
    expect(accepts({ type: 'max_risk_percent', params: { percent: '100' } })).toBe(true);
    expect(accepts({ type: 'min_risk_reward', params: { ratio: '0.01' } })).toBe(true);
    expect(accepts({ type: 'min_risk_reward', params: { ratio: '100' } })).toBe(true);
  });

  it('rejects 0, above 100, three decimals or a sign', () => {
    expect(accepts({ type: 'max_risk_percent', params: { percent: '0' } })).toBe(false);
    expect(accepts({ type: 'max_risk_percent', params: { percent: '100.01' } })).toBe(false);
    expect(accepts({ type: 'max_risk_percent', params: { percent: '2.555' } })).toBe(false);
    expect(accepts({ type: 'max_risk_percent', params: { percent: '-5' } })).toBe(false);
    expect(accepts({ type: 'min_risk_reward', params: { ratio: '0' } })).toBe(false);
    expect(accepts({ type: 'min_risk_reward', params: { ratio: '1.234' } })).toBe(false);
    expect(accepts({ type: 'min_risk_reward', params: { ratio: '150' } })).toBe(false);
  });
});

describe('TradingRuleDefinitionSchema — count and minutes bounds', () => {
  it('accepts the integer bounds', () => {
    expect(accepts({ type: 'max_trades_per_day', params: { count: 1 } })).toBe(true);
    expect(accepts({ type: 'max_trades_per_day', params: { count: 1000 } })).toBe(true);
    expect(accepts({ type: 'cooldown_after_loss', params: { minutes: 1 } })).toBe(true);
    expect(accepts({ type: 'cooldown_after_loss', params: { minutes: 10080 } })).toBe(true);
  });

  it('rejects out-of-range or non-integer values', () => {
    expect(accepts({ type: 'max_trades_per_day', params: { count: 0 } })).toBe(false);
    expect(accepts({ type: 'max_trades_per_day', params: { count: 1001 } })).toBe(false);
    expect(accepts({ type: 'max_trades_per_day', params: { count: 1.5 } })).toBe(false);
    expect(accepts({ type: 'cooldown_after_loss', params: { minutes: 0 } })).toBe(false);
    expect(accepts({ type: 'cooldown_after_loss', params: { minutes: 10081 } })).toBe(false);
  });
});

describe('TradingRuleDefinitionSchema — weekday set', () => {
  it('accepts a proper non-empty subset', () => {
    expect(accepts({ type: 'no_trading_days', params: { weekdays: [0] } })).toBe(true);
    expect(accepts({ type: 'no_trading_days', params: { weekdays: [1, 2, 3, 4, 5, 6] } })).toBe(
      true,
    );
  });

  it('rejects empty, all seven, duplicate or out-of-range weekdays', () => {
    expect(accepts({ type: 'no_trading_days', params: { weekdays: [] } })).toBe(false);
    expect(accepts({ type: 'no_trading_days', params: { weekdays: [0, 1, 2, 3, 4, 5, 6] } })).toBe(
      false,
    );
    expect(accepts({ type: 'no_trading_days', params: { weekdays: [1, 1] } })).toBe(false);
    expect(accepts({ type: 'no_trading_days', params: { weekdays: [7] } })).toBe(false);
  });
});

describe('TradingRuleDefinitionSchema — amount digits per currency', () => {
  it('accepts USD to two decimals and JPY to zero', () => {
    expect(accepts({ type: 'max_risk_amount', params: { amount: '10.50', currency: 'USD' } })).toBe(
      true,
    );
    expect(accepts({ type: 'max_risk_amount', params: { amount: '10', currency: 'JPY' } })).toBe(
      true,
    );
  });

  it('rejects too many fraction digits with an issue at definition.params.amount', () => {
    const usd = TradingRuleInputSchema.safeParse({
      definition: { type: 'max_risk_amount', params: { amount: '10.555', currency: 'USD' } },
      weight: 'critical',
      enabled: true,
      accountId: null,
      tagId: null,
    });
    expect(usd.success).toBe(false);
    if (!usd.success) {
      expect(usd.error.issues.some((i) => i.path.join('.') === 'definition.params.amount')).toBe(
        true,
      );
    }

    const jpy = TradingRuleInputSchema.safeParse({
      definition: { type: 'max_position_size', params: { amount: '10.5', currency: 'JPY' } },
      weight: 'important',
      enabled: true,
      accountId: null,
      tagId: null,
    });
    expect(jpy.success).toBe(false);
    if (!jpy.success) {
      expect(jpy.error.issues.some((i) => i.path.join('.') === 'definition.params.amount')).toBe(
        true,
      );
    }
  });

  it('rejects an unsupported currency code', () => {
    expect(accepts({ type: 'max_risk_amount', params: { amount: '10', currency: 'ZZZ' } })).toBe(
      false,
    );
  });
});

describe('TradingRuleDefinitionSchema — strict keys and set members', () => {
  it('rejects an unknown key in params or on the arm', () => {
    expect(accepts({ type: 'max_risk_percent', params: { percent: '2', extra: 1 } })).toBe(false);
    expect(accepts({ type: 'max_risk_percent', params: { percent: '2' }, junk: true })).toBe(false);
  });

  it('rejects empty, duplicate or unknown set members', () => {
    expect(accepts({ type: 'required_fields', params: { fields: [] } })).toBe(false);
    expect(accepts({ type: 'required_fields', params: { fields: ['notes', 'notes'] } })).toBe(
      false,
    );
    expect(accepts({ type: 'required_fields', params: { fields: ['bogus'] } })).toBe(false);
    expect(accepts({ type: 'required_fields', params: { fields: ['stop_loss', 'notes'] } })).toBe(
      true,
    );
  });
});

describe('describeRule', () => {
  it('renders one non-empty, distinct string per type', () => {
    const descriptions = TRADING_RULE_TYPES.map((type) => describeRule(VALID_DEFINITIONS[type]));
    expect(descriptions).toHaveLength(TRADING_RULE_TYPES.length);
    expect(descriptions.every((d) => d.length > 0)).toBe(true);
    expect(new Set(descriptions).size).toBe(TRADING_RULE_TYPES.length);
  });

  it('names type and parameters', () => {
    expect(describeRule({ type: 'max_risk_percent', params: { percent: '2' } })).toBe(
      'Risk per trade at most 2% of account balance',
    );
    expect(describeRule({ type: 'no_trading_days', params: { weekdays: [6, 0] } })).toBe(
      'No trading on Sunday, Saturday',
    );
  });
});

describe('canonicalDefinition', () => {
  it('strips trailing zeros from decimals', () => {
    expect(canonicalDefinition({ type: 'max_risk_percent', params: { percent: '2.50' } })).toEqual({
      type: 'max_risk_percent',
      params: { percent: '2.5' },
    });
    expect(
      canonicalDefinition({
        type: 'max_risk_amount',
        params: { amount: '10.00', currency: 'USD' },
      }),
    ).toEqual({ type: 'max_risk_amount', params: { amount: '10', currency: 'USD' } });
  });

  it('orders set members into constant order', () => {
    expect(
      canonicalDefinition({
        type: 'required_fields',
        params: { fields: ['notes', 'tag', 'stop_loss'] },
      }),
    ).toEqual({ type: 'required_fields', params: { fields: ['stop_loss', 'notes', 'tag'] } });
    expect(
      canonicalDefinition({ type: 'allowed_markets', params: { markets: ['option', 'stock'] } }),
    ).toEqual({ type: 'allowed_markets', params: { markets: ['stock', 'option'] } });
    expect(
      canonicalDefinition({ type: 'no_trading_days', params: { weekdays: [3, 1, 5] } }),
    ).toEqual({ type: 'no_trading_days', params: { weekdays: [1, 3, 5] } });
  });
});
