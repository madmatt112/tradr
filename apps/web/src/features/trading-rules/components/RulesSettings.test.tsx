// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TradingRule } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';

const { rulesState, updateMutate, deleteMutate } = vi.hoisted(() => ({
  rulesState: { current: [] as TradingRule[], isLoading: false, isError: false },
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock('../hooks/useTradingRules', () => ({
  useTradingRules: () => ({
    data: rulesState.current,
    isLoading: rulesState.isLoading,
    isError: rulesState.isError,
  }),
  useUpdateTradingRule: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteTradingRule: () => ({ mutate: deleteMutate, isPending: false }),
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: ACCOUNT_ID, name: 'IBKR Main', currency: 'USD' }] }),
}));

vi.mock('@/features/tags/hooks/useTags', () => ({
  useTags: () => ({ data: [{ id: TAG_ID, name: 'breakout' }] }),
}));

// The dialogs are exercised in their own suites; stub them so this suite stays
// on the list, the empty state and the switch payload.
vi.mock('./RuleDialog', () => ({ RuleDialog: () => null }));
vi.mock('./DeleteRuleDialog', () => ({
  DeleteRuleDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="delete-rule-dialog" /> : null,
}));

import { RulesSettings } from './RulesSettings';

function makeRule(overrides: Partial<TradingRule> = {}): TradingRule {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    definition: { type: 'max_risk_percent', params: { percent: '1' } },
    weight: 'critical',
    enabled: true,
    accountId: null,
    tagId: null,
    description: 'Risk per trade at most 1% of account balance',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  rulesState.current = [];
  rulesState.isLoading = false;
  rulesState.isError = false;
  updateMutate.mockReset();
  deleteMutate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('RulesSettings — list', () => {
  it('renders each rule with its description, weight badge and scope chips', () => {
    rulesState.current = [
      makeRule({
        id: 'a',
        accountId: ACCOUNT_ID,
        tagId: TAG_ID,
        description: 'Risk per trade at most 1% of account balance',
        weight: 'critical',
      }),
      makeRule({
        id: 'b',
        definition: { type: 'max_trades_per_day', params: { count: 3 } },
        description: 'At most 3 trades per day',
        weight: 'nice_to_have',
      }),
    ];
    render(<RulesSettings />);

    expect(screen.getByText('Risk per trade at most 1% of account balance')).toBeTruthy();
    expect(screen.getByText('At most 3 trades per day')).toBeTruthy();
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Nice to have')).toBeTruthy();
    // Scope chips are named from the accounts and tags lists, not the raw ids.
    expect(screen.getByText('IBKR Main')).toBeTruthy();
    expect(screen.getByText('breakout')).toBeTruthy();
  });
});

describe('RulesSettings — empty state', () => {
  it('says rules are scored and never block a trade, with a create control', () => {
    rulesState.current = [];
    render(<RulesSettings />);

    expect(screen.getByText(/Rules are scored and never block a trade/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New rule' })).toBeTruthy();
  });
});

describe('RulesSettings — switch payload', () => {
  it('sends the whole rule with enabled flipped when the switch is toggled', () => {
    const rule = makeRule({
      id: 'c',
      accountId: ACCOUNT_ID,
      tagId: TAG_ID,
      enabled: true,
      weight: 'important',
      definition: { type: 'max_risk_percent', params: { percent: '2' } },
    });
    rulesState.current = [rule];
    render(<RulesSettings />);

    fireEvent.click(screen.getByRole('switch'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      id: 'c',
      data: {
        definition: { type: 'max_risk_percent', params: { percent: '2' } },
        weight: 'important',
        enabled: false,
        accountId: ACCOUNT_ID,
        tagId: TAG_ID,
      },
    });
  });
});
