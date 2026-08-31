// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Hoisted shared mock state (factories below run before module imports).
const { ACCOUNT_ID, ACCOUNT_B_ID, mutateAsync, accountsData, tierData } = vi.hoisted(() => ({
  ACCOUNT_ID: '11111111-1111-1111-1111-111111111111',
  ACCOUNT_B_ID: '22222222-2222-2222-2222-222222222222',
  mutateAsync: vi.fn(),
  accountsData: { current: [] as unknown[] },
  tierData: { current: undefined as unknown },
}));

// Mock the create mutation hook — assert against `mutateAsync`. Keep the real
// getPositionErrorCode (the dialog's tier-refusal mapping goes through it).
vi.mock('../hooks/usePositions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/usePositions')>();
  return {
    ...actual,
    useCreatePosition: () => ({ mutateAsync, isPending: false }),
  };
});

// Accounts are test-configurable (default: one) so the picker tests can add a
// second, non-writable one.
vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accountsData.current }),
}));

// Tier state is test-configurable; `undefined` (default) = self-host/loading,
// so the pre-tier tests run with zero tier UI (parity).
vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
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

// Stub the shadcn Dialog primitive (Radix portals/focus-trap fight jsdom).
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

// Stub the shadcn Select primitive as a native <select> so options are clickable
// in jsdom. SelectItem → <option>; the trigger/value chrome is dropped.
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

import { CreatePositionDialog } from './CreatePositionDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the <select> that carries an <option> with the given value. */
function selectByOptionValue(optionValue: string): HTMLSelectElement {
  const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
  for (const s of selects) {
    if (Array.from(s.options).some((o) => o.value === optionValue)) return s;
  }
  throw new Error(`no <select> with option value="${optionValue}"`);
}

function chooseAccount(): void {
  fireEvent.change(selectByOptionValue(ACCOUNT_ID), { target: { value: ACCOUNT_ID } });
}

function setAssetType(value: 'stock' | 'option'): void {
  fireEvent.change(selectByOptionValue('option'), { target: { value } });
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
}

function withQueryClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function renderDialog() {
  return render(<CreatePositionDialog open onOpenChange={vi.fn()} />, {
    wrapper: withQueryClient(),
  });
}

// ---------------------------------------------------------------------------
// Tier fixtures (plan-tiers)
// ---------------------------------------------------------------------------

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
  usage: {
    accountsUsed: number;
    writableAccountId: string | null;
    positionsUsed: number;
  } | null,
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
            positions: { used: usage.positionsUsed },
            platformTurns: { allowanceUsed: 0 },
            images: { used: 0 },
            csvImports: { used: 0 },
          },
  };
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue(undefined);
  accountsData.current = [{ id: ACCOUNT_ID, name: 'Main', currency: 'USD' }];
  tierData.current = undefined;
});

afterEach(() => {
  cleanup();
});

