// @vitest-environment jsdom
// ImportPage — label-override sanitization before commit (fix round 1, task 19
// review finding): the server's `labelOverrideSchema` is
// `trim().min(1).max(40)` with no nullable variant
// (packages/shared/src/schemas/position.ts), so a blank, whitespace-only, or
// over-length override must never reach `CommitPanel`'s request body, or the
// whole commit 400s.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CsvPreviewResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { commitMutate } = vi.hoisted(() => ({ commitMutate: vi.fn() }));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({
    data: [{ id: '11111111-1111-4111-a111-111111111111', name: 'Main', currency: 'USD' }],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: undefined }),
}));

vi.mock('../hooks/useCsvPreview', () => ({
  useCsvPreview: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    data: PREVIEW,
    error: null,
  }),
}));

vi.mock('../hooks/useCsvCommit', () => ({
  useCsvCommit: () => ({ mutate: commitMutate, isPending: false, data: undefined, error: null }),
}));

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
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

vi.mock('@/features/onboarding/components/CoachMark', () => ({
  CoachMark: () => null,
}));

import { ImportPage } from './ImportPage';

const PREVIEW = {
  token: '33333333-3333-4333-a333-333333333333',
  summary: { rowsParsed: 2, rowsValid: 2, rowsWithErrors: 0, positions: 2, fills: 2 },
  positions: [
    {
      scope: { symbol: 'AAPL260320C250', assetType: 'option' },
      side: 'long',
      closes: false,
      fills: [
        {
          type: 'entry',
          price: '5.00',
          quantity: '1',
          fees: '0',
          filledAt: '2026-05-01T14:30:00Z',
          sourceRow: 2,
        },
      ],
    },
    {
      scope: { symbol: 'AAPL260320C260', assetType: 'option' },
      side: 'short',
      closes: false,
      fills: [
        {
          type: 'entry',
          price: '2.00',
          quantity: '1',
          fees: '0',
          filledAt: '2026-05-01T14:31:00Z',
          sourceRow: 3,
        },
      ],
    },
  ],
  errors: [],
  warnings: [],
  timezone: 'UTC',
  committable: true,
  requiresDuplicateAffirmation: false,
  groupProposals: [{ id: 'g1', legRefs: [0, 1], label: 'BCS', basis: 'order_id' }],
} as unknown as CsvPreviewResponse;

beforeEach(() => {
  commitMutate.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ImportPage — label override sanitization before commit', () => {
  it('omits the key rather than sending an empty/whitespace override', () => {
    render(<ImportPage />);

    fireEvent.change(screen.getByTestId('group-proposal-label-g1'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    expect(commitMutate).toHaveBeenCalledTimes(1);
    expect(commitMutate.mock.calls[0][0].labelOverrides).toEqual({});
  });

  it('trims surrounding whitespace and caps the override at 40 characters', () => {
    render(<ImportPage />);

    fireEvent.change(screen.getByTestId('group-proposal-label-g1'), {
      target: { value: `  ${'A'.repeat(50)}  ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    expect(commitMutate).toHaveBeenCalledTimes(1);
    expect(commitMutate.mock.calls[0][0].labelOverrides).toEqual({ g1: 'A'.repeat(40) });
  });
});
