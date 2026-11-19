// node — pure functions, no DOM.
//
// Contract (design C8, Requirement 4):
//   markReason(input) -> string | null
//     SC1 (Req 4.3): Pre: input.isGroup is true, or input.groupId is set, and
//       assetType/accountCurrency would also fail the option or currency
//       check. Call: markReason(input). Obs: the group reason wins over the
//       other two. Src: design C8 reason order (1. group, 2. option,
//       3. currency), Requirement 4.3's pinned literal.
//     SC2 (Req 4.2): Pre: not a group, assetType is 'option'. Call:
//       markReason(input). Obs: the option reason. Src: Requirement 4.2's
//       pinned literal.
//     SC6 (design C8/D11 order): Pre: not a group, assetType 'option',
//       accountCurrency not USD. Call: markReason(input). Obs: the option
//       reason wins over the currency reason. Src: design C8 reason order
//       (2 before 3), D11.
//     SC3/D12 (Req 4.4): Pre: not a group, assetType 'stock', accountCurrency
//       'EUR'. Call: markReason(input). Obs: "Quotes are in USD; this
//       account is in EUR", bare code, no trailing stop. Src: Requirement
//       4.4's pinned literal, design D12.
//     SC4 (Req 4.1): Pre: not a group, assetType 'stock', accountCurrency
//       'USD'. Call: markReason(input). Obs: null. Src: Requirement 4.1.
//
//   quoteSymbolsFor(entries) -> string[]
//     SC5 (Req 4.1/4.2/4.3/4.4, folded): Pre: entries mix an eligible single
//       stock row, an option row, a group entry and a non-USD row. Call:
//       quoteSymbolsFor(entries). Obs: only the eligible row's symbol comes
//       back. Src: design C8 interfaces ("returns the symbols of eligible
//       single rows"), task 7 Success ("quoteSymbolsFor returns only the
//       symbols of rows whose reason is null").
import { describe, expect, it } from 'vitest';

import {
  makePosition,
  makePositionGroup,
} from '@/features/positions/__fixtures__/position-fixtures';

import { markReason, quoteSymbolsFor } from './markToMarket';

describe('markReason', () => {
  it('gives the multi-leg reason for a group row even when it is also an option or non-USD', () => {
    const reason = markReason({
      isGroup: true,
      groupId: null,
      assetType: 'option',
      accountCurrency: 'EUR',
    });

    expect(reason).toBe('Multi-leg groups are not marked to market.');
  });

  it('gives the multi-leg reason for a leg with groupId set even when it is also an option or non-USD', () => {
    const reason = markReason({
      isGroup: false,
      groupId: '00000000-0000-4000-a000-000000000200',
      assetType: 'option',
      accountCurrency: 'EUR',
    });

    expect(reason).toBe('Multi-leg groups are not marked to market.');
  });

  it('gives the option reason for a non-group option row', () => {
    const reason = markReason({
      isGroup: false,
      groupId: null,
      assetType: 'option',
      accountCurrency: 'USD',
    });

    expect(reason).toBe('Delayed quotes cover stocks, not option contracts.');
  });

  it('gives the option reason over the currency reason when both apply', () => {
    const reason = markReason({
      isGroup: false,
      groupId: null,
      assetType: 'option',
      accountCurrency: 'EUR',
    });

    expect(reason).toBe('Delayed quotes cover stocks, not option contracts.');
  });

  it('gives the currency reason, with the bare code and no trailing stop, for a non-USD stock row', () => {
    const reason = markReason({
      isGroup: false,
      groupId: null,
      assetType: 'stock',
      accountCurrency: 'EUR',
    });

    expect(reason).toBe('Quotes are in USD; this account is in EUR');
    expect(reason?.endsWith('.')).toBe(false);
  });

  it('gives null for an eligible USD stock row', () => {
    const reason = markReason({
      isGroup: false,
      groupId: null,
      assetType: 'stock',
      accountCurrency: 'USD',
    });

    expect(reason).toBeNull();
  });
});

describe('quoteSymbolsFor', () => {
  it('returns only the symbols of rows whose reason is null', () => {
    const eligible = makePosition({ id: '00000000-0000-4000-a000-000000000401', symbol: 'AAPL' });
    const option = makePosition({
      id: '00000000-0000-4000-a000-000000000402',
      symbol: 'MSFT',
      assetType: 'option',
    });
    const nonUsd = makePosition({
      id: '00000000-0000-4000-a000-000000000403',
      symbol: 'NVDA',
      accountCurrency: 'EUR',
    });
    const group = makePositionGroup({
      legs: [
        {
          ...makePosition({ id: '00000000-0000-4000-a000-000000000404', symbol: 'TSLA' }),
          groupId: '00000000-0000-4000-a000-000000000200',
        },
        {
          ...makePosition({ id: '00000000-0000-4000-a000-000000000405', symbol: 'GOOG' }),
          groupId: '00000000-0000-4000-a000-000000000200',
        },
      ],
    });

    const symbols = quoteSymbolsFor([eligible, option, group, nonUsd]);

    expect(symbols).toEqual(['AAPL']);
  });
});
