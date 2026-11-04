// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                                        | Pre-condition                                                              | Call (seam)                                                  | Observable result                                                                                                       | Source of expected value |
 * |---------------------------------------------------------------------|-----------------------------------------------------------------------------|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|---------------------------|
 * | Add stops at 8 legs                                                  | 2 default rows                                                             | click "Add leg" 6 times, then once more                        | 8 "Stock" tabs exist; the "Add leg" button is disabled; a 9th click adds no row                                             | tasks.md task 17 Prompt "add stops at 8 legs"; design.md C13 |
 * | Remove stops at 2 legs                                               | 2 default rows                                                             | render only (2 rows), then add a 3rd and remove it             | both "Remove leg" buttons are disabled at 2 rows; enabled at 3; disabled again after removing back to 2                   | tasks.md task 17 Prompt "remove stops at 2"; requirements.md AC 1.1 |
 * | Stock leg takes a ticker; option leg takes contract fields with distinct ids per row | row 0 switched to Option, row 1 left as Stock                | click the "Option" tab on row 0                                 | `#leg-0-underlying` exists, `#leg-1-underlying` does not; exactly one "Symbol" ticker input remains (row 1's)               | tasks.md task 17 Prompt "a stock leg takes a ticker and an option leg takes contract fields with distinct input ids per row"; design.md C13 |
 * | BCS legs show BCS, net entry 300 and max loss 301.30                 | long 100 call @5.00 / short 110 call @2.00, 1 contract each, 1.30 fees on leg 2 | fill both rows as option legs, select the account             | the Label input's value is "BCS"; the net-entry display contains "300"; the max-loss display contains "301.3"            | requirements.md AC 3.6 case 1 (also packages/shared/src/lib/strategy.test.ts); tasks.md task 17 Prompt |
 * | A short strangle shows Unbounded                                     | short 110 call @2.00 / short 90 put @1.50, no fees                        | fill both rows as option legs, select the account             | the max-loss display reads "Unbounded"                                                                                      | requirements.md AC 3.6 case 4; apps/web/.../listEntries.ts maxLossReasonText; tasks.md task 17 Prompt |
 * | Editing the label sends labelOverride                                | 2 valid stock legs, account and fill date set                             | edit the Label field, click "Create group"                     | useCreatePositionGroup's mutateAsync is called with `labelOverride` equal to the typed text                                | requirements.md AC 2.3, 2.4; design.md C13 |
 * | A server legIndex error marks that row                               | 2 valid stock legs submitted; mutateAsync rejects with details.legIndex '1' | click "Create group"                                           | an error for leg index 1 renders; none renders for leg index 0                                                              | design.md Error Handling #1; tasks.md task 5 Prompt (`ValidationError` `details.legIndex`) |
 * | A TIER_LIMIT_POSITIONS refusal shows inline and keeps the form        | 2 valid stock legs submitted; mutateAsync rejects with error.code TIER_LIMIT_POSITIONS | click "Create group"                              | the tier-limit message renders inline; onOpenChange is never called with `false`                                           | design.md Error Handling #4; requirements.md AC 1.3; tasks.md task 17 Prompt |
 *
 * Implementation contract this file assumes (the component does not exist yet):
 * - Props: `{ accounts: Account[] | undefined; onOpenChange: (open: boolean) => void }`.
 * - Two leg rows by default, each with a "Stock"/"Option" tab (default Stock) and a
 *   "Long"/"Short" tab (default Long), a "Quantity", "Price" and "Fee" input (Fee default
 *   '0'), and for a stock row a "Symbol" ticker input. An option row renders
 *   `OptionContractFields` with `idPrefix={`leg-${index}`}` (0-based).
 * - One "Account" select (native `<select>` once `@/components/ui/select` is mocked below)
 *   and one "Fill date" `datetime-local` input, shared by the whole group.
 * - One "Label" input: shows the live detected label and is directly editable.
 * - A `data-testid="multi-leg-net-entry"` and `data-testid="multi-leg-max-loss"` live preview.
 * - "Add leg" / "Remove leg" buttons; a "Create group" submit button.
 */

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('../hooks/usePositionGroups', () => ({
  useCreatePositionGroup: vi.fn(() => ({ mutateAsync, isPending: false })),
}));

import { MultiLegEntryForm } from './MultiLegEntryForm';

const ACCOUNT_ID = '11111111-1111-4111-a111-111111111111';
const ACCOUNTS: Account[] = [
  {
    id: ACCOUNT_ID,
    userId: '00000000-0000-4000-a000-000000000001',
    name: 'Main',
    currency: 'USD',
    timezone: 'America/New_York',
    brokerageId: null,
    brokerageName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function selectByOptionValue(optionValue: string): HTMLSelectElement {
  const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
  for (const s of selects) {
    if (Array.from(s.options).some((o) => o.value === optionValue)) return s;
  }
  throw new Error(`no <select> with option value="${optionValue}"`);
}

function renderForm(onOpenChange = vi.fn()) {
  render(<MultiLegEntryForm accounts={ACCOUNTS} onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

function chooseAccount(): void {
  fireEvent.change(selectByOptionValue(ACCOUNT_ID), { target: { value: ACCOUNT_ID } });
}

function fillStockLeg(index: number, symbol: string, quantity: string, price: string): void {
  fireEvent.change(screen.getAllByLabelText('Symbol')[index], { target: { value: symbol } });
  fireEvent.change(screen.getAllByLabelText('Quantity')[index], { target: { value: quantity } });
  fireEvent.change(screen.getAllByLabelText('Price')[index], { target: { value: price } });
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

describe('MultiLegEntryForm — leg count bounds', () => {
  it('stops adding at 8 legs', () => {
    renderForm();

    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Add leg' }));
    }

    expect(screen.getAllByRole('tab', { name: 'Stock' })).toHaveLength(8);
    const addButton = screen.getByRole('button', { name: 'Add leg' }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    fireEvent.click(addButton);
    expect(screen.getAllByRole('tab', { name: 'Stock' })).toHaveLength(8);
  });

  it('stops removing at 2 legs', () => {
    renderForm();

    let removeButtons = screen.getAllByRole('button', {
      name: 'Remove leg',
    }) as HTMLButtonElement[];
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons.every((b) => b.disabled)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Add leg' }));
    removeButtons = screen.getAllByRole('button', { name: 'Remove leg' }) as HTMLButtonElement[];
    expect(removeButtons).toHaveLength(3);
    expect(removeButtons.every((b) => b.disabled)).toBe(false);

    fireEvent.click(removeButtons[2]);
    removeButtons = screen.getAllByRole('button', { name: 'Remove leg' }) as HTMLButtonElement[];
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons.every((b) => b.disabled)).toBe(true);
  });
});

describe('MultiLegEntryForm — stock vs option rows', () => {
  it('gives an option row OptionContractFields with a distinct idPrefix, leaving the other row a ticker', () => {
    renderForm();

    fireEvent.click(screen.getAllByRole('tab', { name: 'Option' })[0]);

    expect(document.getElementById('leg-0-underlying')).toBeTruthy();
    expect(document.getElementById('leg-1-underlying')).toBeNull();
    expect(screen.getAllByLabelText('Symbol')).toHaveLength(1);
  });
});

describe('MultiLegEntryForm — live strategy preview', () => {
  it('shows BCS, net entry 300 and max loss 301.30 for a bull call spread', async () => {
    renderForm();
    chooseAccount();

    fireEvent.click(screen.getAllByRole('tab', { name: 'Option' })[0]);
    fireEvent.click(screen.getAllByRole('tab', { name: 'Option' })[1]);

    fireEvent.change(screen.getAllByLabelText('Underlying')[0], { target: { value: 'XYZ' } });
    fireEvent.change(screen.getAllByLabelText('Expiry')[0], { target: { value: '2026-06-19' } });
    fireEvent.change(screen.getAllByLabelText('Strike')[0], { target: { value: '100' } });
    fireEvent.change(screen.getAllByLabelText('Quantity')[0], { target: { value: '1' } });
    fireEvent.change(screen.getAllByLabelText('Price')[0], { target: { value: '5.00' } });

    fireEvent.change(screen.getAllByLabelText('Underlying')[1], { target: { value: 'XYZ' } });
    fireEvent.change(screen.getAllByLabelText('Expiry')[1], { target: { value: '2026-06-19' } });
    fireEvent.change(screen.getAllByLabelText('Strike')[1], { target: { value: '110' } });
    fireEvent.click(screen.getAllByRole('tab', { name: 'Short' })[1]);
    fireEvent.change(screen.getAllByLabelText('Quantity')[1], { target: { value: '1' } });
    fireEvent.change(screen.getAllByLabelText('Price')[1], { target: { value: '2.00' } });
    fireEvent.change(screen.getAllByLabelText('Fee')[1], { target: { value: '1.30' } });

    await waitFor(() =>
      expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('BCS'),
    );
    expect(screen.getByTestId('multi-leg-net-entry').textContent).toContain('300');
    expect(screen.getByTestId('multi-leg-max-loss').textContent).toContain('301.3');
  });

  it('shows Unbounded for a short strangle', async () => {
    renderForm();
    chooseAccount();

    fireEvent.click(screen.getAllByRole('tab', { name: 'Option' })[0]);
    fireEvent.click(screen.getAllByRole('tab', { name: 'Option' })[1]);

    fireEvent.change(screen.getAllByLabelText('Underlying')[0], { target: { value: 'XYZ' } });
    fireEvent.change(screen.getAllByLabelText('Expiry')[0], { target: { value: '2026-06-19' } });
    fireEvent.change(screen.getAllByLabelText('Strike')[0], { target: { value: '110' } });
    fireEvent.click(screen.getAllByRole('tab', { name: 'Short' })[0]);
    fireEvent.change(screen.getAllByLabelText('Quantity')[0], { target: { value: '1' } });
    fireEvent.change(screen.getAllByLabelText('Price')[0], { target: { value: '2.00' } });

    // Row 0 stays Call (the short 110 call above); only row 1 switches to Put.
    fireEvent.click(screen.getAllByRole('tab', { name: 'Put' })[1]);
    fireEvent.change(screen.getAllByLabelText('Underlying')[1], { target: { value: 'XYZ' } });
    fireEvent.change(screen.getAllByLabelText('Expiry')[1], { target: { value: '2026-06-19' } });
    fireEvent.change(screen.getAllByLabelText('Strike')[1], { target: { value: '90' } });
    fireEvent.click(screen.getAllByRole('tab', { name: 'Short' })[1]);
    fireEvent.change(screen.getAllByLabelText('Quantity')[1], { target: { value: '1' } });
    fireEvent.change(screen.getAllByLabelText('Price')[1], { target: { value: '1.50' } });

    await waitFor(() =>
      expect(screen.getByTestId('multi-leg-max-loss').textContent).toContain('Unbounded'),
    );
  });
});

describe('MultiLegEntryForm — submission', () => {
  it('sends the edited label as labelOverride', async () => {
    mutateAsync.mockResolvedValue({ id: 'group-1', legs: [{ id: 'leg-a' }, { id: 'leg-b' }] });
    renderForm();
    chooseAccount();
    fireEvent.change(screen.getByLabelText('Fill date'), {
      target: { value: '2026-06-01T12:00' },
    });

    fillStockLeg(0, 'AAPL', '10', '150');
    fireEvent.click(screen.getAllByRole('tab', { name: 'Short' })[1]);
    fillStockLeg(1, 'MSFT', '5', '300');

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'My Custom Spread' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload.labelOverride).toBe('My Custom Spread');
  });

  it("marks the row named by the server's legIndex error", async () => {
    mutateAsync.mockRejectedValue({
      error: {
        code: 'VALIDATION_ERROR',
        message: "Leg 2's symbol is not a valid OCC contract.",
        details: { legIndex: '1' },
      },
    });
    const { onOpenChange } = renderForm();
    chooseAccount();
    fireEvent.change(screen.getByLabelText('Fill date'), {
      target: { value: '2026-06-01T12:00' },
    });

    fillStockLeg(0, 'AAPL', '10', '150');
    fireEvent.click(screen.getAllByRole('tab', { name: 'Short' })[1]);
    fillStockLeg(1, 'MSFT', '5', '300');

    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('leg-1-error').textContent).toContain(
        "Leg 2's symbol is not a valid OCC contract.",
      ),
    );
    expect(screen.queryByTestId('leg-0-error')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows a TIER_LIMIT_POSITIONS refusal inline and keeps the form open', async () => {
    mutateAsync.mockRejectedValue({
      error: {
        code: 'TIER_LIMIT_POSITIONS',
        message: "You've reached your plan's position limit.",
      },
    });
    const { onOpenChange } = renderForm();
    chooseAccount();
    fireEvent.change(screen.getByLabelText('Fill date'), {
      target: { value: '2026-06-01T12:00' },
    });

    fillStockLeg(0, 'AAPL', '10', '150');
    fireEvent.click(screen.getAllByRole('tab', { name: 'Short' })[1]);
    fillStockLeg(1, 'MSFT', '5', '300');

    fireEvent.click(submitButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText("You've reached your plan's position limit.")).toBeTruthy(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
