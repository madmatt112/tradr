// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: { current: { data: { basis: 'cash' }, isLoading: false } as Record<string, unknown> },
  mutate: vi.fn(),
}));

vi.mock('@/features/calculator/hooks/useBuyingPowerBasis', () => ({
  useBuyingPowerBasisQuery: () => state.query.current,
  useBuyingPowerBasisMutation: () => ({ mutate: state.mutate, isPending: false }),
}));

// Native <select> stand-in for the shadcn primitive — Radix's pointer-capture
// machinery is browser-only (same approach as CalculatorForm.test.tsx).
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      data-testid="basis-select"
      value={value ?? ''}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { BuyingPowerBasisSelect } from './BuyingPowerBasisSelect';

beforeEach(() => {
  state.query.current = { data: { basis: 'cash' }, isLoading: false };
  state.mutate.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('BuyingPowerBasisSelect', () => {
  it('reflects the stored basis', () => {
    render(<BuyingPowerBasisSelect />);
    expect(screen.getByTestId<HTMLSelectElement>('basis-select').value).toBe('cash');
  });

  it('saves a change', () => {
    render(<BuyingPowerBasisSelect />);
    fireEvent.change(screen.getByTestId('basis-select'), { target: { value: 'balance' } });
    expect(state.mutate).toHaveBeenCalledWith('balance');
  });

  it('states that the risk percentage is unaffected', () => {
    // The single most likely misreading of this setting is that it changes how
    // much you risk. It does not — it changes only the size ceiling.
    render(<BuyingPowerBasisSelect />);
    expect(document.body.textContent).toMatch(/percentage of the account balance/i);
  });

  it('warns about the overshoot when the balance basis is selected', () => {
    state.query.current = { data: { basis: 'balance' }, isLoading: false };
    render(<BuyingPowerBasisSelect />);
    expect(document.body.textContent).toMatch(/larger than your available cash/i);
  });

  it('explains the protection when cash is selected', () => {
    render(<BuyingPowerBasisSelect />);
    expect(document.body.textContent).toMatch(/will not suggest a position you cannot fund/i);
  });

  it('renders a skeleton instead of a wrong value while loading', () => {
    state.query.current = { data: undefined, isLoading: true };
    render(<BuyingPowerBasisSelect />);
    expect(screen.queryByTestId('basis-select')).toBeNull();
  });
});
