// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcbDispositionRow, TaxSummaryResponse } from '@tradr/shared/schemas/expense';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  mockUseTaxSummary,
  mockUseTaxJurisdictionQuery,
  mockUseTaxJurisdictionMutation,
  mockUseTaxLotMethodQuery,
} = vi.hoisted(() => ({
  mockUseTaxSummary: vi.fn(),
  mockUseTaxJurisdictionQuery: vi.fn(),
  mockUseTaxJurisdictionMutation: vi.fn(),
  mockUseTaxLotMethodQuery: vi.fn(),
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
  useTaxLotMethodMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/features/accounting/hooks/useMissingRatePrompt', () => ({
  useMissingRatePrompt: () => ({
    shouldPrompt: false,
    missingPair: null,
    missingPairs: [],
    deeplinkTo: null,
  }),
}));

// Same Select stub as TaxSummaryPage.lots.test.tsx — Radix's real Select
// needs pointer-capture APIs jsdom lacks.
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

/** The <select> whose <option>s include one with the given visible text. */
function selectByOptionText(text: string): HTMLSelectElement {
  const selects = Array.from(document.querySelectorAll('select'));
  for (const s of selects) {
    if (Array.from(s.options).some((o) => o.textContent === text)) return s;
  }
  throw new Error(`no <select> with option text="${text}"`);
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
      shortTerm: null,
      longTerm: null,
    },
    trackedExpenses: { total: '0', perCurrency: [], perCategory: [] },
    flags: { washSales: [], superficialLosses: [] },
    lotRealisations: [],
    missingRates: [],
    excludedCurrencies: [],
    ratesAsOf: null,
    usedRates: [],
    disclaimer: 'Tax figures are estimates only.',
    acbDispositions: [],
    acbMissingRates: [],
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

function mockMethod(
  taxLotMethod: 'fifo' | 'average' | null,
  effectiveMethod: 'fifo' | 'average' | 'acb',
): void {
  mockUseTaxLotMethodQuery.mockReturnValue({
    data: { taxLotMethod, effectiveMethod, isDefault: taxLotMethod === null },
  });
}

function acbRow(overrides: Partial<AcbDispositionRow> = {}): AcbDispositionRow {
  return {
    exitFillId: 'exit-1',
    positionId: 'pos-1',
    accountId: 'acct-1',
    symbol: 'XYZ',
    currency: 'CAD',
    tradeDate: '2025-03-02',
    realisedAt: '2025-03-02T16:00:00.000Z',
    quantity: '50',
    cadRate: null,
    proceeds: '600.00',
    outlays: '0.00',
    acb: '520.00',
    gain: '80.00',
    unpricedReason: null,
    ...overrides,
  };
}

describe('TaxSummaryPage — acb method control (design C2, AC 2.4)', () => {
  it('shows the lot method control disabled on "Adjusted cost base (pooled)" with the Canada line when the effective method is acb', () => {
    mockJurisdiction('CA');
    mockMethod(null, 'acb');
    mockSummary(baseSummary({ jurisdiction: 'CA', lotMethod: 'acb' }));

    render(<TaxSummaryPage />);

    const methodSelect = selectByOptionText('Adjusted cost base (pooled)');
    expect(methodSelect.disabled).toBe(true);
    expect(
      screen.getByText('Canada uses one pooled ACB per security across your taxable accounts.'),
    ).toBeTruthy();
  });
});

