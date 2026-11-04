// @vitest-environment jsdom
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionGroupEntry } from '@tradr/shared';

import {
  makePosition,
  makePositionGroup,
} from '@/features/positions/__fixtures__/position-fixtures';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { EM_DASH } from '@/lib/format';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source |
 * | --- | --- | --- | --- | --- |
 * | A group row shows underlying, label, status, tags, account, net entry (debit), P&L, fees and age; em-dash elsewhere | a closed group, 2 legs | render(PositionList), usePositions mocked with one group entry | the group's single `<tr>` carries all of those values in the columns PositionList already renders, and em-dash in Side/Qty/Exit/R | requirements.md AC 6.3; design.md C12 "shows underlying and label, status, tags, account, net entry... and an em-dash elsewhere" |
 * | Net entry reads a negative sum as a credit | same group, netEntry negative | render(PositionList) | the Entry column shows "credit" and the magnitude | requirements.md AC 3.2 (net entry sign), tasks.md task 16 Prompt "the text debit or credit in the Entry column" |
 * | The toggle is a button with aria-expanded; pressing it shows leg rows with today's columns and row actions | an open group, 2 legs | render(PositionList), click the toggle in the symbol cell | `aria-expanded` flips, leg rows with their own numeric columns and row-actions markers appear, then disappear on a second click | requirements.md AC 6.3; tasks.md task 16 Prompt "the toggle is a button with aria-expanded... Success: pressing the toggle shows leg rows with today's columns and row actions and sets aria-expanded" |
 * | A group row click toggles and does not inspect | an open group | render(PositionList), click a non-interactive cell in the group row | leg rows appear/disappear; `inspectPosition` is never called | design.md D18 "A group row click expands, over opening the inspect drawer"; tasks.md task 16 Prompt "A group row click toggles and does not inspect" |
 * | A leg row click inspects that leg | an open group, expanded | render(PositionList), click a non-interactive cell in a leg row | `inspectPosition` is called with that leg | tasks.md task 16 Prompt "a leg row click inspects that leg" |
 * | At phone width the toggle stays and legs expand | an open group, `useMediaQuery` stubbed true | render(PositionList), click the toggle | `aria-expanded` flips and leg rows appear; `navigate` is never called | requirements.md AC 6.3 "on phone widths too"; tasks.md task 16 Prompt "at phone width the toggle stays and legs expand" |
 * | The group row wires to PositionGroupRowActions; leg rows wire to PositionRowActions carrying the leg's groupId | an open group, 2 legs | render(PositionList), expand | the group row's actions marker carries the group's status; each leg row's actions marker carries `groupId` | requirements.md AC 6.4; tasks.md task 16 Prompt "the group row actions task 14 exports sit in the last cell... PositionRowActions accepts an optional groupId on its position" |
 */

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  inspectPosition: vi.fn(),
  mediaQuery: vi.fn<(query: string) => boolean>(() => false),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  useNavigate: () => h.navigate,
  useSearch: () => ({}),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => h.mediaQuery(query),
}));

vi.mock('@/stores/drawer.store', () => ({
  useDrawerStore: (selector: (s: unknown) => unknown) =>
    selector({ inspectPosition: h.inspectPosition, inspectedPosition: null, isOpen: false }),
}));

vi.mock('@/features/tags/hooks/useTags', () => ({
  useTags: () => ({ data: [] }),
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1' }] }),
}));

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

vi.mock('./CreatePositionDialog', () => ({
  CreatePositionDialog: () => null,
}));

// Leaf collaborators already covered by their own suites (PositionRowActions.test.tsx,
// PositionGroupRowActions.test.tsx). This file is about PositionList/PositionGroupRows
// composition: which component renders per row, and what it's handed — not their
// internal menus. Each is stubbed to a marker that proves identity and the props
// passed through.
vi.mock('./PositionRowActions', () => ({
  PositionRowActions: ({ position }: { position: { id: string; groupId?: string } }) => (
    <div data-testid={`row-actions-${position.id}`} data-group-id={position.groupId ?? ''} />
  ),
}));

vi.mock('./PositionGroupRowActions', () => ({
  PositionGroupRowActions: ({ group }: { group: PositionGroupEntry }) => (
    <div data-testid={`group-row-actions-${group.id}`} data-status={group.status} />
  ),
}));

import { PositionList } from './PositionList';

type PositionsResult = ReturnType<typeof usePositions>;

function mockEntries(entries: unknown[]) {
  vi.mocked(usePositions).mockReturnValue({
    data: entries,
    isLoading: false,
  } as unknown as PositionsResult);
}

const GROUP_ID = '00000000-0000-4000-a000-000000000200';

const legOpen = {
  ...makePosition({
    id: 'leg-open',
    symbol: 'LEGA',
    status: 'open',
    totalEntryQuantity: 10,
    totalExitQuantity: 0,
    openUnits: 10,
    closedUnits: 0,
    netPnl: null,
  }),
  groupId: GROUP_ID,
};

const legClosed = {
  ...makePosition({
    id: 'leg-closed',
    symbol: 'LEGB',
    status: 'closed',
    totalEntryQuantity: 5,
    totalExitQuantity: 5,
    openUnits: 0,
    closedUnits: 5,
    netPnl: 42,
    closedAt: '2026-05-02T12:00:00.000Z',
  }),
  groupId: GROUP_ID,
};

function makeGroup(overrides: Partial<PositionGroupEntry> = {}): PositionGroupEntry {
  return makePositionGroup({
    id: GROUP_ID,
    tags: [{ id: 'tag-1', name: 'Earnings', category: 'setup', color: null }],
    legs: [legOpen, legClosed],
    ...overrides,
  });
}

