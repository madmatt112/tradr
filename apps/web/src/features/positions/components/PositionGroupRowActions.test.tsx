// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionGroupEntry } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                                      | Pre-condition                          | Call (seam)                               | Observable result                                                                 | Source of expected value |
 * |---------------------------------------------------------------------|-----------------------------------------|----------------------------------------------|----------------------------------------------------------------------------------------|---------------------------|
 * | Menu offers close-all on an open group, and leaves add/reduce/reopen/delete off | group status 'open'                     | render(PositionGroupRowActions), open menu   | the menu's only item is "Close all"                                                    | requirements.md AC 6.4; design.md C12 "PositionGroupRowActions offers close-all only while open" |
 * | Menu offers nothing on a closed group                              | group status 'closed'                   | render(PositionGroupRowActions), open menu   | the menu has no items at all                                                           | requirements.md AC 6.4; tasks.md task 14 Prompt "the menu offers close-all on an open group and nothing on a closed one" |
 * | Carries data-slot="row-actions" like PositionRowActions            | group status 'open'                     | render(PositionGroupRowActions)              | the wrapping element has `data-slot="row-actions"`; the trigger button has `cursor-pointer` | tasks.md task 14 Prompt "with data-slot=\"row-actions\" as PositionRowActions has"; CLAUDE.md "cursor-pointer on every button" |
 */

function makeGroup(overrides: Partial<PositionGroupEntry> = {}): PositionGroupEntry {
  return {
    kind: 'group',
    id: 'group-1',
    userId: '00000000-0000-4000-a000-000000000100',
    accountId: '00000000-0000-4000-a000-000000000010',
    accountName: 'Test Account',
    accountCurrency: 'USD',
    accountTimezone: 'America/New_York',
    underlying: 'AAPL',
    label: 'AAPL spread',
    detectedLabel: 'AAPL spread',
    labelOverride: null,
    status: 'open',
    openedAt: '2026-05-01T12:00:00.000Z',
    closedAt: null,
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
    tags: [],
    classification: null,
    netEntry: 150,
    grossPnl: null,
    netPnl: null,
    brokerageFees: 0,
    openCostBasis: 150000,
    maxLoss: null,
    maxLossReason: null,
    legs: [],
    ...overrides,
  };
}

// CloseGroupDialog calls real data hooks (useAccountFeeSchedule → useAccounts/
// useBrokerages) that need a QueryClientProvider ancestor this file does not
// set up. Stubbed exactly as PositionRowActions.test.tsx stubs FillDialog —
// the row-actions wiring, not the dialog's own behaviour, is this file's job.
vi.mock('./CloseGroupDialog', () => ({
  CloseGroupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="close-group-dialog" /> : null,
}));

import { PositionGroupRowActions } from './PositionGroupRowActions';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderActions(overrides: Partial<PositionGroupEntry> = {}) {
  return render(<PositionGroupRowActions group={makeGroup(overrides)} />);
}

async function openMenu(label = 'AAPL spread'): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }));
}

describe('PositionGroupRowActions — close-all only while open', () => {
  it('offers only "Close all" on an open group', async () => {
    renderActions({ status: 'open' });
    await openMenu();

    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toEqual(['Close all']);
  });

  it('offers nothing on a closed group', async () => {
    renderActions({ status: 'closed' });
    await openMenu();

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });
});

describe('PositionGroupRowActions — row-actions wiring', () => {
  it('carries data-slot="row-actions" on the wrapper and cursor-pointer on the trigger', () => {
    renderActions({ status: 'open' });

    const trigger = screen.getByRole('button', { name: 'Actions for AAPL spread' });
    expect(trigger.closest('[data-slot="row-actions"]')).toBeTruthy();
    expect(trigger.className).toContain('cursor-pointer');
  });

  it('opens the close dialog when "Close all" is selected', async () => {
    renderActions({ status: 'open' });
    await openMenu();

    expect(screen.queryByTestId('close-group-dialog')).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close all' }));

    expect(screen.getByTestId('close-group-dialog')).toBeTruthy();
  });
});
