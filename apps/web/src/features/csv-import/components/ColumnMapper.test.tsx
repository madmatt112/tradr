// @vitest-environment jsdom
// ColumnMapper — contract-form / expiry-format selectors, preset fill, and the
// preset-only field rows (design Component 10; REQ-5.4, REQ-2.1, REQ-2.2,
// REQ-3.4 client half, REQ-4.1).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub the shadcn Select primitive as a native <select> (Radix fights jsdom) —
// the same shape ImportPage.tier.test.tsx uses.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value ?? ''} onChange={(e) => onValueChange(e.currentTarget.value)}>
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

import { ColumnMapper, type ColumnMapperValue } from './ColumnMapper';

// Real export sample headers (packages/shared/.../csv-import-samples).
const TRADEZELLA_COLUMNS = [
  'Date',
  'Time',
  'Symbol',
  'Buy/Sell',
  'Quantity',
  'Price',
  'Spread',
  'Expiration',
  'Strike',
  'Call/Put',
  'Commission',
  'Fees',
];
const TRADERVUE_COLUMNS = [
  'Time',
  'Date',
  'Quantity',
  'Symbol',
  'Side',
  'Price',
  'Option',
  'Commission',
  'TransFee',
  'ECNFee',
];
const IBKR_COLUMNS = [
  'Symbol',
  'Description',
  'UnderlyingSymbol',
  'Strike',
  'Expiry',
  'Put/Call',
  'Multiplier',
  'AssetClass',
  'Buy/Sell',
  'Open/CloseIndicator',
  'Quantity',
  'TradePrice',
  'IBCommission',
  'DateTime',
  'Notes/Codes',
];
const GENERIC_COLUMNS = ['Symbol', 'AssetType', 'Action', 'Quantity', 'Price', 'FilledAt', 'Fees'];

function makeValue(overrides: Partial<ColumnMapperValue> = {}): ColumnMapperValue {
  return {
    presetId: null,
    rowShape: 'execution',
    mapping: {
      rowShape: 'execution',
      columns: {},
      contractForm: 'occ-symbol',
      expiryFormat: 'iso',
    },
    timezone: 'UTC',
    dateFormat: 'iso',
    numberFormat: 'us',
    ...overrides,
  };
}

// Locate the preset <select> by one of its option labels and fire a change.
function choosePreset(label: string, presetId: string) {
  const option = screen.getByRole('option', { name: label });
  const select = option.closest('select');
  expect(select).not.toBeNull();
  fireEvent.change(select as HTMLSelectElement, { target: { value: presetId } });
}

afterEach(() => {
  cleanup();
});

describe('ColumnMapper — preset fill', () => {
  it('fills the composed contract form, expiry format, synonym and expiry column for tradezella', () => {
    const onChange = vi.fn();
    render(<ColumnMapper columns={TRADEZELLA_COLUMNS} value={makeValue()} onChange={onChange} />);

    choosePreset('TradeZella (generic CSV)', 'tradezella');

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ColumnMapperValue;
    expect(next.mapping.transforms?.assetType?.Single).toBe('option');
    expect(next.mapping.contractForm).toBe('composed');
    expect(next.mapping.expiryFormat).toBe('dd-mon-yy');
    expect(next.mapping.columns.expiry).toBe('Expiration');
  });

  it('fills the descriptor form and descriptor column for tradervue', () => {
    const onChange = vi.fn();
    render(<ColumnMapper columns={TRADERVUE_COLUMNS} value={makeValue()} onChange={onChange} />);

    choosePreset('Tradervue (generic import)', 'tradervue');

    const next = onChange.mock.calls[0][0] as ColumnMapperValue;
    expect(next.mapping.contractForm).toBe('descriptor');
    expect(next.mapping.columns.descriptor).toBe('Option');
  });
});

describe('ColumnMapper — contract-form selectors', () => {
  it('shows the expiry-format selector only under the composed form', () => {
    const { rerender } = render(
      <ColumnMapper columns={TRADEZELLA_COLUMNS} value={makeValue()} onChange={vi.fn()} />,
    );
    // occ-symbol default: no expiry-format selector.
    expect(screen.queryByText('Expiry format')).toBeNull();

    rerender(
      <ColumnMapper
        columns={TRADEZELLA_COLUMNS}
        value={makeValue({
          mapping: {
            rowShape: 'execution',
            columns: {},
            contractForm: 'composed',
            expiryFormat: 'dd-mon-yy',
          },
        })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Expiry format')).toBeTruthy();
  });

  it('renders a single descriptor row and a disabled descriptor item under the descriptor form', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ColumnMapper columns={TRADERVUE_COLUMNS} value={makeValue()} onChange={onChange} />,
    );
    choosePreset('Tradervue (generic import)', 'tradervue');
    const applied = onChange.mock.calls[0][0] as ColumnMapperValue;

    rerender(<ColumnMapper columns={TRADERVUE_COLUMNS} value={applied} onChange={onChange} />);

    // Exactly one descriptor field row (deduped against the shape list).
    expect(screen.getAllByText('Option descriptor (set by preset)')).toHaveLength(1);
    // The contract-form select exposes descriptor only as a disabled item.
    const descriptorItem = screen.getByRole('option', {
      name: 'Descriptor column (set by preset)',
    });
    expect((descriptorItem as HTMLOptionElement).disabled).toBe(true);
  });
});

describe('ColumnMapper — preset-only field rows', () => {
  it('renders no Multiplier / Notes-Codes rows for generic-execution', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ColumnMapper columns={GENERIC_COLUMNS} value={makeValue()} onChange={onChange} />,
    );
    choosePreset('Generic execution (one row per fill)', 'generic-execution');
    const applied = onChange.mock.calls[0][0] as ColumnMapperValue;

    rerender(<ColumnMapper columns={GENERIC_COLUMNS} value={applied} onChange={onChange} />);

    expect(screen.queryByText('Multiplier (set by preset)')).toBeNull();
    expect(screen.queryByText('Notes/Codes (set by preset)')).toBeNull();
  });

  it('renders Multiplier and Notes-Codes rows for interactive-brokers', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ColumnMapper columns={IBKR_COLUMNS} value={makeValue()} onChange={onChange} />,
    );
    choosePreset('Interactive Brokers (Flex Query — Trades)', 'interactive-brokers');
    const applied = onChange.mock.calls[0][0] as ColumnMapperValue;

    rerender(<ColumnMapper columns={IBKR_COLUMNS} value={applied} onChange={onChange} />);

    expect(screen.getByText('Multiplier (set by preset)')).toBeTruthy();
    expect(screen.getByText('Notes/Codes (set by preset)')).toBeTruthy();
  });
});