function rowAt(container: HTMLElement, index: number): HTMLElement {
  return container.querySelectorAll('tbody tr')[index] as HTMLElement;
}

function cellsOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll('td')) as HTMLElement[];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.mediaQuery.mockReturnValue(false);
});

describe('PositionList — group row columns (design C12, AC 6.3)', () => {
  it('shows underlying, label, status, tags, account, net entry (debit), P&L, fees and age, em-dash elsewhere', () => {
    mockEntries([
      makeGroup({
        status: 'closed',
        openedAt: '2026-05-01T12:00:00.000Z',
        closedAt: '2026-05-03T12:00:00.000Z',
        netEntry: 300,
        netPnl: 500,
        grossPnl: 500,
        brokerageFees: 2.5,
      }),
    ]);
    const { container } = render(<PositionList />);

    const row = rowAt(container, 0);
    const cells = cellsOf(row);

    // Symbol cell: underlying + label.
    expect(cells[0].textContent).toContain('AAPL');
    expect(cells[0].textContent).toContain('BCS');
    // Status.
    expect(cells[2].textContent).toContain('closed');
    // Tags.
    expect(within(row).getByTitle('setup: Earnings')).toBeTruthy();
    // Account.
    expect(cells[4].textContent).toContain('Test Account');
    // Net entry: positive sums to a debit.
    expect(cells[6].textContent).toMatch(/debit/i);
    expect(cells[6].textContent).toMatch(/300\.00/);
    // P&L keeps the pinned `position-pnl` test id.
    const pnl = within(row).getByTestId('position-pnl');
    expect(pnl.textContent).toContain('500.00');
    // Fees.
    expect(cells[10].textContent).toMatch(/2\.50/);
    // Age: May 1 -> May 3 is exactly 2 days.
    expect(cells[11].textContent).toContain('2d');

    // Side, Qty, Exit and R do not apply to a group row.
    expect(cells[1].textContent).toContain(EM_DASH);
    expect(cells[5].textContent).toContain(EM_DASH);
    expect(cells[7].textContent).toContain(EM_DASH);
    expect(cells[9].textContent).toContain(EM_DASH);
  });

  it('reads a negative net entry as a credit', () => {
    mockEntries([makeGroup({ netEntry: -200 })]);
    const { container } = render(<PositionList />);

    const cells = cellsOf(rowAt(container, 0));
    expect(cells[6].textContent).toMatch(/credit/i);
    expect(cells[6].textContent).toMatch(/200\.00/);
  });
});

describe('PositionList — group expand/collapse (design C12, D18, AC 6.3)', () => {
  it("toggles via the symbol-cell button, setting aria-expanded and revealing leg rows with today's columns and row actions", () => {
    mockEntries([makeGroup()]);
    const { container } = render(<PositionList />);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);

    const toggle = within(cellsOf(rowAt(container, 0))[0]).getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const legOpenRow = screen.getByText('LEGA').closest('tr') as HTMLElement;
    expect(cellsOf(legOpenRow)[5].textContent).toContain('10');
    expect(within(legOpenRow).getByTestId(`row-actions-${legOpen.id}`)).toBeTruthy();

    const legClosedRow = screen.getByText('LEGB').closest('tr') as HTMLElement;
    expect(within(legClosedRow).getByTestId('position-pnl').textContent).toContain('42.00');
    expect(within(legClosedRow).getByTestId(`row-actions-${legClosed.id}`)).toBeTruthy();

    fireEvent.click(toggle);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('a click on the group row toggles without opening the inspect drawer', () => {
    mockEntries([makeGroup()]);
    const { container } = render(<PositionList />);

    const statusCell = cellsOf(rowAt(container, 0))[2];
    fireEvent.click(statusCell);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(h.inspectPosition).not.toHaveBeenCalled();

    fireEvent.click(statusCell);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('a click on a leg row inspects that leg', () => {
    mockEntries([makeGroup()]);
    const { container } = render(<PositionList />);

    const toggle = within(cellsOf(rowAt(container, 0))[0]).getByRole('button');
    fireEvent.click(toggle);

    const legRow = screen.getByText('LEGB').closest('tr') as HTMLElement;
    fireEvent.click(cellsOf(legRow)[2]);

    expect(h.inspectPosition).toHaveBeenCalledWith(expect.objectContaining({ id: legClosed.id }));
  });

  it('keeps the toggle working at phone widths and still expands legs', () => {
    h.mediaQuery.mockReturnValue(true);
    mockEntries([makeGroup()]);
    const { container } = render(<PositionList />);

    const toggle = within(cellsOf(rowAt(container, 0))[0]).getByRole('button');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe('PositionList — row actions wiring (AC 6.4)', () => {
  it('wires the group row to PositionGroupRowActions and leg rows to PositionRowActions carrying groupId', () => {
    mockEntries([makeGroup()]);
    const { container } = render(<PositionList />);

    const groupActions = screen.getByTestId(`group-row-actions-${GROUP_ID}`);
    expect(groupActions.getAttribute('data-status')).toBe('open');

    const toggle = within(cellsOf(rowAt(container, 0))[0]).getByRole('button');
    fireEvent.click(toggle);

    expect(screen.getByTestId(`row-actions-${legOpen.id}`).getAttribute('data-group-id')).toBe(
      GROUP_ID,
    );
    expect(screen.getByTestId(`row-actions-${legClosed.id}`).getAttribute('data-group-id')).toBe(
      GROUP_ID,
    );
  });
});
