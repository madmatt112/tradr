// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Fill } from '@tradr/shared';

import { FillTable, formatFillValue } from './FillTable';

// FillTable only needs the delete mutation from this hook; stub it so the table
// renders without a QueryClient.
vi.mock('../hooks/usePosition', () => ({
  useDeleteFill: vi.fn(() => ({ mutate: vi.fn() })),
}));

// The edit dialog is exercised by its own suite; render nothing here.
vi.mock('./FillDialog', () => ({ FillDialog: () => null }));

afterEach(() => {
  cleanup();
});

function makeFill(overrides: Partial<Fill>): Fill {
  return {
    id: 'fill-1',
    positionId: 'pos-1',
    type: 'entry',
    price: '150.00000000',
    quantity: '100.00000000',
    fees: '1.00000000',
    notes: null,
    filledAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatFillValue', () => {
  it('caps at three decimal places', () => {
    expect(formatFillValue('150.12345678')).toBe('150.123');
  });

  it('trims trailing zeros so a short value does not grow', () => {
    expect(formatFillValue('150.50000000')).toBe('150.5');
    expect(formatFillValue('100.00000000')).toBe('100');
    expect(formatFillValue('0.00000000')).toBe('0');
  });

  it('keeps values that already have three or fewer places', () => {
    expect(formatFillValue('2.005')).toBe('2.005');
    expect(formatFillValue('1234.5')).toBe('1234.5');
  });
});

describe('FillTable', () => {
  it('renders price, quantity and fees with at most three decimals', () => {
    const fill = makeFill({
      price: '150.50000000',
      quantity: '100.00000000',
      fees: '1.23456789',
    });

    render(<FillTable fills={[fill]} positionId="pos-1" positionStatus="open" />);

    // getByText throws if the cell is missing, so these are the assertions.
    expect(screen.getByText('150.5').textContent).toBe('150.5');
    expect(screen.getByText('100').textContent).toBe('100');
    expect(screen.getByText('1.235').textContent).toBe('1.235');
    // No eight-decimal strings leak through.
    expect(screen.queryByText('150.50000000')).toBeNull();
  });
});
