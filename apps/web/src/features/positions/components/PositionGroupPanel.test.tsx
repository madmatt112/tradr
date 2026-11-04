// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionGroupEntry } from '@tradr/shared';

import { makePosition, makePositionGroup } from '@/features/positions/__fixtures__/position-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * | --- | --- | --- | --- | --- |
 * | Shows label, sibling legs with links, net entry, P&L, fees and max loss | 3-leg open group, viewing one leg | render(PositionGroupPanel) | the label text, a link for each sibling leg's symbol, and the net entry/P&L/fees/max-loss figures all render | requirements.md AC 6.5; tasks.md task 18 Prompt "a leg's page shows the label, sibling links, net entry, P&L, fees and max loss" |
 * | A spanning group shows "Spans expiries" | maxLoss null, maxLossReason 'multiple_expiries' | render(PositionGroupPanel) | the text "Spans expiries" renders | requirements.md AC 3.5; tasks.md task 18 Prompt "a spanning group shows Spans expiries"; listEntries.ts maxLossReasonText mapping |
 * | Saving a typed override calls the label hook | group with no override | type into the override field, click Save | useSetGroupLabel's mutate is called with `{ labelOverride: 'My Spread' }` | requirements.md AC 2.3/2.4; tasks.md task 18 Prompt "saving an override calls the label hook" |
 * | Clearing the override sends null | group with an existing override | clear the override field, click Save | mutate is called with `{ labelOverride: null }` | requirements.md AC 2.4 "Clearing it SHALL return the detected label"; tasks.md task 18 Prompt "clearing it sends null" |
 * | An override holding markup renders as literal text | group.label holds `<b>evil</b>` | render(PositionGroupPanel) | the literal string renders as text; no `<b>` element exists in the DOM | requirements.md NFR Security "The label override SHALL render as text"; tasks.md task 18 Restrictions "never as HTML" |
 * | Close-all opens the dialog only while the group is open | group status 'open', then 'closed' | click "Close all" / render a closed group | CloseGroupDialog's "Close all legs" title appears for an open group; no "Close all" control exists for a closed one | requirements.md AC 4.1/6.5; design.md C13 "close-all"; tasks.md task 18 Prompt "close-all opens the dialog only while the group is open" |
 * | Unlink calls the unlink hook | viewing one leg of a group | click "Unlink" | useUnlinkGroupLeg's mutate is called with the viewed leg's id | requirements.md AC 1.5/6.5; tasks.md task 18 Prompt "unlink calls the unlink hook" |
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock('../hooks/usePositionGroups', () => ({
  useSetGroupLabel: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUnlinkGroupLeg: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useCloseGroup: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/useAccountFeeSchedule', () => ({
  useAccountFeeSchedule: vi.fn(() => null),
}));

import { useSetGroupLabel, useUnlinkGroupLeg } from '../hooks/usePositionGroups';

import { PositionGroupPanel } from './PositionGroupPanel';

const GROUP_ACCOUNT_ID = '00000000-0000-4000-a000-000000000010';

function makeGroup(overrides: Partial<PositionGroupEntry> = {}): PositionGroupEntry {
  const legA = {
    ...makePosition({ id: 'leg-aapl', symbol: 'AAPL', status: 'open', accountId: GROUP_ACCOUNT_ID }),
    groupId: 'group-1',
  };
  const legB = {
    ...makePosition({ id: 'leg-msft', symbol: 'MSFT', status: 'open', accountId: GROUP_ACCOUNT_ID }),
    groupId: 'group-1',
  };
  const legC = {
    ...makePosition({ id: 'leg-goog', symbol: 'GOOG', status: 'open', accountId: GROUP_ACCOUNT_ID }),
    groupId: 'group-1',
  };
  return makePositionGroup({
    id: 'group-1',
    accountId: GROUP_ACCOUNT_ID,
    label: 'Iron condor',
    detectedLabel: 'Iron condor',
    labelOverride: null,
    status: 'open',
    netEntry: 150,
    grossPnl: null,
    netPnl: 480,
    brokerageFees: 3.5,
    maxLoss: 650,
    maxLossReason: null,
    legs: [legA, legB, legC],
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(useSetGroupLabel).mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<
    typeof useSetGroupLabel
  >);
  vi.mocked(useUnlinkGroupLeg).mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<
    typeof useUnlinkGroupLeg
  >);
});