describe('CreatePositionDialog', () => {
  it('stock mode submits the raw ticker unchanged (no OCC encoding)', async () => {
    renderDialog();
    chooseAccount();

    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      }),
    );
  });

  it('switching to option shows structured fields, clears the symbol, and does not restore on toggle-back', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Preserved fields (Req 1.3): side/account/notes must survive toggling.
    chooseAccount();
    fireEvent.change(selectByOptionValue('short'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'keep me' } });

    // Stock: enter a ticker.
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('AAPL');

    // Toggle to option — structured fields appear, plain symbol input is gone.
    setAssetType('option');
    expect(screen.queryByLabelText('Symbol')).toBeNull();
    expect((screen.getByLabelText('Underlying') as HTMLInputElement).value).toBe('');

    // Fill every option input and switch Type → Put so the reset is observable.
    fireEvent.change(screen.getByLabelText('Underlying'), { target: { value: 'ZZZ' } });
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '2026-03-21' } });
    fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '150.00' } });
    await user.click(screen.getByRole('tab', { name: 'Put' }));
    expect(screen.getByRole('tab', { name: 'Put' }).getAttribute('data-state')).toBe('active');

    // Toggle back to stock — the ticker is NOT restored, but side/account/notes are.
    setAssetType('stock');
    expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('');
    expect(selectByOptionValue('short').value).toBe('short');
    expect(selectByOptionValue(ACCOUNT_ID).value).toBe(ACCOUNT_ID);
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('keep me');

    // Toggle to option again — every option input is reset (Type back to Call),
    // none restored.
    setAssetType('option');
    expect((screen.getByLabelText('Underlying') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Expiry') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Strike') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('tab', { name: 'Call' }).getAttribute('data-state')).toBe('active');
  });

  it('option mode submits the compact encoded symbol via the create mutation', async () => {
    renderDialog();
    chooseAccount();
    setAssetType('option');

    fireEvent.change(screen.getByLabelText('Underlying'), { target: { value: 'NVDA' } });
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '2026-03-21' } });
    fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '120' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        symbol: 'NVDA260321C120',
        assetType: 'option',
        side: 'long',
      }),
    );
  });

  it('accepts a trailing-zero strike (150.00) and submits the compact encoded symbol', async () => {
    renderDialog();
    chooseAccount();
    setAssetType('option');

    fireEvent.change(screen.getByLabelText('Underlying'), { target: { value: 'NVDA' } });
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '2026-03-21' } });
    // Trailing zeros match the `150.00` placeholder; the encoder normalises them.
    fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '150.00' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        symbol: 'NVDA260321C150',
        assetType: 'option',
        side: 'long',
      }),
    );
  });

  it('blocks a non-representable strike (1234.567) and shows the error on the strike field', async () => {
    renderDialog();
    chooseAccount();
    setAssetType('option');

    fireEvent.change(screen.getByLabelText('Underlying'), { target: { value: 'NVDA' } });
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '2026-03-21' } });
    fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '1234.567' } });
    fireEvent.click(createButton());

    await waitFor(() =>
      expect(document.getElementById('occ-strike-error')?.textContent).toContain('representable'),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('blocks submit when an option field is empty', async () => {
    renderDialog();
    chooseAccount();
    setAssetType('option');

    // Underlying + expiry filled, strike left empty.
    fireEvent.change(screen.getByLabelText('Underlying'), { target: { value: 'NVDA' } });
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '2026-03-21' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(document.getElementById('occ-strike-error')).not.toBeNull());
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The symbol field is a SymbolAutocomplete, not a plain input
// ---------------------------------------------------------------------------

describe('CreatePositionDialog — symbol entry', () => {
  // THE TRAP THIS FIELD SETS, AND WHY THE DIALOG WIRES TWO HANDLERS.
  //
  // `SymbolAutocomplete` reports a ticker through `onChange` only when it is
  // COMMITTED — a result is clicked, or Enter is pressed. Blur does not commit.
  // A dialog with a submit button therefore cannot rely on `onChange` alone:
  // the ordinary way to fill this form is to type four characters and reach for
  // Create, and that gesture commits nothing. Before `onQueryChange` was wired,
  // it submitted an empty symbol.
  //
  // This is the assertion that the typed text reaches the form without a
  // selection, which is what the field did when it was a plain input.
  it('submits a typed ticker that was never selected from the dropdown', async () => {
    renderDialog();
    chooseAccount();

    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({ symbol: 'AAPL' });
  });

  // The field uppercased on the server before; it does so on the way in now, so
  // what the user sees is what is submitted.
  it('uppercases a lowercase ticker', async () => {
    renderDialog();
    chooseAccount();

    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'aapl' } });
    fireEvent.click(createButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({ symbol: 'AAPL' });
  });

  // The walkthrough anchors its "Symbol, side and account" step to `#symbol`.
  // The autocomplete forwards `id` to its inner input, so the anchor survived
  // the swap — but nothing else guarantees that, and a tour that points at
  // nothing ends without a word.
  it('keeps the #symbol id the walkthrough anchors to', () => {
    renderDialog();

    const field = document.querySelector('#symbol');
    expect(field).not.toBeNull();
    expect(field!.tagName).toBe('INPUT');
  });
});

// ---------------------------------------------------------------------------
// Default-account preselection
// ---------------------------------------------------------------------------

describe('CreatePositionDialog — default-account preselection', () => {
  it('preselects the default account while the field is untouched', async () => {
    accountsData.current = [
      { id: ACCOUNT_ID, name: 'Main', currency: 'USD' },
      { id: ACCOUNT_B_ID, name: 'Swing', currency: 'EUR', isDefault: true },
    ];
    renderDialog();

    await waitFor(() => {
      expect(selectByOptionValue(ACCOUNT_ID).value).toBe(ACCOUNT_B_ID);
    });
  });

  it('never overwrites an account the user picked', async () => {
    accountsData.current = [
      { id: ACCOUNT_ID, name: 'Main', currency: 'USD' },
      { id: ACCOUNT_B_ID, name: 'Swing', currency: 'EUR', isDefault: true },
    ];
    const { rerender } = renderDialog();
    await waitFor(() => {
      expect(selectByOptionValue(ACCOUNT_ID).value).toBe(ACCOUNT_B_ID);
    });

    chooseAccount();
    rerender(<CreatePositionDialog open onOpenChange={vi.fn()} />);
    expect(selectByOptionValue(ACCOUNT_ID).value).toBe(ACCOUNT_ID);
  });

  // The native-select stub cannot show an empty value (it snaps to its first
  // option), so "still empty" is proven the way the form itself proves it: a
  // submit fails the accountId validation and the mutation never fires.
  async function expectAccountStillEmpty(): Promise<void> {
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.click(createButton());
    await screen.findByText('Select an account');
    expect(mutateAsync).not.toHaveBeenCalled();
  }

  it('leaves the field empty when no account is the default', async () => {
    accountsData.current = [
      { id: ACCOUNT_ID, name: 'Main', currency: 'USD' },
      { id: ACCOUNT_B_ID, name: 'Swing', currency: 'EUR' },
    ];
    renderDialog();
    await expectAccountStillEmpty();
  });

  it('withholds the preselect when the default account is not writable (D18)', async () => {
    accountsData.current = [
      { id: ACCOUNT_ID, name: 'Main', currency: 'USD' },
      { id: ACCOUNT_B_ID, name: 'Swing', currency: 'EUR', isDefault: true },
    ];
    // Over-cap on enforced free with Main designated — the default (Swing) is
    // read-only, and preselecting a disabled option would invite the 403.
    tierData.current = tierFixture({
      accountsUsed: 2,
      writableAccountId: ACCOUNT_ID,
      positionsUsed: 0,
    });
    renderDialog();
    await expectAccountStillEmpty();
  });
});

