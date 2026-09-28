import Decimal from 'decimal.js';

import {
  DIRECTION_VALUES,
  MARKET_VALUES,
  REQUIRED_FIELD_VALUES,
  type TradingRuleDefinition,
} from '../schemas/trading-rule';

import { WEEKDAY_LABELS } from './breakdown';

// Pure helpers over a `TradingRuleDefinition` (design C1). This module is not
// re-exported from the barrel (D2): callers import it by path.

// Human labels for the list-parameter tokens. `describeRule` renders type and
// parameters only — never an account or tag name (D6).
const REQUIRED_FIELD_LABELS: Record<(typeof REQUIRED_FIELD_VALUES)[number], string> = {
  stop_loss: 'a stop loss',
  target_price: 'a target price',
  notes: 'notes',
  tag: 'at least one tag',
};

const MARKET_LABELS: Record<(typeof MARKET_VALUES)[number], string> = {
  stock: 'stocks',
  option: 'options',
};

const DIRECTION_LABELS: Record<(typeof DIRECTION_VALUES)[number], string> = {
  long: 'long',
  short: 'short',
};

// Keep only the members of `set`, in the constant order of `order`.
function orderSet<T extends string | number>(order: readonly T[], set: readonly T[]): T[] {
  return order.filter((member) => set.includes(member));
}

// A generated, human-readable one-line description of a rule (D6). It names the
// type and its parameters only; the weight and scope render beside it in the UI.
export function describeRule(definition: TradingRuleDefinition): string {
  switch (definition.type) {
    case 'max_risk_percent':
      return `Risk per trade at most ${definition.params.percent}% of account balance`;
    case 'max_risk_amount':
      return `Risk per trade at most ${definition.params.amount} ${definition.params.currency}`;
    case 'max_position_size':
      return `Position size at most ${definition.params.amount} ${definition.params.currency}`;
    case 'min_risk_reward':
      return `Reward-to-risk at least ${definition.params.ratio}`;
    case 'max_daily_loss':
      return `Daily loss at most ${definition.params.amount} ${definition.params.currency}`;
    case 'max_weekly_loss':
      return `Weekly loss at most ${definition.params.amount} ${definition.params.currency}`;
    case 'max_total_exposure':
      return `Total open exposure at most ${definition.params.amount} ${definition.params.currency}`;
    case 'required_fields':
      return `Requires ${orderSet(REQUIRED_FIELD_VALUES, definition.params.fields)
        .map((field) => REQUIRED_FIELD_LABELS[field])
        .join(', ')}`;
    case 'allowed_markets':
      return `Only ${orderSet(MARKET_VALUES, definition.params.markets)
        .map((market) => MARKET_LABELS[market])
        .join(' and ')}`;
    case 'allowed_directions':
      return `Only ${orderSet(DIRECTION_VALUES, definition.params.directions)
        .map((direction) => DIRECTION_LABELS[direction])
        .join(' and ')} trades`;
    case 'no_trading_days':
      return `No trading on ${[...definition.params.weekdays]
        .sort((a, b) => a - b)
        .map((weekday) => WEEKDAY_LABELS[weekday])
        .join(', ')}`;
    case 'max_trades_per_day':
      return `At most ${definition.params.count} trade${definition.params.count === 1 ? '' : 's'} per day`;
    case 'cooldown_after_loss':
      return `Wait ${definition.params.minutes} minute${definition.params.minutes === 1 ? '' : 's'} after a loss`;
  }
}

function canonicalDecimal(value: string): string {
  return new Decimal(value).toString();
}

// Normalise a definition for the dedup key: decimals through
// `new Decimal(x).toString()` (so `2.50` and `2.5` collapse) and set members in
// constant order (so member order never doubles a rule). Counts, minutes and the
// currency pass through unchanged.
export function canonicalDefinition(definition: TradingRuleDefinition): TradingRuleDefinition {
  switch (definition.type) {
    case 'max_risk_percent':
      return { ...definition, params: { percent: canonicalDecimal(definition.params.percent) } };
    case 'min_risk_reward':
      return { ...definition, params: { ratio: canonicalDecimal(definition.params.ratio) } };
    case 'max_risk_amount':
    case 'max_position_size':
    case 'max_daily_loss':
    case 'max_weekly_loss':
    case 'max_total_exposure':
      return {
        ...definition,
        params: {
          amount: canonicalDecimal(definition.params.amount),
          currency: definition.params.currency,
        },
      };
    case 'required_fields':
      return {
        ...definition,
        params: { fields: orderSet(REQUIRED_FIELD_VALUES, definition.params.fields) },
      };
    case 'allowed_markets':
      return {
        ...definition,
        params: { markets: orderSet(MARKET_VALUES, definition.params.markets) },
      };
    case 'allowed_directions':
      return {
        ...definition,
        params: { directions: orderSet(DIRECTION_VALUES, definition.params.directions) },
      };
    case 'no_trading_days':
      return {
        ...definition,
        params: { weekdays: [...definition.params.weekdays].sort((a, b) => a - b) },
      };
    case 'max_trades_per_day':
    case 'cooldown_after_loss':
      return { ...definition };
  }
}
