// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaxSummaryResponse } from '@tradr/shared/schemas/expense';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Hook mocks (task 11, design C10). `useTaxLotMethod` does not exist yet —
// nothing in the current TaxSummaryPage imports it, so registering the mock
// ahead of the module's creation is safe: Vitest only resolves a mocked
// specifier once something actually imports it.
const {
  mockUseTaxSummary,
  mockUseTaxJurisdictionQuery,
  mockUseTaxJurisdictionMutation,
  mockUseTaxLotMethodQuery,
  mockTaxLotMethodMutate,
} = vi.hoisted(() => ({
  mockUseTaxSummary: vi.fn(),
  mockUseTaxJurisdictionQuery: vi.fn(),
  mockUseTaxJurisdictionMutation: vi.fn(),
  mockUseTaxLotMethodQuery: vi.fn(),
  mockTaxLotMethodMutate: vi.fn(),
}));

vi.mock('@/features/expenses/hooks/useTaxSummary', () => ({
  useTaxSummary: mockUseTaxSummary,
}));

vi.mock('@/features/expenses/hooks/useTaxJurisdiction', () => ({
  useTaxJurisdictionQuery: mockUseTaxJurisdictionQuery,
  useTaxJurisdictionMutation: mockUseTaxJurisdictionMutation,
}));

vi.mock('@/features/expenses/hooks/useTaxLotMethod', () => ({
  useTaxLotMethodQuery: mockUseTaxLotMethodQuery,
  useTaxLotMethodMutation: () => ({ mutate: mockTaxLotMethodMutate, isPending: false }),
}));

vi.mock('@/features/accounting/hooks/useMissingRatePrompt', () => ({
  useMissingRatePrompt: () => ({
    shouldPrompt: false,
    missingPair: null,
    missingPairs: [],
    deeplinkTo: null,
  }),
}));

// Stub the shadcn Select primitive as a native <select>/<option> pair so
// options are inspectable and clickable in jsdom (CreatePositionDialog.test.tsx
// precedent) — Radix's real Select needs pointer-capture APIs jsdom lacks.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
    disabled,
  }: {
    value: string;
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

import { TaxSummaryPage } from './TaxSummaryPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The <select> whose <option>s include the given value (year / jurisdiction
 * / lot-method controls use disjoint value sets, so this is unambiguous). */
function selectByOptionValue(optionValue: string): HTMLSelectElement {
  const selects = Array.from(document.querySelectorAll('select'));
  for (const s of selects) {
    if (Array.from(s.options).some((o) => o.value === optionValue)) return s;
  }
  throw new Error(`no <select> with option value="${optionValue}"`);
}

function baseSummary(overrides: Partial<TaxSummaryResponse> = {}): TaxSummaryResponse {
  return {
    year: 2025,
    jurisdiction: 'US',
    lotMethod: 'average',
    displayCurrency: 'USD',
    realisedPnl: {
      total: '1000',
      perCurrency: [{ currency: 'USD', amount: '1000' }],
      shortTerm: '400',
      longTerm: '600',
    },
    trackedExpenses: { total: '0', perCurrency: [], perCategory: [] },
    flags: { washSales: [], superficialLosses: [] },
    lotRealisations: [],
    missingRates: [],
    excludedCurrencies: [],
    ratesAsOf: null,
    usedRates: [],
    disclaimer: 'Tax figures are estimates only.',
    ...overrides,
  };
}

function mockSummary(data: TaxSummaryResponse): void {
  mockUseTaxSummary.mockReturnValue({ data, isLoading: false, isError: false });
}

