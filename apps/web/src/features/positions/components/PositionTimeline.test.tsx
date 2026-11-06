// @vitest-environment jsdom
//
// PositionTimeline (design C10, D17; Requirement 8): renders the merged
// history `utils/timeline.ts` builds from the detail's fills, settlements,
// roll chain and entry Greeks, linking the stock rows and chain legs the
// detail carries.
//
// Contract block — one row per success criterion this file covers (task 25).
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | A settlement entry links its stock row, and a stock row's entry links its leg (AC 8.1) | viewed from the leg: one settlement detail with `role: 'leg'`, `stockPositionIds: [STOCK_ID]`; viewed from the stock row: one settlement detail with `role: 'stock_exit'`, `legPositionId: LEG_ID` | render(&lt;PositionTimeline position={...} /&gt;), once per view | the leg's render carries a link to `/positions/STOCK_ID`; the stock row's render carries a link to `/positions/LEG_ID` | requirements.md AC 8.1; design.md Data Models "a leg's entry links its stock rows and a stock row's entry links the leg" |
// | Chain legs link and the net credit shows | a rollChain with two legs (the viewed leg and another) and `netCredit: 500` | render(&lt;PositionTimeline position={...} /&gt;) | a link to the other leg's position id is present, and a figure containing "500" is rendered | task 25 Success ("chain legs link and net credit shows"); design.md C6 "Req 5.3's example gives 500" |
// | A chain capture shows its capture date | entryGreeks with `source: 'chain'` and `capturedAt` in 2031, alongside a fill dated 2020 | render(&lt;PositionTimeline position={...} /&gt;) | the rendered output contains "2031" (the capture year), not just the fill's 2020 | design.md C7 "the timeline labels it by captured_at, not as entry-time Greeks"; task 25 Success |
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EntryGreeksDetail, Fill, PositionSettlementDetail, RollChain } from '@tradr/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

import { PositionTimeline } from './PositionTimeline';

interface TimelinePosition {
  id: string;
  fills: Fill[];
  settlements?: PositionSettlementDetail[];
  rollChain?: RollChain;
  entryGreeks?: EntryGreeksDetail;
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    id: 'fill-1',
    positionId: 'pos-1',
    type: 'entry',
    price: '150.00000000',
    quantity: '1.00000000',
    fees: '0.00000000',
    notes: null,
    filledAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePosition(overrides: Partial<TimelinePosition> = {}): TimelinePosition {
  return {
    id: 'pos-1',
    fills: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('PositionTimeline — AC 8.1 settlement links', () => {
  it("links a settlement entry to its stock row, and a stock row's entry to its leg", () => {
    const LEG_ID = 'leg-00000000-0001';
    const STOCK_ID = 'stock-00000000-0002';

    const legView = makePosition({
      id: LEG_ID,
      settlements: [
        {
          settlementId: 'settlement-1',
          outcome: 'assigned',
          premium: 120,
          quantity: 1,
          settledAt: '2026-03-01T00:00:00.000Z',
          createdAt: '2026-03-01T00:00:00.000Z',
          role: 'leg',
          legPositionId: LEG_ID,
          stockPositionIds: [STOCK_ID],
        },
      ],
    });

    const { unmount } = render(<PositionTimeline position={legView} />);
    expect(document.querySelector(`a[href="/positions/${STOCK_ID}"]`)).toBeTruthy();
    unmount();

    const stockView = makePosition({
      id: STOCK_ID,
      settlements: [
        {
          settlementId: 'settlement-1',
          outcome: 'assigned',
          premium: 120,
          quantity: 1,
          settledAt: '2026-03-01T00:00:00.000Z',
          createdAt: '2026-03-01T00:00:00.000Z',
          role: 'stock_exit',
          legPositionId: LEG_ID,
          stockPositionIds: [STOCK_ID],
        },
      ],
    });

    render(<PositionTimeline position={stockView} />);
    expect(document.querySelector(`a[href="/positions/${LEG_ID}"]`)).toBeTruthy();
  });
});

describe('PositionTimeline — roll chain', () => {
  it('links the other chain leg and shows the net credit', () => {
    const LEG_A = 'leg-a-00000000';
    const LEG_B = 'leg-b-00000000';

    const position = makePosition({
      id: LEG_A,
      rollChain: {
        legs: [
          {
            positionId: LEG_A,
            symbol: 'AAPL  260117C00150000',
            rolledAt: '2026-01-01T00:00:00.000Z',
          },
          {
            positionId: LEG_B,
            symbol: 'AAPL  260221C00155000',
            rolledAt: '2026-02-01T00:00:00.000Z',
          },
        ],
        netCredit: 500,
      },
    });

    render(<PositionTimeline position={position} />);

    expect(document.querySelector(`a[href="/positions/${LEG_B}"]`)).toBeTruthy();

    const numerics = screen.getAllByTestId('numeric');
    expect(numerics.some((el) => el.textContent?.includes('500'))).toBe(true);
  });
});

describe('PositionTimeline — chain-captured Greeks', () => {
  it('shows the capture date, not the entry fill date', () => {
    const position = makePosition({
      fills: [makeFill({ filledAt: '2020-03-15T00:00:00.000Z' })],
      entryGreeks: {
        delta: 0.5,
        gamma: 0.1,
        thetaPerDay: -0.02,
        vegaPerPct: 0.03,
        rhoPerPct: null,
        source: 'chain',
        volatility: null,
        spot: null,
        rate: null,
        dividendYield: null,
        capturedAt: '2031-11-20T00:00:00.000Z',
      },
    });

    render(<PositionTimeline position={position} />);

    expect(screen.getByText(/2031/)).toBeTruthy();
  });
});
