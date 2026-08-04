// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PositionDetail } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Hoisted mock state — assert against `mutateAsync`.
const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

// Mock the update mutation hook (the only hook PositionEditDialog calls).
vi.mock('../hooks/usePosition', () => ({
  useUpdatePosition: () => ({ mutateAsync, isPending: false }),
}));

// Stub the shadcn Dialog primitive (Radix portals/focus-trap fight jsdom).
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { PositionEditDialog } from './PositionEditDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePosition(overrides: Partial<PositionDetail> = {}): PositionDetail {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    accountId: '33333333-3333-3333-3333-333333333333',
    accountTimezone: 'America/New_York',
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    status: 'draft',
    notes: null,
    openedAt: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    fills: [],
    avgEntryPrice: null,
    avgExitPrice: null,
    totalEntryQuantity: 0,
    totalExitQuantity: 0,
    realizedPnl: null,
    returnPercentage: null,
    brokerageName: null,
    grossPnl: null,
    brokerageFees: 0,
    netPnl: null,
    targetPrice: null,
    stopLoss: null,
    targetRR: null,
    actualRR: null,
    openUnits: 0,
    closedUnits: 0,
    openCostBasis: 0,
    ...overrides,
  };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('PositionEditDialog', () => {
  it('draft option (parseable) prefills OptionContractFields with normalised values and PUTs a re-encoded symbol', async () => {
    const position = makePosition({
      assetType: 'option',
      status: 'draft',
      symbol: 'NVDA260321C120',
      notes: 'old',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    // Prefilled, NORMALISED (parse yields strike "120.000"; decodeContract → "120").
    expect((screen.getByLabelText('Underlying') as HTMLInputElement).value).toBe('NVDA');
    expect((screen.getByLabelText('Expiry') as HTMLInputElement).value).toBe('2026-03-21');
    expect((screen.getByLabelText('Strike') as HTMLInputElement).value).toBe('120');
    // No inline raw Symbol field in the structured branch.
    expect(screen.queryByLabelText('Symbol')).toBeNull();

    fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '130' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'updated' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      symbol: 'NVDA260321C130',
      assetType: 'option',
      notes: 'updated',
      targetPrice: null,
      stopLoss: null,
    });
  });

  it('draft option (legacy non-OCC) opens the inline raw Symbol field, not OptionContractFields', () => {
    const position = makePosition({
      assetType: 'option',
      status: 'draft',
      symbol: 'AAPL 260620C100',
      notes: 'legacy',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('AAPL 260620C100');
    // Structured fields are absent on the legacy path.
    expect(screen.queryByLabelText('Underlying')).toBeNull();
    expect(screen.queryByLabelText('Strike')).toBeNull();
  });

  it('legacy notes-only save omits symbol AND assetType (PUT { notes })', async () => {
    const position = makePosition({
      assetType: 'option',
      status: 'draft',
      symbol: 'AAPL 260620C100',
      notes: 'legacy',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    // Symbol left untouched; only notes change.
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'new note' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // Exact payload — proves symbol + assetType are omitted (route edge refine untriggered).
    // Plan fields ride along on every save (null when the inputs are empty).
    expect(mutateAsync).toHaveBeenCalledWith({
      notes: 'new note',
      targetPrice: null,
      stopLoss: null,
    });
  });

  it('legacy changed-but-invalid symbol blocks submit', async () => {
    const position = makePosition({
      assetType: 'option',
      status: 'draft',
      symbol: 'AAPL 260620C100',
      notes: 'legacy',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'NOTVALID!' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(document.getElementById('edit-symbol-error')).not.toBeNull());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('legacy changed-to-valid OCC symbol PUTs { symbol, assetType:option, notes }', async () => {
    // Legacy non-OCC symbol ('AAPL') opens the inline raw Symbol field.
    const position = makePosition({
      assetType: 'option',
      status: 'draft',
      symbol: 'AAPL',
      notes: 'legacy',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('AAPL');

    // Change it to a valid compact OCC symbol and save.
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'NVDA260321C120' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // The route would 400 unless symbol + assetType:'option' + notes are all present.
    expect(mutateAsync).toHaveBeenCalledWith({
      symbol: 'NVDA260321C120',
      assetType: 'option',
      notes: 'legacy',
      targetPrice: null,
      stopLoss: null,
    });
  });

  it('structured encode failure (unrepresentable strike) blocks save and errors the strike field', async () => {
    const position = makePosition({
      assetType: 'option',
      status: 'draft',
      symbol: 'NVDA260321C120',
      notes: 'old',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    // Edit strike to a value the encoder rejects (OCC_STRIKE_NOT_REPRESENTABLE).
    fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '1234.567' } });
    fireEvent.click(saveButton());

    // Save is blocked; occErrorField attaches the error to the strike field.
    await waitFor(() => expect(document.getElementById('occ-strike-error')).not.toBeNull());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('open position is notes-only (no contract inputs) and PUTs { notes }', async () => {
    const position = makePosition({
      assetType: 'option',
      status: 'open',
      symbol: 'NVDA260321C120',
      notes: 'pos',
    });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    // Neither the structured fields nor the inline raw Symbol field render.
    expect(screen.queryByLabelText('Underlying')).toBeNull();
    expect(screen.queryByLabelText('Strike')).toBeNull();
    expect(screen.queryByLabelText('Symbol')).toBeNull();

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'edited' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      notes: 'edited',
      targetPrice: null,
      stopLoss: null,
    });
  });

  it('renders target price + stop loss inputs on a closed position (all statuses)', () => {
    const position = makePosition({ status: 'closed', assetType: 'stock', symbol: 'AAPL' });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    expect(screen.getByLabelText('Target Price')).not.toBeNull();
    expect(screen.getByLabelText('Stop Loss')).not.toBeNull();
  });

  it('prefills target price + stop loss from the position and submits them as strings', async () => {
    const position = makePosition({ targetPrice: 150.5, stopLoss: 148, notes: 'plan' });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    // Prefilled from the numeric detail values.
    expect((screen.getByLabelText('Target Price') as HTMLInputElement).value).toBe('150.5');
    expect((screen.getByLabelText('Stop Loss') as HTMLInputElement).value).toBe('148');

    fireEvent.change(screen.getByLabelText('Target Price'), { target: { value: '160' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      notes: 'plan',
      targetPrice: '160',
      stopLoss: '148',
    });
  });

  it('clearing a plan field submits null so the server unsets it', async () => {
    const position = makePosition({ targetPrice: 150, stopLoss: 145, notes: 'plan' });
    render(<PositionEditDialog open onOpenChange={vi.fn()} position={position} />);

    fireEvent.change(screen.getByLabelText('Target Price'), { target: { value: '' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      notes: 'plan',
      targetPrice: null,
      stopLoss: '145',
    });
  });
});
