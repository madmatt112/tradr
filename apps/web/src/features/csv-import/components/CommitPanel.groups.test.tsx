// @vitest-environment jsdom
// CommitPanel — forwarding the import group choices and reporting groups
// created (design C15; AC 8.9).
//
// | Criterion (AC)                                                 | Pre-condition                                              | Test (seam)                                    | Observable result                                                        | Expected-value source |
// | ---------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- | ---------------------- |
// | 8.9 — commit carries the declined ids and label overrides       | declinedProposalIds/labelOverrides props set, click Confirm  | click "Confirm import"                          | commit.mutate called with declinedProposalIds and labelOverrides included   | requirements.md AC 8.9 "CsvCommitRequestSchema SHALL carry the declined proposal ids" |
// | 8.9 — summary shows groups created when above 0, absent reads as 0 | render once with groupsCreated=2, once omitted            | render(CommitPanel)                             | the groups-created line reports 2, then is absent                           | task 19 Success bullet 5 + "reading an absent count as 0" |
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CsvCommitResponse, CsvPreviewResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const commitState = vi.hoisted(() => ({
  current: {
    mutate: vi.fn(),
    isPending: false,
    data: undefined as unknown,
    error: null as unknown,
  },
}));

vi.mock('../hooks/useCsvCommit', () => ({
  useCsvCommit: () => commitState.current,
}));

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: undefined }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CommitPanel } from './CommitPanel';

afterEach(() => {
  cleanup();
});

const PREVIEW = {
  token: '33333333-3333-4333-a333-333333333333',
  committable: true,
  requiresDuplicateAffirmation: false,
} as unknown as CsvPreviewResponse;

function commitResult(overrides: Partial<CsvCommitResponse> = {}): CsvCommitResponse {
  return {
    positionsCreated: 2,
    fillsCreated: 2,
    positionIds: ['11111111-1111-4111-a111-111111111111'],
    accountId: '22222222-2222-4222-a222-222222222222',
    ...overrides,
  };
}

beforeEach(() => {
  commitState.current = { mutate: vi.fn(), isPending: false, data: undefined, error: null };
});

describe('CommitPanel — group choices and summary', () => {
  it('forwards declinedProposalIds and labelOverrides into the commit request (AC 8.9)', () => {
    render(
      <CommitPanel
        preview={PREVIEW}
        onRePreview={() => {}}
        isRePreviewing={false}
        declinedProposalIds={['g1']}
        labelOverrides={{ g2: 'My Spread' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    expect(commitState.current.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        token: PREVIEW.token,
        declinedProposalIds: ['g1'],
        labelOverrides: { g2: 'My Spread' },
      }),
    );
  });

  it('shows the groups-created count when above 0, and omits it when absent (reads as 0) (AC 8.9)', () => {
    commitState.current.data = commitResult({ groupsCreated: 2 });
    const { unmount } = render(
      <CommitPanel preview={PREVIEW} onRePreview={() => {}} isRePreviewing={false} />,
    );
    expect(screen.getByTestId('groups-created').textContent).toContain('2');
    unmount();

    commitState.current.data = commitResult();
    render(<CommitPanel preview={PREVIEW} onRePreview={() => {}} isRePreviewing={false} />);
    expect(screen.queryByTestId('groups-created')).toBeNull();
  });
});
