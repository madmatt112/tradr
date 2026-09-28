// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { handleTradingRuleMutationError, tradingRulesListQuery } from './useTradingRules';

// ---------------------------------------------------------------------------
// handleTradingRuleMutationError — the shared onError for the rule mutations.
//   - the two inline 409 codes render in place, so no toast
//   - every other error toasts the envelope message (or the fallback)
//   - 401 short-circuits before any toast (the api module already redirected)
// ---------------------------------------------------------------------------

describe('handleTradingRuleMutationError', () => {
  it('suppresses the toast for both inline codes', () => {
    for (const code of ['TRADING_RULE_LIMIT_REACHED', 'TRADING_RULE_DUPLICATE']) {
      const showToast = vi.fn();
      handleTradingRuleMutationError(
        { status: 409, error: { code, message: 'nope' } },
        showToast,
        'fb',
      );
      expect(showToast).not.toHaveBeenCalled();
    }
  });

  it('toasts the envelope message for any other error', () => {
    const showToast = vi.fn();
    handleTradingRuleMutationError(
      { status: 400, error: { code: 'VALIDATION_ERROR', message: 'Bad input' } },
      showToast,
      'fb',
    );
    expect(showToast).toHaveBeenCalledWith('Bad input');
  });

  it('falls back when no envelope message is available', () => {
    const showToast = vi.fn();
    handleTradingRuleMutationError(new Error('network down'), showToast, 'Failed to create rule');
    expect(showToast).toHaveBeenCalledWith('Failed to create rule');
  });

  it('returns early on a 401 without toasting', () => {
    const showToast = vi.fn();
    handleTradingRuleMutationError({ error: { code: 'UNAUTHORIZED' } }, showToast, 'fb');
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('tradingRulesListQuery', () => {
  it('keys ["trading-rules", "list"]', () => {
    expect(tradingRulesListQuery().queryKey).toEqual(['trading-rules', 'list']);
  });
});