// ---------------------------------------------------------------------------
// Plan tiers (design Component 12; REQ-6.4, REQ-11.5/11.6)
// ---------------------------------------------------------------------------

describe('CreatePositionDialog — plan tiers', () => {
  function submitStock(): void {
    chooseAccount();
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AAPL' } });
    fireEvent.click(createButton());
  }

  it('disables and badges non-writable accounts in the picker (D18)', () => {
    accountsData.current = [
      { id: ACCOUNT_ID, name: 'Main', currency: 'USD' },
      { id: ACCOUNT_B_ID, name: 'Swing', currency: 'EUR' },
    ];
    // Over-cap (2 used > cap 1) on enforced free — only Main is writable.
    tierData.current = tierFixture({
      accountsUsed: 2,
      writableAccountId: ACCOUNT_ID,
      positionsUsed: 0,
    });
    renderDialog();

    const picker = selectByOptionValue(ACCOUNT_ID);
    const optionA = Array.from(picker.options).find((o) => o.value === ACCOUNT_ID)!;
    const optionB = Array.from(picker.options).find((o) => o.value === ACCOUNT_B_ID)!;
    expect(optionA.disabled).toBe(false);
    expect(optionA.textContent).not.toContain('read-only');
    expect(optionB.disabled).toBe(true);
    expect(optionB.textContent).toContain('read-only on your plan');
  });

  it('keeps every account enabled with no badges when tier usage is absent (self-host parity)', () => {
    accountsData.current = [
      { id: ACCOUNT_ID, name: 'Main', currency: 'USD' },
      { id: ACCOUNT_B_ID, name: 'Swing', currency: 'EUR' },
    ];
    tierData.current = undefined;
    renderDialog();

    const picker = selectByOptionValue(ACCOUNT_ID);
    for (const option of Array.from(picker.options)) {
      expect(option.disabled).toBe(false);
      expect(option.textContent).not.toContain('read-only');
    }
    expect(screen.queryByTestId('tier-positions-hint')).toBeNull();
  });

  it('maps TIER_LIMIT_POSITIONS to the inline refusal with the upgrade CTA and stays open', async () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_ID,
      positionsUsed: 1000,
    });
    mutateAsync.mockRejectedValue({
      status: 403,
      error: { code: 'TIER_LIMIT_POSITIONS', message: 'server text is not branched on' },
    });
    const onOpenChange = vi.fn();
    render(<CreatePositionDialog open onOpenChange={onOpenChange} />, {
      wrapper: withQueryClient(),
    });

    submitStock();

    const banner = await screen.findByTestId('position-tier-refusal');
    expect(banner.getAttribute('data-error-code')).toBe('TIER_LIMIT_POSITIONS');
    expect(banner.textContent).toContain("plan's position limit");
    expect(screen.getByTestId('upgrade-cta-position-dialog')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('maps TIER_ACCOUNT_NOT_WRITABLE to the read-only refusal copy', async () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_ID,
      positionsUsed: 0,
    });
    mutateAsync.mockRejectedValue({
      status: 403,
      error: { code: 'TIER_ACCOUNT_NOT_WRITABLE', message: 'nope' },
    });
    renderDialog();

    submitStock();

    const banner = await screen.findByTestId('position-tier-refusal');
    expect(banner.getAttribute('data-error-code')).toBe('TIER_ACCOUNT_NOT_WRITABLE');
    expect(banner.textContent).toContain('read-only on your plan');
  });

  it('renders no tier banner for other refusal codes (the toast owns them)', async () => {
    mutateAsync.mockRejectedValue({
      status: 422,
      error: { code: 'VALIDATION_ERROR', message: 'Bad input' },
    });
    renderDialog();

    submitStock();

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('position-tier-refusal')).toBeNull();
  });

  it('shows the ≥80% L2 hint from tier usage (REQ-11.6)', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_ID,
      positionsUsed: 850,
    });
    renderDialog();

    expect(screen.getByTestId('tier-positions-hint').textContent).toBe(
      '150 positions left on your plan',
    );
  });

  it('shows no L2 hint below the 80% threshold', () => {
    tierData.current = tierFixture({
      accountsUsed: 1,
      writableAccountId: ACCOUNT_ID,
      positionsUsed: 100,
    });
    renderDialog();

    expect(screen.queryByTestId('tier-positions-hint')).toBeNull();
  });
});
