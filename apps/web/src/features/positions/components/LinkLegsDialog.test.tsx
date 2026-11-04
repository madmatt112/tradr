// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePosition, makePositionGroup } from '@/features/positions/__fixtures__/position-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * | --- | --- | --- | --- | --- |
 * | Lists only ungrouped, non-draft positions of the same account and underlying | `usePositions` returns a matching candidate plus a wrong-underlying, a draft, a wrong-account and an already-grouped entry | render(LinkLegsDialog) | only the matching candidate's row renders | requirements.md AC 1.4; design.md C13 "listing same-account, same-underlying candidates... ungrouped non-drafts"; tasks.md task 18 Prompt "the dialog lists only ungrouped non-draft positions of the same account and underlying" |
 * | Calls link for an ungrouped viewed position | viewed position has no `groupId` | click the matching candidate's Link control | `useLinkPositions`'s mutate is called with `{ positionIds: [viewedId, candidateId] }` | requirements.md AC 1.4; tasks.md task 18 Prompt "it calls link for an ungrouped position" |
 * | Calls add for a viewed position that already has a group | viewed position carries a `groupId` | click the matching candidate's control | `useAddGroupLeg` is called with that groupId, and its mutate is called with `{ positionId: candidateId }` | requirements.md AC 1.4; design.md C13 "it calls link, or add when the position already has a group"; tasks.md task 18 Prompt "add for a grouped one" |
 * | A draft position offers no link control | viewed position status 'draft' | render(LinkLegsDialog) | no candidate row and no link-type button render | design.md C13 "opened from the detail page of a non-draft position"; tasks.md task 18 Prompt "a draft position offers no link control" |
 */

const h = vi.hoisted(() => ({
  linkMutate: vi.fn(),
  addMutate: vi.fn(),
}));

vi.mock('../hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('../hooks/usePositionGroups', () => ({
  useLinkPositions: vi.fn(() => ({ mutate: h.linkMutate, isPending: false })),
  useAddGroupLeg: vi.fn(() => ({ mutate: h.addMutate, isPending: false })),
}));

import { useAddGroupLeg } from '../hooks/usePositionGroups';
import { usePositions } from '../hooks/usePositions';

import { LinkLegsDialog } from './LinkLegsDialog';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000010';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-a000-000000000099';

type ViewedPosition = {
  id: string;
  accountId: string;
  symbol: string;
  assetType: 'stock' | 'option';
  status: 'draft' | 'open' | 'closed';
  groupId: string | null;
};

const VIEWED: ViewedPosition = {
  id: 'viewed-1',
  accountId: ACCOUNT_ID,
  symbol: 'AAPL',
  assetType: 'stock',
  status: 'open',
  groupId: null,
};

function candidate(overrides: Parameters<typeof makePosition>[0] = {}) {
  return makePosition({
    accountId: ACCOUNT_ID,
    assetType: 'stock',
    symbol: 'AAPL',
    status: 'open',
    ...overrides,
  });
}

function mockPositions(data: unknown[]) {
  vi.mocked(usePositions).mockReturnValue({ data, isLoading: false } as unknown as ReturnType<
    typeof usePositions
  >);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(overrides: Partial<{ position: ViewedPosition }> = {}) {
  return render(
    <LinkLegsDialog position={overrides.position ?? VIEWED} open onOpenChange={vi.fn()} />,
  );
}

describe('LinkLegsDialog — candidate filtering', () => {
  it('lists only ungrouped, non-draft positions in the same account and underlying', () => {
    const matching = candidate({ id: 'cand-match' });
    const wrongUnderlying = candidate({ id: 'cand-wrong-u', symbol: 'MSFT' });
    const draftCandidate = candidate({ id: 'cand-draft', status: 'draft' });
    const wrongAccount = candidate({ id: 'cand-wrong-a', accountId: OTHER_ACCOUNT_ID });
    const groupedEntry = makePositionGroup({
      id: 'grp-1',
      accountId: ACCOUNT_ID,
      underlying: 'AAPL',
    });

    mockPositions([matching, wrongUnderlying, draftCandidate, wrongAccount, groupedEntry]);

    renderDialog();

    expect(screen.getByTestId('candidate-cand-match')).toBeTruthy();
    expect(screen.queryByTestId('candidate-cand-wrong-u')).toBeNull();
    expect(screen.queryByTestId('candidate-cand-draft')).toBeNull();
    expect(screen.queryByTestId('candidate-cand-wrong-a')).toBeNull();
    expect(screen.queryByTestId('candidate-grp-1')).toBeNull();
  });
});

describe('LinkLegsDialog — linking an ungrouped position', () => {
  it('calls link with both position ids', () => {
    mockPositions([candidate({ id: 'cand-match' })]);

    renderDialog({ position: { ...VIEWED, groupId: null } });

    fireEvent.click(
      within(screen.getByTestId('candidate-cand-match')).getByRole('button', { name: /link/i }),
    );

    expect(h.linkMutate).toHaveBeenCalledWith({ positionIds: ['viewed-1', 'cand-match'] });
  });
});

describe('LinkLegsDialog — adding to an existing group', () => {
  it('calls add on the viewed position group with the candidate id', () => {
    mockPositions([candidate({ id: 'cand-match' })]);

    renderDialog({ position: { ...VIEWED, groupId: 'group-9' } });

    fireEvent.click(
      within(screen.getByTestId('candidate-cand-match')).getByRole('button', { name: /link|add/i }),
    );

    expect(useAddGroupLeg).toHaveBeenCalledWith('group-9');
    expect(h.addMutate).toHaveBeenCalledWith({ positionId: 'cand-match' });
    expect(h.linkMutate).not.toHaveBeenCalled();
  });
});

describe('LinkLegsDialog — a draft viewed position', () => {
  it('offers no link control', () => {
    mockPositions([candidate({ id: 'cand-match' })]);

    renderDialog({ position: { ...VIEWED, status: 'draft' } });

    expect(screen.queryByTestId('candidate-cand-match')).toBeNull();
    expect(screen.queryByRole('button', { name: /link/i })).toBeNull();
  });
});