function renderPanel(
  overrides: Partial<{ positionId: string; group: PositionGroupEntry }> = {},
) {
  return render(
    <PositionGroupPanel positionId={overrides.positionId ?? 'leg-aapl'} group={overrides.group ?? makeGroup()} />,
  );
}

describe('PositionGroupPanel — label, siblings and figures', () => {
  it('shows the label, sibling legs with links, net entry, P&L, fees and max loss', () => {
    const { container } = renderPanel();

    expect(screen.getByText('Iron condor')).toBeTruthy();

    const links = screen.getAllByRole('link');
    expect(links.some((a) => a.textContent?.includes('MSFT'))).toBe(true);
    expect(links.some((a) => a.textContent?.includes('GOOG'))).toBe(true);

    expect(container.textContent).toMatch(/150\.00/); // net entry
    expect(container.textContent).toMatch(/480\.00/); // net P&L
    expect(container.textContent).toMatch(/3\.50/); // fees
    expect(container.textContent).toMatch(/650\.00/); // max loss
  });
});

describe('PositionGroupPanel — max loss reason', () => {
  it('shows "Spans expiries" when the group spans two or more expiries', () => {
    renderPanel({ group: makeGroup({ maxLoss: null, maxLossReason: 'multiple_expiries' }) });

    expect(screen.getByText('Spans expiries')).toBeTruthy();
  });
});

describe('PositionGroupPanel — label override', () => {
  it('saves a typed override through the label hook', () => {
    const mutate = vi.fn();
    vi.mocked(useSetGroupLabel).mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof useSetGroupLabel
    >);

    renderPanel();

    fireEvent.change(screen.getByLabelText(/label override/i), { target: { value: 'My Spread' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(mutate).toHaveBeenCalledWith({ labelOverride: 'My Spread' });
  });

  it('sends null when the override is cleared', () => {
    const mutate = vi.fn();
    vi.mocked(useSetGroupLabel).mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof useSetGroupLabel
    >);

    renderPanel({ group: makeGroup({ labelOverride: 'Old name', label: 'Old name' }) });

    fireEvent.change(screen.getByLabelText(/label override/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(mutate).toHaveBeenCalledWith({ labelOverride: null });
  });
});

describe('PositionGroupPanel — override security', () => {
  it('renders a label holding markup as literal text, never as HTML', () => {
    const { container } = renderPanel({
      group: makeGroup({ label: 'Spread <b>evil</b>', labelOverride: 'Spread <b>evil</b>' }),
    });

    expect(screen.getByText('Spread <b>evil</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('PositionGroupPanel — close all', () => {
  it('opens the close-all dialog from the panel while the group is open', () => {
    renderPanel({ group: makeGroup({ status: 'open' }) });

    fireEvent.click(screen.getByRole('button', { name: /close all/i }));

    expect(screen.getByText('Close all legs')).toBeTruthy();
  });

  it('offers no close-all control once the group is closed', () => {
    const closedLegs = makeGroup().legs.map((leg) => ({ ...leg, status: 'closed' as const }));
    renderPanel({ group: makeGroup({ status: 'closed', legs: closedLegs }) });

    expect(screen.queryByRole('button', { name: /close all/i })).toBeNull();
  });
});

describe('PositionGroupPanel — unlink', () => {
  it('unlinks the viewed leg through the unlink hook', () => {
    const mutate = vi.fn();
    vi.mocked(useUnlinkGroupLeg).mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof useUnlinkGroupLeg
    >);

    renderPanel({ positionId: 'leg-aapl' });

    fireEvent.click(screen.getByRole('button', { name: /unlink/i }));

    expect(mutate).toHaveBeenCalledWith('leg-aapl');
  });
});