describe('TaxSummaryPage — Dispositions table (design C5, AC 5.4)', () => {
  it('shows the pooled-ACB note and a Dispositions collapsible with one line per row and the nine column headers', () => {
    mockJurisdiction('CA');
    mockMethod(null, 'acb');
    mockSummary(
      baseSummary({
        jurisdiction: 'CA',
        lotMethod: 'acb',
        realisedPnl: {
          total: '113.65',
          perCurrency: [{ currency: 'CAD', amount: '113.65' }],
          shortTerm: null,
          longTerm: null,
        },
        acbDispositions: [
          acbRow({ exitFillId: 'exit-1', symbol: 'XYZ' }),
          acbRow({
            exitFillId: 'exit-2',
            symbol: 'ABC',
            currency: 'USD',
            tradeDate: '2025-04-01',
            realisedAt: '2025-04-01T14:00:00.000Z',
            quantity: '10',
            cadRate: '1.35',
            proceeds: '135.00',
            outlays: '1.35',
            acb: '100.00',
            gain: '33.65',
          }),
        ],
      }),
    );

    render(<TaxSummaryPage />);

    expect(
      screen.getByText(
        'Figures use the pooled ACB. The journal, ledger and performance use average cost per position.',
      ),
    ).toBeTruthy();

    const trigger = screen.getByText(/Dispositions \(2\)/);
    fireEvent.click(trigger.closest('button') ?? trigger);

    for (const header of [
      'Symbol',
      'Trade date',
      'Quantity',
      'Rate',
      'Proceeds',
      'Outlays',
      'ACB',
      'Gain',
      'Status',
    ]) {
      expect(screen.getByText(header)).toBeTruthy();
    }

    const rows = screen.getAllByText(/^(XYZ|ABC)$/).map((el) => el.closest('tr'));
    expect(new Set(rows).size).toBe(2);
  });
});

describe('TaxSummaryPage — unpriced disposition rows (design C5, AC 4.6)', () => {
  it('shows "—" in the money cells and the reason label for each unpriced reason', () => {
    mockJurisdiction('CA');
    mockMethod(null, 'acb');
    mockSummary(
      baseSummary({
        jurisdiction: 'CA',
        lotMethod: 'acb',
        trackedExpenses: { total: '50', perCurrency: [], perCategory: [] },
        acbDispositions: [
          acbRow({
            exitFillId: 'exit-mr',
            symbol: 'AAA',
            currency: 'USD',
            cadRate: null,
            proceeds: null,
            outlays: null,
            acb: null,
            gain: null,
            unpricedReason: 'missing_rate',
          }),
          acbRow({
            exitFillId: 'exit-pu',
            symbol: 'BBB',
            currency: 'USD',
            cadRate: null,
            proceeds: null,
            outlays: null,
            acb: null,
            gain: null,
            unpricedReason: 'pool_unpriced',
          }),
          acbRow({
            exitFillId: 'exit-ip',
            symbol: 'CCC',
            currency: 'CAD',
            cadRate: null,
            proceeds: null,
            outlays: null,
            acb: null,
            gain: null,
            unpricedReason: 'insufficient_pool',
          }),
        ],
      }),
    );

    render(<TaxSummaryPage />);

    const trigger = screen.getByText(/Dispositions \(3\)/);
    fireEvent.click(trigger.closest('button') ?? trigger);

    const aaaRow = screen.getAllByText('AAA')[0]?.closest('tr');
    const bbbRow = screen.getAllByText('BBB')[0]?.closest('tr');
    const cccRow = screen.getAllByText('CCC')[0]?.closest('tr');

    expect((aaaRow?.textContent?.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((bbbRow?.textContent?.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((cccRow?.textContent?.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(4);

    expect(aaaRow?.textContent).toContain('Missing rate');
    expect(bbbRow?.textContent).toContain('Pool unpriced');
    expect(cccRow?.textContent).toContain('Exceeds pool');
  });
});

describe('TaxSummaryPage — missing CAD rate notice (design C5, AC 4.8)', () => {
  it('lists each missing pair as "<currency> on <date>" with a link carrying only base and quote', () => {
    mockJurisdiction('CA');
    mockMethod(null, 'acb');
    mockSummary(
      baseSummary({
        jurisdiction: 'CA',
        lotMethod: 'acb',
        acbDispositions: [
          acbRow({
            exitFillId: 'exit-mr',
            symbol: 'AAA',
            currency: 'USD',
            cadRate: null,
            proceeds: null,
            outlays: null,
            acb: null,
            gain: null,
            unpricedReason: 'missing_rate',
          }),
        ],
        acbMissingRates: [
          { currency: 'USD', tradeDate: '2026-03-02' },
          { currency: 'EUR', tradeDate: '2026-01-15' },
        ],
      }),
    );

    render(<TaxSummaryPage />);

    const usdLink = screen.getByRole('link', { name: 'USD on 2026-03-02' });
    expect(usdLink.getAttribute('href')).toBe('/settings/profile?base=USD&quote=CAD');

    const eurLink = screen.getByRole('link', { name: 'EUR on 2026-01-15' });
    expect(eurLink.getAttribute('href')).toBe('/settings/profile?base=EUR&quote=CAD');
  });
});
