// @vitest-environment jsdom
// ProposedEvents — the preview list of proposed lifecycle events and their
// settlement targets (design C12/TD10; AC 10.2).
//
// | Criterion (AC)                                                    | Pre-condition                                                              | Test (seam)                     | Observable result                                                                 | Expected-value source |
// | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
// | 10.2 — preview shows each proposed event and its target leg          | two events: one targeting a same-file segment, one targeting an open leg      | render(ProposedEvents, { events }) | both events' outcome and resolved target (segment's symbol / open leg's position id) appear | task 21 Success "two events render with outcome and target"; requirements.md AC 10.2 |
// | 10.2 — with no events, nothing renders                               | events: []                                                                    | render(ProposedEvents, { events }) | the component renders nothing                                                       | task 21 Success "with none nothing renders"; IssueList.tsx:24-25 (leveraged empty-state pattern) |
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProposedEvent, ProposedPosition } from '@tradr/shared';

import { ProposedEvents } from './ProposedEvents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

const SEGMENT_TARGET_POSITION: ProposedPosition = {
  scope: { symbol: 'AAPL260320C250', assetType: 'option' },
  side: 'short',
  closes: false,
  fills: [
    {
      type: 'entry',
      price: '5.00',
      quantity: '1',
      fees: '0.65',
      filledAt: '2026-03-01',
      sourceRow: 2,
    },
  ],
};

const OPEN_LEG_POSITION_ID = '11111111-1111-1111-1111-111111111111';

const ASSIGNED_EVENT: ProposedEvent = {
  rowNumber: 5,
  outcome: 'assigned',
  symbol: 'AAPL260320C250',
  quantity: '1',
  settledAt: '2026-03-20',
  fees: '0.65',
  target: { kind: 'segment', segmentRef: 0 },
};

const EXERCISED_EVENT: ProposedEvent = {
  rowNumber: 9,
  outcome: 'exercised',
  symbol: 'MSFT260117C300',
  quantity: '2',
  settledAt: '2026-01-17',
  fees: '1.30',
  target: { kind: 'open_leg', positionId: OPEN_LEG_POSITION_ID },
};

describe('ProposedEvents', () => {
  it('renders each event with its outcome and resolved target (AC 10.2)', () => {
    render(
      <ProposedEvents
        events={[ASSIGNED_EVENT, EXERCISED_EVENT]}
        positions={[SEGMENT_TARGET_POSITION]}
      />,
    );

    expect(screen.getByText(/assigned/i)).not.toBeNull();
    expect(screen.getByText(/exercised/i)).not.toBeNull();

    // Segment-kind target resolves to the same-file position it will settle.
    expect(screen.getAllByText('AAPL260320C250').length).toBeGreaterThan(0);
    // Open-leg-kind target names the existing position it will settle.
    expect(screen.getAllByText(new RegExp(OPEN_LEG_POSITION_ID)).length).toBeGreaterThan(0);
  });

  it('renders nothing when there are no proposed events (AC 10.2)', () => {
    const { container } = render(<ProposedEvents events={[]} positions={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
