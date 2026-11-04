// @vitest-environment jsdom
// ProposedPositions — import group proposals (design C15; AC 2.3, 8.8, 8.9).
//
// | Criterion (AC)                                                          | Pre-condition                                                | Test (seam)                                                | Observable result                                                              | Expected-value source |
// | ------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------- |
// | 8.8 — proposals render pre-selected with legs, basis and label          | one groupProposal referencing two legs, not declined           | render(ProposedPositions, { groupProposals })               | leg symbols, `data-basis`, and the detected label all present                   | task 19 Success bullet 1; requirements.md AC 8.8 |
// | 8.8 — with no proposals nothing (group) renders                          | render once with a proposal, once with groupProposals: []      | render(ProposedPositions, { groupProposals })                | the section appears with a proposal, is absent when groupProposals: []           | task 19 Success bullet 4 |
// | 8.8/8.9 — declining one sends its id                                     | one groupProposal, onDecline spy                               | click the decline control                                   | onDecline called with the proposal id                                           | requirements.md AC 8.8 "decline"; AC 8.9 "carry the declined proposal ids" |
// | 2.3/8.9 — editing a label sends it                                       | one groupProposal, onLabelChange spy                           | change the label input's value                              | onLabelChange called with (proposal id, new text)                               | requirements.md AC 2.3 "replace it" |
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GroupProposal, ProposedPosition } from '@tradr/shared';

import { ProposedPositions } from './ProposedPositions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

const LEG_A: ProposedPosition = {
  scope: { symbol: 'AAPL260320C250', assetType: 'option' },
  side: 'long',
  closes: false,
  fills: [
    {
      type: 'entry',
      price: '5.00',
      quantity: '1',
      fees: '0',
      filledAt: '2026-05-01T14:30:00Z',
      sourceRow: 2,
    },
  ],
};

const LEG_B: ProposedPosition = {
  scope: { symbol: 'AAPL260320C260', assetType: 'option' },
  side: 'short',
  closes: false,
  fills: [
    {
      type: 'entry',
      price: '2.00',
      quantity: '1',
      fees: '0',
      filledAt: '2026-05-01T14:31:00Z',
      sourceRow: 3,
    },
  ],
};

const PROPOSAL: GroupProposal = { id: 'g1', legRefs: [0, 1], label: 'BCS', basis: 'order_id' };

describe('ProposedPositions — group proposals', () => {
  it('renders a proposal pre-selected with its leg names, basis and label (AC 8.8, 2.3)', () => {
    render(
      <ProposedPositions
        positions={[LEG_A, LEG_B]}
        errors={[]}
        warnings={[]}
        currencyCode="USD"
        groupProposals={[PROPOSAL]}
      />,
    );

    const legs = screen.getByTestId('group-proposal-legs-g1');
    expect(legs.textContent).toContain('AAPL260320C250');
    expect(legs.textContent).toContain('AAPL260320C260');

    const basis = screen.getByTestId('group-proposal-basis-g1');
    expect(basis.getAttribute('data-basis')).toBe('order_id');

    const label = screen.getByTestId('group-proposal-label-g1') as HTMLInputElement;
    expect(label.value).toBe('BCS');

    // pre-selected: the control still reads "Decline", not "Include" / "Declined".
    const decline = screen.getByTestId('group-proposal-decline-g1');
    expect(decline.textContent).toBe('Decline');
  });

  it('renders the group-proposals section when proposals exist, and nothing when they do not (AC 8.8)', () => {
    const { unmount } = render(
      <ProposedPositions
        positions={[LEG_A, LEG_B]}
        errors={[]}
        warnings={[]}
        currencyCode="USD"
        groupProposals={[PROPOSAL]}
      />,
    );
    expect(screen.getByTestId('group-proposals')).not.toBeNull();
    unmount();

    render(
      <ProposedPositions
        positions={[LEG_A, LEG_B]}
        errors={[]}
        warnings={[]}
        currencyCode="USD"
        groupProposals={[]}
      />,
    );
    expect(screen.queryByTestId('group-proposals')).toBeNull();
    expect(screen.queryByTestId(/^group-proposal-/)).toBeNull();
  });

  it('calls onDecline with the proposal id when the decline control is used (AC 8.8/8.9)', () => {
    const onDecline = vi.fn();
    render(
      <ProposedPositions
        positions={[LEG_A, LEG_B]}
        errors={[]}
        warnings={[]}
        currencyCode="USD"
        groupProposals={[PROPOSAL]}
        onDecline={onDecline}
      />,
    );

    fireEvent.click(screen.getByTestId('group-proposal-decline-g1'));

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledWith('g1');
  });

  it('calls onLabelChange with the proposal id and new text when the label is edited (AC 2.3)', () => {
    const onLabelChange = vi.fn();
    render(
      <ProposedPositions
        positions={[LEG_A, LEG_B]}
        errors={[]}
        warnings={[]}
        currencyCode="USD"
        groupProposals={[PROPOSAL]}
        onLabelChange={onLabelChange}
      />,
    );

    fireEvent.change(screen.getByTestId('group-proposal-label-g1'), {
      target: { value: 'My Spread' },
    });

    expect(onLabelChange).toHaveBeenCalledWith('g1', 'My Spread');
  });
});