function mockJurisdiction(taxJurisdiction: 'US' | 'CA' | 'other' | null): void {
  mockUseTaxJurisdictionQuery.mockReturnValue({ data: { taxJurisdiction } });
  mockUseTaxJurisdictionMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

function mockLotMethod(taxLotMethod: 'fifo' | 'average' | null): void {
  mockUseTaxLotMethodQuery.mockReturnValue({ data: { taxLotMethod } });
}

describe('TaxSummaryPage — lot-method control (design C10, AC 2.3)', () => {
  it('shows "Default (FIFO)" when the stored method is null under a US jurisdiction', () => {
    mockJurisdiction('US');
    mockLotMethod(null);
    mockSummary(baseSummary({ jurisdiction: 'US', lotMethod: 'fifo' }));

    render(<TaxSummaryPage />);

    const methodSelect = selectByOptionValue('default');
    expect(methodSelect.value).toBe('default');
    expect(methodSelect.querySelector('option[value="default"]')?.textContent).toBe(
      'Default (FIFO)',
    );
  });

  it('shows the stored method (not the default label) when one is set', () => {
    mockJurisdiction('US');
    mockLotMethod('average');
    mockSummary(baseSummary({ jurisdiction: 'US', lotMethod: 'average' }));

    render(<TaxSummaryPage />);

    const methodSelect = selectByOptionValue('average');
    expect(methodSelect.value).toBe('average');
    expect(methodSelect.querySelector('option[value="average"]')?.textContent).toBe('Average cost');
  });

  it('calls the mutation with "average" for Average cost and null for the default', () => {
    mockJurisdiction('US');
    mockLotMethod('fifo');
    mockSummary(baseSummary({ jurisdiction: 'US', lotMethod: 'fifo' }));

    render(<TaxSummaryPage />);

    const methodSelect = selectByOptionValue('average');
    fireEvent.change(methodSelect, { target: { value: 'average' } });
    expect(mockTaxLotMethodMutate).toHaveBeenCalledWith('average');

    fireEvent.change(methodSelect, { target: { value: 'default' } });
    expect(mockTaxLotMethodMutate).toHaveBeenCalledWith(null);
  });
});

describe('TaxSummaryPage — FIFO lot realisations (AC 5.8, AC 8.3)', () => {
  it('shows the average-cost caption and a collapsible lot table with a Term column for US', () => {
    mockJurisdiction('US');
    mockLotMethod('fifo');
    mockSummary(
      baseSummary({
        jurisdiction: 'US',
        lotMethod: 'fifo',
        lotRealisations: [
          {
            exitFillId: 'exit-1',
            entryFillId: 'entry-1',
            positionId: 'pos-1',
            accountId: 'acct-1',
            symbol: 'AAPL',
            currency: 'USD',
            lotOpenedAt: '2025-01-10',
            realisedAt: '2025-03-01',
            quantity: '10',
            proceeds: '1600',
            basis: '1500',
            fees: '5',
            net: '95',
            term: 'short',
          },
          {
            exitFillId: 'exit-2',
            entryFillId: 'entry-2',
            positionId: 'pos-2',
            accountId: 'acct-1',
            symbol: 'MSFT',
            currency: 'USD',
            lotOpenedAt: '2023-02-01',
            realisedAt: '2025-04-15',
            quantity: '5',
            proceeds: '900',
            basis: '600',
            fees: '2',
            net: '298',
            term: 'long',
          },
        ],
      }),
    );

    render(<TaxSummaryPage />);

    expect(
      screen.getByText(
        'Figures use FIFO lots. The journal, ledger and performance use average cost.',
      ),
    ).toBeTruthy();

    const trigger = screen.getByText(/Lot realisations \(2\)/);
    fireEvent.click(trigger.closest('button') ?? trigger);

    const rows = screen.getAllByText(/AAPL|MSFT/).map((el) => el.closest('tr'));
    expect(new Set(rows).size).toBe(2);

    expect(screen.getByText('Term')).toBeTruthy();
    const termCells = [...screen.getAllByText(/^short$/i), ...screen.getAllByText(/^long$/i)];
    expect(termCells.length).toBe(2);

    // AC 6.2 (folded in here, not a standalone test): the same caption and
    // table must NOT appear for an average-cost summary. In isolation this
    // assertion holds vacuously before either feature exists, so it is
    // folded into this test — which already fails at base on the FIFO
    // assertions above — rather than reported as its own red test.
    cleanup();
    mockJurisdiction('CA');
    mockLotMethod('average');
    mockSummary(baseSummary({ jurisdiction: 'CA', lotMethod: 'average', lotRealisations: [] }));
    render(<TaxSummaryPage />);
    expect(
      screen.queryByText(
        'Figures use FIFO lots. The journal, ledger and performance use average cost.',
      ),
    ).toBeNull();
    expect(screen.queryByText(/Lot realisations/)).toBeNull();
  });

  it('shows no Term column when the jurisdiction is not US', () => {
    mockJurisdiction('CA');
    mockLotMethod('fifo');
    mockSummary(
      baseSummary({
        jurisdiction: 'CA',
        lotMethod: 'fifo',
        lotRealisations: [
          {
            exitFillId: 'exit-1',
            entryFillId: 'entry-1',
            positionId: 'pos-1',
            accountId: 'acct-1',
            symbol: 'AAPL',
            currency: 'USD',
            lotOpenedAt: '2025-01-10',
            realisedAt: '2025-03-01',
            quantity: '10',
            proceeds: '1600',
            basis: '1500',
            fees: '5',
            net: '95',
            term: null,
          },
        ],
      }),
    );

    render(<TaxSummaryPage />);

    const trigger = screen.getByText(/Lot realisations \(1\)/);
    fireEvent.click(trigger.closest('button') ?? trigger);

    expect(screen.queryByText('Term')).toBeNull();
  });
});

describe('TaxSummaryPage — wash-sale flag table columns (AC 7.10, task 10 regression guard)', () => {
  it('keeps the "Lot opened" and "Realised" headers and values on the flag table', () => {
    mockJurisdiction('US');
    mockLotMethod('average');
    mockSummary(
      baseSummary({
        jurisdiction: 'US',
        lotMethod: 'average',
        flags: {
          washSales: [
            {
              lossRowId: 'exit-9:entry-9',
              positionId: 'pos-9',
              symbol: 'TSLA',
              underlying: null,
              side: 'long',
              openedAt: '2025-01-01',
              closedAt: '2025-02-01',
              realisedAt: '2025-02-01',
              lotEntryFillId: 'entry-9',
              lotOpenedAt: '2025-01-01',
              realisedLoss: '-50',
              reason: 'repurchase_within_30_days',
              counterpartyPositionIds: ['pos-10'],
              counterpartyLotIds: ['entry-10'],
            },
            // A still-open position's loss (AC 7.7) carries no lot open date —
            // the "when the flag carries one" half of AC 7.10 (the dash
            // fallback for a null lotOpenedAt).
            {
              lossRowId: 'exit-11:entry-11',
              positionId: 'pos-11',
              symbol: 'NVDA',
              underlying: null,
              side: 'long',
              openedAt: '2025-03-01',
              closedAt: null,
              realisedAt: '2025-03-20',
              lotEntryFillId: null,
              lotOpenedAt: null,
              realisedLoss: '-20',
              reason: 'held_open_in_30d_window',
              counterpartyPositionIds: [],
              counterpartyLotIds: [],
            },
          ],
          superficialLosses: [],
        },
      }),
    );

    render(<TaxSummaryPage />);

    const trigger = screen.getByText(/Wash sales \(2\)/);
    fireEvent.click(trigger.closest('button') ?? trigger);

    expect(screen.getByText('Lot opened')).toBeTruthy();
    expect(screen.getByText('Realised')).toBeTruthy();
    expect(screen.queryByText('Opened')).toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();

    // Symbol and Underlying render in the same row (underlying falls back to
    // symbol when null, AC 7.8), so either matching cell's row is the row.
    const tslaRow = screen.getAllByText('TSLA')[0]?.closest('tr');
    expect(tslaRow?.textContent).toContain('2025-01-01');
    expect(tslaRow?.textContent).toContain('2025-02-01');

    const nvdaRow = screen.getAllByText('NVDA')[0]?.closest('tr');
    expect(nvdaRow?.textContent).toContain('—');
    expect(nvdaRow?.textContent).toContain('2025-03-20');
  });
});
