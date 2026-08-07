// @vitest-environment jsdom
// CSV import — plan-tiers surfaces (design Component 12; REQ-10.3, REQ-11.5):
// the remaining-imports disclosure BEFORE staging, the disabled/badged
// non-writable account picker entries, and the TIER_LIMIT_CSV_IMPORTS refusal
// mapping (CODE only) with the upgrade path.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CsvPreviewResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { accountsData, tierData, commitState } = vi.hoisted(() => ({
  accountsData: { current: [] as unknown[] },
  tierData: { current: undefined as unknown },
  commitState: {
    current: { mutate: () => {}, isPending: false, data: undefined, error: null } as {
      mutate: (body: unknown) => void;
      isPending: boolean;
      data: unknown;
      error: unknown;
    },
  },
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accountsData.current, isLoading: false, isError: false }),
}));

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
}));

vi.mock('../hooks/useCsvPreview', () => ({
  useCsvPreview: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    data: undefined,
    error: null,
  }),
}));

vi.mock('../hooks/useCsvCommit', () => ({
  useCsvCommit: () => commitState.current,
}));

// Stub the shadcn Select primitive as a native <select> (Radix fights jsdom).
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

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    onClick,
    children,
    ...rest
  }: {
    to: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    children: React.ReactNode;
  }) => (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

// A PROBE, not a stub. The coach mark's own behaviour is covered next to it;
// what belongs HERE is the R7.5 wiring — that this page hands it the same
// remaining-imports figure the disclosure above is computed from, so a user
// whose lifetime allowance is spent is not introduced to a feature the commit
// path will refuse. Rendering only when `available` makes that assertable
// without a QueryClient.
vi.mock('@/features/onboarding/components/CoachMark', () => ({
  CoachMark: ({ surface, available = true }: { surface: string; available?: boolean }) =>
    available ? <div data-testid={`coach-mark-${surface}`} /> : null,
}));

import { AccountPicker } from './AccountPicker';
import { CommitPanel } from './CommitPanel';
import { ImportPage } from './ImportPage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

const FREE_LIMITS = {
  accounts: 1,
  positions: 1000,
  lookbackMonths: 6,
  platformTurns: 50,
  images: 20,
  csvImports: 3,
};
const PRO_LIMITS = {
  accounts: null,
  positions: null,
  lookbackMonths: null,
  platformTurns: 500,
  images: 200,
  csvImports: null,
};

function tierFixture(
  usage: { accountsUsed: number; writableAccountId: string | null; csvUsed: number } | null,
  purchasable = true,
) {
  return {
    gatingEnabled: true,
    exempt: false,
    tier: 'free' as const,
    purchasable,
    subscription: null,
    limits: { free: FREE_LIMITS, pro: PRO_LIMITS },
    usage:
      usage === null
        ? null
        : {
            accounts: { used: usage.accountsUsed, writableAccountId: usage.writableAccountId },
            positions: { used: 0 },
            platformTurns: { allowanceUsed: 0 },
            images: { used: 0 },
            csvImports: { used: usage.csvUsed },
          },
  };
}

const PREVIEW = {
  token: '33333333-3333-3333-3333-333333333333',
  committable: true,
  requiresDuplicateAffirmation: false,
} as unknown as CsvPreviewResponse;

beforeEach(() => {
  accountsData.current = [
    { id: ACCOUNT_A, name: 'Main', currency: 'USD' },
    { id: ACCOUNT_B, name: 'Swing', currency: 'EUR' },
  ];
  tierData.current = undefined;
  commitState.current = { mutate: vi.fn(), isPending: false, data: undefined, error: null };
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Remaining-imports disclosure BEFORE staging (REQ-10.3)
// ---------------------------------------------------------------------------

describe('ImportPage — remaining CSV imports before staging', () => {
  it('shows the remaining lifetime allowance from usage.csvImports', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_A,
      csvUsed: 1,
    });
    render(<ImportPage />);

    const notice = screen.getByTestId('csv-imports-remaining');
    expect(notice.textContent).toContain('2 of 3 CSV imports remaining');
    // Not exhausted — no upgrade CTA yet.
    expect(screen.queryByTestId('upgrade-cta-csv-import')).toBeNull();
  });

  it('shows 0 remaining with the upgrade CTA once the allowance is used up', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_A,
      csvUsed: 3,
    });
    render(<ImportPage />);

    expect(screen.getByTestId('csv-imports-remaining').textContent).toContain(
      '0 of 3 CSV imports remaining',
    );
    expect(screen.getByTestId('upgrade-cta-csv-import')).toBeTruthy();
  });

  it('renders nothing when usage is null (gating off / self-host)', () => {
    tierData.current = tierFixture(null);
    render(<ImportPage />);
    expect(screen.queryByTestId('csv-imports-remaining')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The coach mark is gated on the same figure (user-onboarding R7.5)
// ---------------------------------------------------------------------------

describe('ImportPage — coach-mark availability', () => {
  it('offers the mark while imports remain', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_A,
      csvUsed: 1,
    });
    render(<ImportPage />);
    expect(screen.getByTestId('coach-mark-csv-import')).toBeTruthy();
  });

  it('withholds it once the lifetime allowance is spent', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_A,
      csvUsed: 3,
    });
    render(<ImportPage />);
    expect(screen.queryByTestId('coach-mark-csv-import')).toBeNull();
  });

  it('offers it on a self-host / gating-off instance, where there is no cap', () => {
    tierData.current = tierFixture(null);
    render(<ImportPage />);
    expect(screen.getByTestId('coach-mark-csv-import')).toBeTruthy();
  });

  it('withholds it until the tier read lands, rather than showing then retracting', () => {
    tierData.current = undefined;
    render(<ImportPage />);
    expect(screen.queryByTestId('coach-mark-csv-import')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Account picker — non-writable accounts disabled/badged (D18)
// ---------------------------------------------------------------------------

describe('AccountPicker — writability (D18)', () => {
  it('disables and badges non-writable accounts when over the cap', () => {
    tierData.current = tierFixture({
      accountsUsed: 2,
      writableAccountId: ACCOUNT_A,
      csvUsed: 0,
    });
    render(<AccountPicker value={null} onChange={vi.fn()} />);

    const options = Array.from(document.querySelectorAll('option'));
    const optionA = options.find((o) => o.value === ACCOUNT_A)!;
    const optionB = options.find((o) => o.value === ACCOUNT_B)!;
    expect(optionA.disabled).toBe(false);
    expect(optionA.textContent).not.toContain('read-only');
    expect(optionB.disabled).toBe(true);
    expect(optionB.textContent).toContain('read-only on your plan');
  });

  it('keeps every account enabled when tier usage is absent (self-host parity)', () => {
    tierData.current = undefined;
    render(<AccountPicker value={null} onChange={vi.fn()} />);

    for (const option of Array.from(document.querySelectorAll('option'))) {
      expect(option.disabled).toBe(false);
      expect(option.textContent).not.toContain('read-only');
    }
  });
});

// ---------------------------------------------------------------------------
// Commit refusal mapping — TIER_LIMIT_CSV_IMPORTS (CODE only)
// ---------------------------------------------------------------------------

describe('CommitPanel — TIER_LIMIT_CSV_IMPORTS mapping', () => {
  it('maps the code to the staged-preview-survives copy with the upgrade CTA', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_A,
      csvUsed: 3,
    });
    commitState.current = {
      mutate: vi.fn(),
      isPending: false,
      data: undefined,
      error: {
        status: 403,
        error: { code: 'TIER_LIMIT_CSV_IMPORTS', message: 'server text is not branched on' },
      },
    };
    render(<CommitPanel preview={PREVIEW} onRePreview={vi.fn()} isRePreviewing={false} />);

    const banner = screen.getByTestId('csv-tier-refusal');
    expect(banner.textContent).toContain("plan's CSV import limit");
    expect(banner.textContent).toContain('without re-uploading');
    expect(screen.getByTestId('upgrade-cta-csv-import')).toBeTruthy();
    // The server text was NOT rendered — mapping branches on the code.
    expect(screen.queryByText('server text is not branched on')).toBeNull();
    // Non-blocking: the same token stays re-committable after an upgrade.
    const confirm = screen.getByRole('button', { name: 'Confirm import' });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders other refusals as the plain message (no tier banner)', () => {
    commitState.current = {
      mutate: vi.fn(),
      isPending: false,
      data: undefined,
      error: { status: 500, error: { code: 'INTERNAL', message: 'Something broke' } },
    };
    render(<CommitPanel preview={PREVIEW} onRePreview={vi.fn()} isRePreviewing={false} />);

    expect(screen.queryByTestId('csv-tier-refusal')).toBeNull();
    expect(screen.getByText('Something broke')).toBeTruthy();
  });
});
