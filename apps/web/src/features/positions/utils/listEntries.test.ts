// node — pure functions, no DOM.
//
// Contract (design C12, Requirement 7):
//   flattenEntries(entries) -> PositionListItem[]
//     Pre:  `entries` is a PositionListEntry[] mixing plain items and groups.
//     Call: flattenEntries(entries)
//     Obs:  legs come back in entry order, each entry's legs expanded in
//           place; a plain item passes through unchanged.
//     Src:  design C12 interfaces ("flattenEntries(entries): PositionListItem[]"),
//           task 15 Success ("flattenEntries returns legs in entry order and
//           passes plain items through").
//
//   firstOpenLegId(group) -> string
//     Pre:  `group` is a PositionGroupEntry.
//     Call: firstOpenLegId(group)
//     Obs:  the id of the first leg whose status is 'open', or the first
//           leg's id when none are open.
//     Src:  design C12 interfaces ("firstOpenLegId(group)"), task 15 Success
//           ("firstOpenLegId returns the first open leg, else the first leg").
import { describe, expect, it } from 'vitest';

import {
  makePosition,
  makePositionGroup,
} from '@/features/positions/__fixtures__/position-fixtures';

import { firstOpenLegId, flattenEntries } from './listEntries';

describe('flattenEntries', () => {
  it('expands a group into its legs, in entry order, and passes plain items through unchanged', () => {
    const before = makePosition({ id: '00000000-0000-4000-a000-000000000301', symbol: 'MSFT' });
    const after = makePosition({ id: '00000000-0000-4000-a000-000000000302', symbol: 'NVDA' });
    const legA = {
      ...makePosition({ id: '00000000-0000-4000-a000-000000000311' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const legB = {
      ...makePosition({ id: '00000000-0000-4000-a000-000000000312' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const group = makePositionGroup({ legs: [legA, legB] });

    const result = flattenEntries([before, group, after]);

    expect(result).toEqual([before, legA, legB, after]);
  });
});

describe('firstOpenLegId', () => {
  it('returns the id of the first open leg when one exists', () => {
    const closedLeg = {
      ...makePosition({ id: '00000000-0000-4000-a000-000000000321', status: 'closed' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const openLeg = {
      ...makePosition({ id: '00000000-0000-4000-a000-000000000322', status: 'open' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const group = makePositionGroup({ legs: [closedLeg, openLeg] });

    expect(firstOpenLegId(group)).toBe(openLeg.id);
  });

  it('falls back to the first leg when no leg is open', () => {
    const closedLeg1 = {
      ...makePosition({ id: '00000000-0000-4000-a000-000000000331', status: 'closed' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const closedLeg2 = {
      ...makePosition({ id: '00000000-0000-4000-a000-000000000332', status: 'closed' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const group = makePositionGroup({ legs: [closedLeg1, closedLeg2] });

    expect(firstOpenLegId(group)).toBe(closedLeg1.id);
  });
});
