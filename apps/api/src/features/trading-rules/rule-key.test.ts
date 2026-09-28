import { describe, it, expect } from 'vitest';

import type { TradingRuleDefinition } from '@tradr/shared/schemas/trading-rule';

import { ruleDedupKey } from './rule-key';

describe('ruleDedupKey', () => {
  it('renders "no scope" as its own value, distinct from a scoped rule', () => {
    const def: TradingRuleDefinition = {
      type: 'max_risk_percent',
      params: { percent: '2' },
    };
    const global = ruleDedupKey(def, null, null);
    const scoped = ruleDedupKey(def, 'acc-1', null);

    expect(global).toBe('max_risk_percent|-|-|{"percent":"2"}');
    expect(scoped).toBe('max_risk_percent|acc-1|-|{"percent":"2"}');
    expect(global).not.toBe(scoped);
  });

  it('keeps account and tag scopes in separate positions', () => {
    const def: TradingRuleDefinition = {
      type: 'max_risk_percent',
      params: { percent: '2' },
    };
    expect(ruleDedupKey(def, 'acc-1', null)).not.toBe(ruleDedupKey(def, null, 'acc-1'));
    expect(ruleDedupKey(def, 'acc-1', 'tag-1')).toBe(
      'max_risk_percent|acc-1|tag-1|{"percent":"2"}',
    );
  });

  it('collapses set member order via canonicalisation', () => {
    const a: TradingRuleDefinition = {
      type: 'required_fields',
      params: { fields: ['tag', 'stop_loss', 'notes'] },
    };
    const b: TradingRuleDefinition = {
      type: 'required_fields',
      params: { fields: ['stop_loss', 'notes', 'tag'] },
    };
    expect(ruleDedupKey(a, null, null)).toBe(ruleDedupKey(b, null, null));
  });

  it('collapses trailing-zero decimals via canonicalisation', () => {
    const a: TradingRuleDefinition = {
      type: 'min_risk_reward',
      params: { ratio: '2.50' },
    };
    const b: TradingRuleDefinition = {
      type: 'min_risk_reward',
      params: { ratio: '2.5' },
    };
    expect(ruleDedupKey(a, null, null)).toBe(ruleDedupKey(b, null, null));
  });

  it('keeps the currency inside the key for amount types', () => {
    const usd: TradingRuleDefinition = {
      type: 'max_risk_amount',
      params: { amount: '100', currency: 'USD' },
    };
    const eur: TradingRuleDefinition = {
      type: 'max_risk_amount',
      params: { amount: '100', currency: 'EUR' },
    };
    expect(ruleDedupKey(usd, null, null)).not.toBe(ruleDedupKey(eur, null, null));
  });
});
